/**
 * PiRunner — In-process pi-agent-core `Agent` wrapper for the agent worker DO.
 *
 * The worker DO instantiates one PiRunner per chat lifetime, runs an Agent
 * in-process, and forwards Agent events to the channel as ephemeral
 * messages (state snapshots + text deltas).
 *
 * Wave-2 rewrite: this no longer depends on `pi-coding-agent`. It composes
 * `Agent` from `@earendil-works/pi-agent-core` directly with:
 *   - NatStack's local extension runtime (`PiExtensionRuntime`) hosting the
 *     three closure-bound factories: approval-gate, channel-tools, ask-user.
 *   - The six workerd-clean built-in file tools from `./tools/`, each wrapped
 *     by `wrapToolWithApproval` so the approval-gate can short-circuit them.
 *   - Workspace resources (`AGENTS.md` + skill index) loaded over RPC and
 *     concatenated into the system prompt.
 *   - A caller-supplied `getApiKey` hook that returns a capability token, so
 *     raw API keys never enter the worker runtime.
 *
 * No bash, no auto-compaction, no auto-retry, no file-based session JSONL.
 */
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolResult, } from "@earendil-works/pi-agent-core";
import { getModel as piGetModel, type ImageContent } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import type { RuntimeFs } from "./tools/runtime-fs.js";
import { type RpcCaller, loadNatStackResources } from "./resource-loader.js";
import { composeSystemPrompt, type SystemPromptMode } from "./system-prompt.js";
import { PiExtensionRuntime } from "./pi-extension-runtime.js";
import { createReadTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, resolveReadPath, resolveToCwd, } from "./tools/index.js";
import { createApprovalGateExtension, DEFAULT_SAFE_TOOL_NAMES, type ApprovalLevel, } from "./extensions/approval-gate.js";
import { createChannelToolsExtension, type ChannelToolMethod, type StreamUpdateCallback, } from "./extensions/channel-tools.js";
import { createAskUserExtension, type AskUserParams, } from "./extensions/ask-user.js";
import { createWebToolsExtension } from "./extensions/web/index.js";
import type { CredentialPresenceProbe } from "./extensions/web/provider.js";
import { DispatchedError, type NatStackScopedUiContext, } from "./natstack-extension-context.js";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
/** Built-in file tool names that are always active alongside roster tools. */
const BUILTIN_TOOL_NAMES = [
    "read", "edit", "write", "grep", "find", "ls",
    "web_search", "web_fetch", "web_read",
] as const;
export interface PiRunnerGadProvenance {
    sessionId: string;
    channelId?: string | null;
    contextId?: string | null;
    branchId?: string | null;
    projectPath?: string | null;
    source?: string;
    metadata?: Record<string, unknown>;
}
interface GadBlobSnapshot {
    path: string;
    digest: string;
    size: number;
    text: string | null;
}
export interface PiRunnerOptions {
    /** RPC caller — used for workspace loading and credential readiness checks. */
    rpc: RpcCaller;
    /** Per-context filesystem the file tools operate against. */
    fs: RuntimeFs;
    /** Bridge that turns extension UI primitive calls into channel events. */
    uiCallbacks: NatStackScopedUiContext;
    /** Returns the current channel roster's tool list. Lazily read on every reconcile. */
    rosterCallback: () => ChannelToolMethod[];
    /** Execute a method on a channel participant, resolved by handle. */
    callMethodCallback: (toolCallId: string, participantHandle: string, method: string, args: unknown, signal: AbortSignal | undefined, onStreamUpdate?: StreamUpdateCallback) => Promise<AgentToolResult<any>>;
    /** Bridge for the ask_user extension. */
    askUserCallback: (toolCallId: string, params: AskUserParams, signal: AbortSignal | undefined) => Promise<AgentToolResult<any> | string>;
    /** "provider:model" string (e.g. "openai-codex:gpt-5"). */
    model: string;
    /** Zero-arg callback returning the Bearer string the Agent should use. */
    getApiKey: () => Promise<string>;
    /** Default thinking level for new sessions. */
    thinkingLevel?: ThinkingLevel;
    /** Optional channel- or caller-provided system prompt layer. */
    systemPrompt?: string;
    /** Controls how systemPrompt composes with NatStack and workspace prompts. */
    systemPromptMode?: SystemPromptMode;
    /**
     * Initial approval level. The worker can mutate `runner.approvalLevel`
     * at any time and the approval-gate extension will read the new value
     * on the next tool_call.
     */
    approvalLevel: ApprovalLevel;
    /** Pre-existing message history for warm restore from SQL. */
    initialMessages?: AgentMessage[];
    /** Called whenever a message_end / agent_end fires so the worker can persist. */
    onPersist?: (messages: AgentMessage[]) => Promise<void> | void;
    /** Working directory passed to file tools and the extension runtime. */
    cwd?: string;
    /** Enables gad persistence for Pi sessions, turns, reads, and mutations. */
    gad?: PiRunnerGadProvenance;
    /**
     * Optional probe asking whether the credentials runtime holds a credential
     * whose audience matches a given provider origin. Used to auto-upgrade
     * web search from DuckDuckGo to a paid provider when the user has
     * registered one through the credentials system. The harness never sees
     * the credential value — auth is injected by the host's fetcher.
     */
    hasCredentialForOrigin?: CredentialPresenceProbe;
    /**
     * Optional global-fetch override. In production the host wires a
     * binary-safe credentialed fetcher that routes through the credentials
     * runtime: auth is auto-attached by URL-audience matching, every call
     * is audited, and PDFs/images round-trip as bytes. The harness never
     * sees credential values.
     */
    fetcher?: typeof fetch;
}
/** Snapshot of Agent state surfaced via the snapshot ephemeral channel stream. */
export interface PiStateSnapshot {
    messages: AgentMessage[];
    isStreaming: boolean;
}
export class PiRunner {
    private agent: Agent | null = null;
    private extensionRuntime: PiExtensionRuntime | null = null;
    private builtinTools: AgentTool<any>[] = [];
    private listeners: Array<(event: AgentEvent) => void> = [];
    private agentUnsub: (() => void) | null = null;
    private _approvalLevel: ApprovalLevel;
    private readonly preApprovedCallIds = new Set<string>();
    private recordedMessageCount = 0;
    private lastGadTurnId: number | null = null;
    private activeAssistantGadTurnId: number | null = null;
    constructor(private readonly options: PiRunnerOptions) {
        this._approvalLevel = options.approvalLevel;
    }
    /**
     * Initialize the runner end-to-end:
     *   1. Load workspace resources (AGENTS.md + skill index) via RPC.
     *   2. Build the inline extension runtime, bind UI bridge, load factories.
     *   3. Build the workerd-clean file tools, each wrapped with approval-gate.
     *   4. Resolve the model (`provider:model`) via `pi-ai.getModel`.
     *   5. Construct the Agent with a `getApiKey` callback that only verifies
     *      provider readiness. The proxy injects the actual auth at request time.
     *   6. Subscribe to Agent events.
     *   7. Fire `session_start` so channel-tools can reconcile its initial roster
     *      and assign the active set to `agent.state.tools`.
     */
    async init(): Promise<void> {
        const cwd = this.options.cwd ?? "/";
        // 1. Workspace resources (AGENTS.md + skill index).
        const resources = await loadNatStackResources({ rpc: this.options.rpc });
        // 2. Extension runtime + UI bridge + factories.
        this.extensionRuntime = new PiExtensionRuntime(cwd);
        this.extensionRuntime.bindUI(this.options.uiCallbacks);
        await this.extensionRuntime.loadFactories([
            createApprovalGateExtension({
                getApprovalLevel: () => this._approvalLevel,
                safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
                preApprovedCallIds: this.preApprovedCallIds,
            }),
            createChannelToolsExtension({
                getRoster: this.options.rosterCallback,
                callMethod: this.options.callMethodCallback,
                builtinToolNames: [...BUILTIN_TOOL_NAMES],
            }),
            createAskUserExtension({
                askUser: this.options.askUserCallback,
            }),
            createWebToolsExtension({
                rpc: this.options.rpc,
                hasCredentialForOrigin: this.options.hasCredentialForOrigin,
                fetcher: this.options.fetcher,
            }),
        ]);
        // 3. Built-in file tools, wrapped with approval-gate and gad dispatch.
        //    The read tool gets the RPC caller for image resize support.
        this.builtinTools = [
            createReadTool(cwd, this.options.fs, { rpc: this.options.rpc }),
            createEditTool(cwd, this.options.fs),
            createWriteTool(cwd, this.options.fs),
            createGrepTool(cwd, this.options.fs),
            createFindTool(cwd, this.options.fs),
            createLsTool(cwd, this.options.fs),
        ].map((t) => this.wrapBuiltinTool(t as AgentTool<any>));
        // 4. Resolve the model via pi-ai.
        const colonIdx = this.options.model.indexOf(":");
        if (colonIdx < 0) {
            throw new Error(`PiRunner: model must be "provider:model", got: ${this.options.model}`);
        }
        const provider = this.options.model.slice(0, colonIdx);
        const modelId = this.options.model.slice(colonIdx + 1);
        const model = piGetModel(provider as never, modelId as never);
        if (!model) {
            throw new Error(`PiRunner: unknown model: ${this.options.model}`);
        }
        this.agent = new Agent({
            // pi-agent-core 0.66+: initialState only accepts the user-controllable
            // fields. Runtime state (`isStreaming`, `streamingMessage`,
            // `pendingToolCalls`, `errorMessage`) is owned by the Agent and Omit'd
            // from the Partial.
            initialState: {
                systemPrompt: composeSystemPrompt({
                    workspacePrompt: resources.systemPrompt,
                    skillIndex: resources.skillIndex,
                    systemPrompt: this.options.systemPrompt,
                    systemPromptMode: this.options.systemPromptMode,
                }),
                model,
                thinkingLevel: this.options.thinkingLevel ?? "medium",
                tools: [],
                messages: this.options.initialMessages ?? [],
            },
            getApiKey: this.options.getApiKey,
        });
        this.recordedMessageCount = this.options.initialMessages?.length ?? 0;
        this.lastGadTurnId = null;
        this.activeAssistantGadTurnId = null;
        await this.recordGadSession();
        // 6. Forward Agent events into our handler.
        this.agentUnsub = this.agent.subscribe((event, _signal) => this.handleAgentEvent(event));
        // 7. Fire session_start so channel-tools reconciles initial roster
        //    and we then push the active tool set onto the agent.
        await this.extensionRuntime.dispatch("session_start", {
            type: "session_start",
        });
        this.refreshActiveTools();
    }
    /**
     * Wrap a tool's `execute()` to consult the extension runtime's `tool_call`
     * handlers first. If a handler returns `{ block: true }`, throw — the
     * pi-agent-core agent loop catches the throw and converts it into a
     * `ToolResultMessage` with `isError: true` that flows back to the LLM.
     */
    private wrapBuiltinTool(tool: AgentTool<any>): AgentTool<any> {
        const runner = this;
        const wrapped: AgentTool<any> = {
            ...tool,
            execute: async (toolCallId, params, signal, onUpdate) => {
                let result;
                try {
                    result = await runner.extensionRuntime!.dispatch("tool_call", {
                        type: "tool_call",
                        toolCallId,
                        toolName: tool.name,
                        input: params,
                    });
                }
                catch (err) {
                    if (err instanceof DispatchedError)
                        return err.placeholderResult;
                    throw err;
                }
                if (result?.block) {
                    throw new Error(result.reason ?? `Tool "${tool.name}" blocked`);
                }
                const gadToolCallId = await runner.beginGadToolCall(tool.name, params);
                const before = await runner.snapshotMutationTarget(tool.name, params);
                try {
                    const toolResult = await tool.execute(toolCallId, params, signal, onUpdate);
                    await runner.recordGadToolEffect(gadToolCallId, tool.name, params, before, toolResult);
                    await runner.completeGadToolCall(gadToolCallId, runner.summarizeToolResult(toolResult));
                    return toolResult;
                }
                catch (err) {
                    await runner.completeGadToolCall(gadToolCallId, `error: ${err instanceof Error ? err.message : String(err)}`);
                    throw err;
                }
            },
        };
        return wrapped;
    }
    private get gad() {
        return this.options.gad;
    }
    private async recordGadSession(): Promise<void> {
        const gad = this.gad;
        if (!gad)
            return;
        try {
            await this.options.rpc.call("main", "gad.recordSession", [{
                    id: gad.sessionId,
                    source: gad.source ?? "pi-harness",
                    projectPath: gad.projectPath ?? this.options.cwd ?? null,
                    branchId: gad.branchId ?? null,
                    channelId: gad.channelId ?? null,
                    contextId: gad.contextId ?? null,
                    metadata: {
                        ...(gad.metadata ?? {}),
                        model: this.options.model,
                        thinkingLevel: this.options.thinkingLevel ?? "medium",
                    },
                }]);
        }
        catch (err) {
            console.warn("[PiRunner] gad.recordSession failed:", err);
        }
    }
    private async recordNewGadMessages(): Promise<void> {
        const gad = this.gad;
        if (!gad || !this.agent)
            return;
        const messages = this.agent.state.messages as AgentMessage[];
        for (let i = this.recordedMessageCount; i < messages.length; i++) {
            const message = messages[i]!;
            try {
                const result = await this.options.rpc.call<{
                    id: number;
                    turnIndex: number;
                }>("main", "gad.recordTurn", [{
                        sessionId: gad.sessionId,
                        role: this.messageRole(message),
                        content: this.messageContentText(message),
                        contentFormat: "text",
                        messageIndex: i,
                        channelId: gad.channelId ?? null,
                        timestamp: this.messageTimestampIso(message),
                    }]);
                this.lastGadTurnId = result.id;
                await this.indexGadTurn(result.id);
            }
            catch (err) {
                console.warn("[PiRunner] gad.recordTurn failed:", err);
            }
            this.recordedMessageCount = i + 1;
        }
    }
    private async beginGadToolCall(toolName: string, params: unknown): Promise<number | null> {
        const gad = this.gad;
        if (!gad)
            return null;
        await this.recordNewGadMessages();
        const turnId = await this.ensureActiveAssistantTurn(toolName);
        try {
            const result = await this.options.rpc.call<{
                id: number;
            }>("main", "gad.beginToolCall", [{
                    sessionId: gad.sessionId,
                    turnId,
                    toolName,
                    parameters: this.asJsonRecord(params),
                    isMutation: toolName === "edit" || toolName === "write",
                    branchId: gad.branchId ?? null,
                    channelId: gad.channelId ?? null,
                    contextId: gad.contextId ?? null,
                }]);
            return result.id;
        }
        catch (err) {
            console.warn("[PiRunner] gad.beginToolCall failed:", err);
            return null;
        }
    }
    private async ensureActiveAssistantTurn(toolName: string): Promise<number | null> {
        if (this.activeAssistantGadTurnId != null)
            return this.activeAssistantGadTurnId;
        const gad = this.gad;
        if (!gad)
            return this.lastGadTurnId;
        try {
            const result = await this.options.rpc.call<{
                id: number;
                turnIndex: number;
            }>("main", "gad.recordTurn", [{
                    sessionId: gad.sessionId,
                    role: "assistant",
                    content: `[tool call: ${toolName}]`,
                    contentFormat: "tool-call-placeholder",
                    channelId: gad.channelId ?? null,
                    timestamp: new Date().toISOString(),
                }]);
            this.activeAssistantGadTurnId = result.id;
            this.lastGadTurnId = result.id;
            return result.id;
        }
        catch (err) {
            console.warn("[PiRunner] gad.recordTurn placeholder failed:", err);
            return this.lastGadTurnId;
        }
    }
    private async completeGadToolCall(toolCallId: number | null, summary: string | null): Promise<void> {
        if (toolCallId == null)
            return;
        try {
            await this.options.rpc.call("main", "gad.completeToolCall", [toolCallId, summary]);
        }
        catch (err) {
            console.warn("[PiRunner] gad.completeToolCall failed:", err);
        }
    }
    private async indexGadTurn(turnId: number): Promise<void> {
        try {
            await this.options.rpc.call("main", "gad.indexTurn", [turnId]);
        }
        catch (err) {
            console.warn("[PiRunner] gad.indexTurn failed:", err);
        }
    }
    private async recordGadToolEffect(toolCallId: number | null, toolName: string, params: unknown, before: GadBlobSnapshot | null, result: AgentToolResult<any>): Promise<void> {
        if (toolCallId == null)
            return;
        if (toolName === "edit" || toolName === "write") {
            await this.recordGadMutation(toolCallId, toolName, params, before);
            return;
        }
        await this.recordGadRead(toolCallId, toolName, params, result);
    }
    private async recordGadRead(toolCallId: number, toolName: string, params: unknown, result: AgentToolResult<any>): Promise<void> {
        const text = this.toolResultText(result);
        const blob = await this.putGadBlob(text);
        if (!blob)
            return;
        const path = this.toolInputPath(toolName, params);
        try {
            await this.options.rpc.call("main", "gad.recordRead", [{
                    toolCallId,
                    readType: toolName === "read" ? "file" : toolName,
                    filePath: path,
                    contentHash: blob.digest,
                    contentSize: blob.size,
                    metadata: {
                        toolName,
                        parameters: this.asJsonRecord(params),
                        details: result.details ?? null,
                    },
                }]);
        }
        catch (err) {
            console.warn("[PiRunner] gad.recordRead failed:", err);
        }
    }
    private async recordGadMutation(toolCallId: number, toolName: string, params: unknown, before: GadBlobSnapshot | null): Promise<void> {
        const after = await this.snapshotMutationTarget(toolName, params);
        const filePath = before?.path ?? after?.path ?? this.toolInputPath(toolName, params);
        if (!filePath)
            return;
        try {
            await this.options.rpc.call("main", "gad.recordMutation", [{
                    toolCallId,
                    filePath,
                    beforeHash: before?.digest ?? null,
                    beforeSize: before?.size ?? null,
                    afterHash: after?.digest ?? null,
                    afterSize: after?.size ?? null,
                    mutationType: before?.digest ? "modify" : "create",
                    oldString: this.stringParam(params, "oldText"),
                    newString: this.stringParam(params, toolName === "write" ? "content" : "newText"),
                    description: `${toolName} ${filePath}`,
                    branchId: this.gad?.branchId ?? null,
                }]);
            if (after?.text != null && after.digest) {
                await this.options.rpc.call("main", "gad.indexFileVersion", [{
                        path: filePath,
                        contentHash: after.digest,
                        content: after.text,
                    }]);
            }
        }
        catch (err) {
            console.warn("[PiRunner] gad.recordMutation failed:", err);
        }
    }
    private async snapshotMutationTarget(toolName: string, params: unknown): Promise<GadBlobSnapshot | null> {
        if (toolName !== "edit" && toolName !== "write")
            return null;
        const filePath = this.toolInputPath(toolName, params);
        if (!filePath)
            return null;
        try {
            const raw = await this.options.fs.readFile(filePath);
            const blob = await this.putGadBlob(raw);
            return blob ? { path: filePath, ...blob, text: this.snapshotText(raw) } : null;
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT")
                return null;
            return null;
        }
    }
    private snapshotText(raw: string | Buffer): string | null {
        if (typeof raw === "string")
            return raw;
        if (raw.includes(0))
            return null;
        return raw.toString("utf8");
    }
    private async putGadBlob(value: string | Uint8Array): Promise<{
        digest: string;
        size: number;
    } | null> {
        try {
            if (typeof value === "string") {
                return await this.options.rpc.call("main", "blobstore.putText", [value]);
            }
            return await this.options.rpc.call("main", "blobstore.putBase64", [Buffer.from(value).toString("base64")]);
        }
        catch (err) {
            console.warn("[PiRunner] blobstore put failed:", err);
            return null;
        }
    }
    private toolInputPath(toolName: string, params: unknown): string | null {
        const rawPath = this.stringParam(params, "path");
        const cwd = this.options.cwd ?? "/";
        if (toolName === "read" && rawPath)
            return resolveReadPath(rawPath, cwd);
        if ((toolName === "edit" || toolName === "write" || toolName === "grep" || toolName === "find" || toolName === "ls") && rawPath) {
            return resolveToCwd(rawPath, cwd);
        }
        if (toolName === "grep" || toolName === "find" || toolName === "ls")
            return resolveToCwd(".", cwd);
        return null;
    }
    private summarizeToolResult(result: AgentToolResult<any>): string {
        const text = this.toolResultText(result).replace(/\s+/gu, " ").trim();
        return text.length > 240 ? `${text.slice(0, 237)}...` : text;
    }
    private toolResultText(result: AgentToolResult<any>): string {
        const content = (result as {
            content?: unknown;
        }).content;
        if (!Array.isArray(content))
            return "";
        return content.map((block) => {
            if (!block || typeof block !== "object")
                return String(block);
            const item = block as {
                type?: string;
                text?: string;
                mimeType?: string;
            };
            if (item.type === "text")
                return item.text ?? "";
            if (item.type === "image")
                return `[image ${item.mimeType ?? "unknown"}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join("\n");
    }
    private messageRole(message: AgentMessage | undefined): string {
        if (!message)
            return "unknown";
        return (message as {
            role?: string;
        }).role ?? "unknown";
    }
    private messageTimestampIso(message: AgentMessage): string | null {
        const timestamp = (message as {
            timestamp?: unknown;
        }).timestamp;
        if (typeof timestamp !== "number")
            return null;
        return new Date(timestamp).toISOString();
    }
    private messageContentText(message: AgentMessage): string {
        const content = (message as {
            content?: unknown;
        }).content;
        if (typeof content === "string")
            return content;
        if (!Array.isArray(content))
            return JSON.stringify(content ?? "");
        return content.map((block) => {
            if (!block || typeof block !== "object")
                return String(block);
            const item = block as {
                type?: string;
                text?: string;
                thinking?: string;
                mimeType?: string;
            };
            if (item.type === "text")
                return item.text ?? "";
            if (item.type === "thinking")
                return item.thinking ?? "";
            if (item.type === "image")
                return `[image ${item.mimeType ?? "unknown"}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join("\n");
    }
    private stringParam(params: unknown, key: string): string | null {
        if (!params || typeof params !== "object")
            return null;
        const value = (params as Record<string, unknown>)[key];
        return typeof value === "string" ? value : null;
    }
    private asJsonRecord(value: unknown): Record<string, unknown> | null {
        return value && typeof value === "object" && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>) }
            : null;
    }
    /**
     * Compute the active tool set the agent should see for the next turn:
     * builtin tools + any extension tools the channel-tools extension has
     * marked active in its current roster reconcile.
     */
    private computeActiveTools(): AgentTool<any>[] {
        return this.extensionRuntime!.getActiveTools(this.builtinTools);
    }
    /** Push the current active set onto the agent. Cheap; called between turns. */
    private refreshActiveTools(): void {
        if (!this.agent)
            return;
        // pi-agent-core 0.66+: assign to state.tools (the setter copies the array).
        this.agent.state.tools = this.computeActiveTools();
    }
    /**
     * Pi-agent-core event handler. We:
     *   - Reconcile channel-tools at every `turn_start` (so mid-session roster
     *     changes are visible on the next LLM call).
     *   - Persist messages on `message_end` and `agent_end`.
     *   - Forward all events to user-supplied subscribers.
     */
    private async handleAgentEvent(event: AgentEvent): Promise<void> {
        if (event.type === "message_start" && this.messageRole((event as {
            message?: AgentMessage;
        }).message as AgentMessage) === "assistant") {
            this.activeAssistantGadTurnId = null;
        }
        if (event.type === "turn_start") {
            try {
                await this.extensionRuntime!.dispatch("turn_start", event);
            }
            catch (err) {
                console.error("[PiRunner] turn_start dispatch threw:", err);
            }
            this.refreshActiveTools();
        }
        if (event.type === "message_end" || event.type === "agent_end") {
            await this.recordNewGadMessages();
            if (event.type === "message_end")
                this.activeAssistantGadTurnId = null;
            try {
                await this.options.onPersist?.([...this.agent!.state.messages]);
            }
            catch (err) {
                console.error("[PiRunner] onPersist threw:", err);
            }
        }
        for (const listener of this.listeners) {
            try {
                listener(event);
            }
            catch (err) {
                console.error("[PiRunner] listener threw:", err);
            }
        }
    }
    /** Subscribe to Agent events. Returns an unsubscribe function. */
    subscribe(listener: (event: AgentEvent) => void): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }
    /**
     * Send a user message to start (or continue) a turn. When `images` are
     * present we build a multi-content user message; otherwise we pass the
     * string straight through to `agent.prompt(string)`.
     */
    async runTurn(content: string, images?: ImageContent[]): Promise<void> {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        if (images && images.length > 0) {
            const message: AgentMessage = {
                role: "user",
                content: [{ type: "text", text: content }, ...images],
                timestamp: Date.now(),
            };
            await this.agent.prompt(message);
        }
        else {
            await this.agent.prompt(content);
        }
    }
    /**
     * Build a user AgentMessage without submitting it. The caller holds the
     * reference so it can be passed to `steerMessage` or `runTurnMessage` and
     * later matched against `message_start` events for absorption tracking.
     */
    buildUserMessage(content: string, images?: ImageContent[]): AgentMessage {
        return {
            role: "user",
            content: images && images.length > 0
                ? [{ type: "text", text: content }, ...images]
                : content,
            timestamp: Date.now(),
        };
    }
    /** Queue a prebuilt AgentMessage for mid-stream steering. The caller should
     *  hold `msg` by reference so it can match against later `message_start`
     *  events to detect absorption. */
    steerMessage(msg: AgentMessage): void {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        this.agent.steer(msg);
    }
    /** Submit a prebuilt AgentMessage as a fresh turn. Requires the agent to
     *  be idle; throws if a run is already active. */
    async runTurnMessage(msg: AgentMessage): Promise<void> {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        await this.agent.prompt(msg);
    }
    /** Clear pi-agent-core's internal steering queue. Used by the worker's
     *  self-healing sweep when re-routing stranded steered messages as fresh
     *  turns, so they don't get double-ingested by the next loop's line-80
     *  drain. Safe to call when the agent is idle. */
    clearSteeringQueue(): void {
        this.agent?.clearSteeringQueue();
    }
    abortAgent(): void {
        this.agent?.abort();
    }
    async continueAgent(): Promise<void> {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        this.agent.state.messages = this.trimTrailingAbortedAssistant(this.agent.state.messages);
        await this.agent.continue();
    }
    replaceHistory(messages: AgentMessage[]): void {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        this.agent.state.messages = messages;
    }
    markToolCallPreApproved(toolCallId: string): void {
        this.preApprovedCallIds.add(toolCallId);
    }
    async executeToolDirect(toolName: string, toolCallId: string, params: unknown): Promise<AgentToolResult<any>> {
        this.markToolCallPreApproved(toolCallId);
        const tool = this.computeActiveTools().find((candidate) => candidate.name === toolName);
        if (!tool) {
            return {
                content: [{ type: "text", text: `Tool "${toolName}" not available at resume time` }],
                details: { __natstack_tool_missing: true },
            };
        }
        return tool.execute(toolCallId, params as never, new AbortController().signal, undefined);
    }
    trimTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
        if (messages.length === 0)
            return messages;
        const last = messages[messages.length - 1] as {
            role?: string;
            stopReason?: string;
            content?: unknown;
        } | undefined;
        if (!last || last.role !== "assistant" || last.stopReason !== "aborted") {
            return messages;
        }
        const content = Array.isArray(last.content) ? last.content : [];
        const hasVisibleContent = content.some((block) => {
            if (!block || typeof block !== "object")
                return true;
            if ((block as {
                type?: string;
            }).type === "text") {
                return Boolean((block as {
                    text?: string;
                }).text);
            }
            if ((block as {
                type?: string;
            }).type === "thinking") {
                return Boolean((block as {
                    thinking?: string;
                }).thinking);
            }
            return true;
        });
        return hasVisibleContent ? messages : messages.slice(0, -1);
    }
    /** Abort the current operation and wait for the loop to drain. */
    async interrupt(): Promise<void> {
        this.agent?.abort();
        await this.agent?.waitForIdle();
    }
    /**
     * Fork at a given message index by truncating the message array and
     * assigning back to `agent.state.messages` (the setter copies the array).
     * pi-agent-core has no fork primitive, so the worker is responsible for
     * any persistence/branching it wants; this method only mutates in-memory
     * state and returns the new history.
     */
    async forkAtMessage(messageIndex: number): Promise<AgentMessage[]> {
        if (!this.agent)
            throw new Error("PiRunner not initialized");
        const truncated = this.agent.state.messages.slice(0, messageIndex);
        // pi-agent-core 0.66+: assign to state.messages (the setter copies the array).
        this.agent.state.messages = truncated;
        return truncated;
    }
    /** Snapshot of the agent state for the snapshot ephemeral channel stream. */
    getStateSnapshot(): PiStateSnapshot {
        if (!this.agent) {
            return { messages: [], isStreaming: false };
        }
        return {
            messages: [...this.agent.state.messages],
            isStreaming: this.agent.state.isStreaming,
        };
    }
    /**
     * Update the approval level. The approval-gate extension reads this lazily
     * via closure, so changes are visible on the next tool_call without a
     * runtime reload.
     */
    setApprovalLevel(level: ApprovalLevel): void {
        this._approvalLevel = level;
    }
    get approvalLevel(): ApprovalLevel {
        return this._approvalLevel;
    }
    /** Whether the underlying agent is currently streaming a response. */
    get isStreaming(): boolean {
        return this.agent?.state.isStreaming ?? false;
    }
    /** Tear down the runner. Idempotent. */
    dispose(): void {
        this.agent?.abort();
        this.agentUnsub?.();
        this.agentUnsub = null;
        this.agent = null;
        this.extensionRuntime = null;
        this.listeners.length = 0;
    }
}
