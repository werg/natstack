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

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { getModel as piGetModel, type ImageContent } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import { isAbsolute, relative as relativePath } from "node:path";

import type { RuntimeFs } from "./tools/runtime-fs.js";
import { type RpcCaller, loadNatStackResources } from "./resource-loader.js";
import { composeSystemPrompt, type SystemPromptMode } from "./system-prompt.js";

import { PiExtensionRuntime } from "./pi-extension-runtime.js";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  resolveReadPath,
  resolveToCwd,
} from "./tools/index.js";
import {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
} from "./extensions/approval-gate.js";
import {
  createChannelToolsExtension,
  type ChannelToolMethod,
  type StreamUpdateCallback,
} from "./extensions/channel-tools.js";
import {
  createAskUserExtension,
  type AskUserParams,
} from "./extensions/ask-user.js";
import {
  DispatchedError,
  type NatStackScopedUiContext,
} from "./natstack-extension-context.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Built-in file tool names that are always active alongside roster tools. */
const BUILTIN_TOOL_NAMES = ["read", "edit", "write", "grep", "find", "ls"] as const;

export interface PiRunnerGadProvenance {
  branchId: string;
  workspaceId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
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
  callMethodCallback: (
    toolCallId: string,
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onStreamUpdate?: StreamUpdateCallback,
  ) => Promise<AgentToolResult<any>>;
  /** Bridge for the ask_user extension. */
  askUserCallback: (
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ) => Promise<AgentToolResult<any> | string>;
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
  /** Pre-existing messages materialized from gad for runner startup. */
  initialMessages?: AgentMessage[];
  /** Called after the gad trajectory advances so the worker can drain execution-local state. */
  onTrajectoryAdvanced?: () => Promise<void> | void;
  /** Working directory passed to file tools and the extension runtime. */
  cwd?: string;
  /** Enables immutable gad trajectory/provenance for Pi sessions. */
  gad?: PiRunnerGadProvenance;
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
  private gadHeadHash: string | null = null;
  private gadStateHash: string | null = null;
  private gadBranchId: string | null = null;

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
      throw new Error(
        `PiRunner: model must be "provider:model", got: ${this.options.model}`,
      );
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
    await this.recordGadBranch();

    // 6. Forward Agent events into our handler.
    this.agentUnsub = this.agent.subscribe((event, _signal) =>
      this.handleAgentEvent(event),
    );

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
        } catch (err) {
          if (err instanceof DispatchedError) return err.placeholderResult;
          throw err;
        }
        if (result?.block) {
          throw new Error(result.reason ?? `Tool "${tool.name}" blocked`);
        }
        const before = await runner.snapshotMutationTarget(tool.name, params);
        try {
          const toolResult = await tool.execute(toolCallId, params, signal, onUpdate);
          await runner.recordGadToolEffect(toolCallId, tool.name, params, before, toolResult);
          return toolResult;
        } catch (err) {
          await runner.appendGadItems([{
            kind: "tool_result_observed",
            actor: "tool",
            toolCallId,
            payload: {
              toolName: tool.name,
              isError: true,
              summary: err instanceof Error ? err.message : String(err),
              timestamp: Date.now(),
            },
          }]);
          throw err;
        }
      },
    };
    return wrapped;
  }

  private get gad() {
    return this.options.gad;
  }

  private async recordGadBranch(): Promise<void> {
    const gad = this.gad;
    if (!gad) return;
    try {
      const head = await this.options.rpc.call<{
        branchId: string;
        headTrajectoryHash: string | null;
        headStateHash: string;
      }>("main", "gad.ensureGadBranch", {
        workspaceId: gad.workspaceId ?? null,
        branchId: gad.branchId,
        channelId: gad.channelId ?? null,
        contextId: gad.contextId ?? null,
        metadata: {
          ...(gad.metadata ?? {}),
          model: this.options.model,
          thinkingLevel: this.options.thinkingLevel ?? "medium",
        },
      });
      this.gadBranchId = head.branchId;
      this.gadHeadHash = head.headTrajectoryHash;
      this.gadStateHash = head.headStateHash;
    } catch (err) {
      console.warn("[PiRunner] gad.ensureGadBranch failed:", err);
    }
  }

  private async recordNewGadMessages(): Promise<void> {
    const gad = this.gad;
    if (!gad || !this.agent) return;
    const messages = this.agent.state.messages as AgentMessage[];
    const items: Array<{
      kind: string;
      actor?: string | null;
      payload?: Record<string, unknown> | string | null;
      messageId?: string | null;
      blockId?: string | null;
      toolCallId?: string | null;
      metadata?: Record<string, unknown> | null;
    }> = [];
    for (let i = this.recordedMessageCount; i < messages.length; i++) {
      const message = messages[i]!;
      const messageId = this.messageIdFor(i, message);
      items.push({
        kind: "message_created",
        actor: this.messageRole(message),
        messageId,
        payload: {
          role: this.messageRole(message),
          timestamp: (message as { timestamp?: unknown }).timestamp ?? Date.now(),
          messageIndex: i,
        },
      });
      for (const [blockIndex, block] of this.messageBlocks(message).entries()) {
        const blockId = `${messageId}:block:${blockIndex}`;
        items.push({
          kind: "message_block_added",
          actor: this.messageRole(message),
          messageId,
          blockId,
          toolCallId: this.toolCallIdFromBlock(block),
          payload: {
            block,
            blockIndex,
          },
        });
        const toolCallId = this.toolCallIdFromBlock(block);
        if (toolCallId) {
          items.push({
            kind: "tool_call_requested",
            actor: "assistant",
            messageId,
            blockId,
            toolCallId,
            payload: {
              block,
              toolName: this.toolNameFromBlock(block),
              parameters: this.toolParamsFromBlock(block),
            },
          });
        }
      }
      items.push({
        kind: "message_finalized",
        actor: this.messageRole(message),
        messageId,
        payload: {
          stopReason: (message as { stopReason?: unknown }).stopReason ?? null,
          errorMessage: (message as { errorMessage?: unknown }).errorMessage ?? null,
        },
      });
      this.recordedMessageCount = i + 1;
    }
    if (items.length > 0) await this.appendGadItems(items);
  }

  private async appendGadItems(items: Array<{
    kind: string;
    actor?: string | null;
    payload?: Record<string, unknown> | string | null;
    messageId?: string | null;
    blockId?: string | null;
    toolCallId?: string | null;
    metadata?: Record<string, unknown> | null;
  }>): Promise<void> {
    const gad = this.gad;
    if (!gad || items.length === 0) return;
    try {
      const result = await this.options.rpc.call<{
        headTrajectoryHash: string | null;
        headStateHash: string;
        branchId: string;
      }>("main", "gad.appendGadTrajectoryBatch", {
        workspaceId: gad.workspaceId ?? null,
        branchId: this.gadBranchId ?? gad.branchId,
        expectedTrajectoryHash: this.gadHeadHash,
        expectedStateHash: this.gadStateHash,
        items,
      });
      this.gadHeadHash = result.headTrajectoryHash;
      this.gadStateHash = result.headStateHash;
      this.gadBranchId = result.branchId;
      await this.options.onTrajectoryAdvanced?.();
    } catch (err) {
      console.warn("[PiRunner] gad.appendGadTrajectoryBatch failed:", err);
    }
  }

  private async recordGadToolEffect(
    toolCallId: string,
    toolName: string,
    params: unknown,
    before: GadBlobSnapshot | null,
    result: AgentToolResult<any>,
  ): Promise<void> {
    if (!this.gad) return;
    if (toolName === "edit" || toolName === "write") {
      await this.recordGadMutation(toolCallId, toolName, params, before);
      return;
    }
    await this.recordGadRead(toolCallId, toolName, params, result);
  }

  private async recordGadRead(
    toolCallId: string,
    toolName: string,
    params: unknown,
    result: AgentToolResult<any>,
  ): Promise<void> {
    const text = this.toolResultText(result);
    const blob = await this.putGadBlob(text);
    if (!blob) return;
    const path = this.gadToolInputPath(toolName, params);
    const items: Array<{
      kind: string;
      actor?: string | null;
      payload?: Record<string, unknown> | string | null;
      messageId?: string | null;
      blockId?: string | null;
      toolCallId?: string | null;
      metadata?: Record<string, unknown> | null;
    }> = [];
    if (toolName === "read" && path) {
      items.push({
        kind: "file_observed",
        actor: "tool",
        toolCallId,
        payload: {
          path,
          contentHash: blob.digest,
          contentSize: blob.size,
          toolName,
          parameters: this.asJsonRecord(params),
        },
      });
    }
    items.push({
      kind: "file_read",
      actor: "tool",
      toolCallId,
      payload: {
        path,
        contentHash: blob.digest,
        contentSize: blob.size,
        readType: toolName === "read" ? "file" : toolName,
        summary: this.summarizeToolResult(result),
      },
      metadata: {
        toolName,
        parameters: this.asJsonRecord(params),
        details: result.details ?? null,
      },
    });
    try {
      await this.appendGadItems(items);
    } catch (err) {
      console.warn("[PiRunner] gad file_read failed:", err);
    }
  }

  private async recordGadMutation(
    toolCallId: string,
    toolName: string,
    params: unknown,
    before: GadBlobSnapshot | null,
  ): Promise<void> {
    const after = await this.snapshotMutationTarget(toolName, params);
    const filePath = this.gadPathFromAbsolute(before?.path ?? after?.path ?? this.toolInputPath(toolName, params));
    if (!filePath) return;
    try {
      await this.appendGadItems([{
        kind: "file_mutation",
        actor: "tool",
        toolCallId,
        payload: {
          operation: before?.digest ? "write" : "write",
          path: filePath,
          beforeHash: before?.digest ?? null,
          beforeSize: before?.size ?? null,
          afterHash: after?.digest ?? null,
          afterSize: after?.size ?? null,
          oldString: this.stringParam(params, "oldText"),
          newString: this.stringParam(params, toolName === "write" ? "content" : "newText"),
          beforeText: before?.text ?? null,
          afterText: after?.text ?? null,
          description: `${toolName} ${filePath}`,
        },
        metadata: { toolName },
      }]);
    } catch (err) {
      console.warn("[PiRunner] gad file_mutation failed:", err);
    }
  }

  private async snapshotMutationTarget(toolName: string, params: unknown): Promise<GadBlobSnapshot | null> {
    if (toolName !== "edit" && toolName !== "write") return null;
    const filePath = this.toolInputPath(toolName, params);
    if (!filePath) return null;
    try {
      const raw = await this.options.fs.readFile(filePath);
      const blob = await this.putGadBlob(raw);
      return blob ? { path: filePath, ...blob, text: this.snapshotText(raw) } : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private snapshotText(raw: string | Buffer): string | null {
    if (typeof raw === "string") return raw;
    if (raw.includes(0)) return null;
    return raw.toString("utf8");
  }

  private async putGadBlob(value: string | Uint8Array): Promise<{ digest: string; size: number } | null> {
    try {
      if (typeof value === "string") {
        return await this.options.rpc.call("main", "blobstore.putText", value);
      }
      return await this.options.rpc.call("main", "blobstore.putBase64", Buffer.from(value).toString("base64"));
    } catch (err) {
      console.warn("[PiRunner] blobstore put failed:", err);
      return null;
    }
  }

  private toolInputPath(toolName: string, params: unknown): string | null {
    const rawPath = this.stringParam(params, "path");
    const cwd = this.options.cwd ?? "/";
    if (toolName === "read" && rawPath) return resolveReadPath(rawPath, cwd);
    if ((toolName === "edit" || toolName === "write" || toolName === "grep" || toolName === "find" || toolName === "ls") && rawPath) {
      return resolveToCwd(rawPath, cwd);
    }
    if (toolName === "grep" || toolName === "find" || toolName === "ls") return resolveToCwd(".", cwd);
    return null;
  }

  private gadToolInputPath(toolName: string, params: unknown): string | null {
    return this.gadPathFromAbsolute(this.toolInputPath(toolName, params));
  }

  private gadPathFromAbsolute(filePath: string | null | undefined): string | null {
    if (!filePath) return null;
    const cwd = this.options.cwd ?? "/";
    const relative = isAbsolute(filePath) ? relativePath(cwd, filePath) : filePath;
    const normalized = relative.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
    if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
      return null;
    }
    return normalized;
  }

  private summarizeToolResult(result: AgentToolResult<any>): string {
    const text = this.toolResultText(result).replace(/\s+/gu, " ").trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }

  private toolResultText(result: AgentToolResult<any>): string {
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => {
      if (!block || typeof block !== "object") return String(block);
      const item = block as { type?: string; text?: string; mimeType?: string };
      if (item.type === "text") return item.text ?? "";
      if (item.type === "image") return `[image ${item.mimeType ?? "unknown"}]`;
      return JSON.stringify(item);
    }).filter(Boolean).join("\n");
  }

  private messageRole(message: AgentMessage | undefined): string {
    if (!message) return "unknown";
    return (message as { role?: string }).role ?? "unknown";
  }

  private messageBlocks(message: AgentMessage): unknown[] {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content;
    return [];
  }

  private messageIdFor(index: number, message: AgentMessage): string {
    const existing = (message as { id?: unknown; messageId?: unknown })["id"]
      ?? (message as { id?: unknown; messageId?: unknown })["messageId"];
    return typeof existing === "string" ? existing : `msg:${index}`;
  }

  private toolCallIdFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    return typeof item["id"] === "string"
      ? item["id"]
      : typeof item["toolCallId"] === "string"
        ? item["toolCallId"]
        : null;
  }

  private toolNameFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    return typeof item["name"] === "string"
      ? item["name"]
      : typeof item["toolName"] === "string"
        ? item["toolName"]
        : null;
  }

  private toolParamsFromBlock(block: unknown): Record<string, unknown> | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    const params = item["input"] ?? item["arguments"] ?? item["args"];
    return this.asJsonRecord(params);
  }

  private stringParam(params: unknown, key: string): string | null {
    if (!params || typeof params !== "object") return null;
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
    if (!this.agent) return;
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
    if (event.type === "turn_start") {
      try {
        await this.extensionRuntime!.dispatch("turn_start", event);
      } catch (err) {
        console.error("[PiRunner] turn_start dispatch threw:", err);
      }
      this.refreshActiveTools();
    }
    if (event.type === "message_end" || event.type === "agent_end") {
      await this.recordNewGadMessages();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
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
    if (!this.agent) throw new Error("PiRunner not initialized");
    if (images && images.length > 0) {
      const message: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: content }, ...images],
        timestamp: Date.now(),
      };
      await this.agent.prompt(message);
    } else {
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
      content:
        images && images.length > 0
          ? [{ type: "text", text: content }, ...images]
          : content,
      timestamp: Date.now(),
    };
  }

  /** Queue a prebuilt AgentMessage for mid-stream steering. The caller should
   *  hold `msg` by reference so it can match against later `message_start`
   *  events to detect absorption. */
  steerMessage(msg: AgentMessage): void {
    if (!this.agent) throw new Error("PiRunner not initialized");
    this.agent.steer(msg);
  }

  /** Submit a prebuilt AgentMessage as a fresh turn. Requires the agent to
   *  be idle; throws if a run is already active. */
  async runTurnMessage(msg: AgentMessage): Promise<void> {
    if (!this.agent) throw new Error("PiRunner not initialized");
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
    if (!this.agent) throw new Error("PiRunner not initialized");
    this.agent.state.messages = this.trimTrailingAbortedAssistant(this.agent.state.messages);
    await this.agent.continue();
  }

  replaceHistory(messages: AgentMessage[]): void {
    if (!this.agent) throw new Error("PiRunner not initialized");
    this.agent.state.messages = messages;
    this.recordedMessageCount = messages.length;
  }

  markToolCallPreApproved(toolCallId: string): void {
    this.preApprovedCallIds.add(toolCallId);
  }

  async executeToolDirect(
    toolName: string,
    toolCallId: string,
    params: unknown,
  ): Promise<AgentToolResult<any>> {
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
    if (messages.length === 0) return messages;
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
      if (!block || typeof block !== "object") return true;
      if ((block as { type?: string }).type === "text") {
        return Boolean((block as { text?: string }).text);
      }
      if ((block as { type?: string }).type === "thinking") {
        return Boolean((block as { thinking?: string }).thinking);
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
    if (!this.agent) throw new Error("PiRunner not initialized");
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
