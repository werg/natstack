/**
 * PiRunner — In-process pi-agent-core `Agent` wrapper for the agent worker DO.
 *
 * The worker DO instantiates one PiRunner per chat lifetime, runs an Agent
 * in-process, and forwards Agent events to the channel as ephemeral
 * messages (state snapshots + text deltas).
 *
 * Wave-2 rewrite: this no longer depends on `pi-coding-agent`. It composes
 * `Agent` from `@mariozechner/pi-agent-core` directly with:
 *   - NatStack's local extension runtime (`PiExtensionRuntime`) hosting the
 *     three closure-bound factories: approval-gate, channel-tools, ask-user.
 *   - The six workerd-clean built-in file tools from `./tools/`, each wrapped
 *     by `wrapToolWithApproval` so the approval-gate can short-circuit them.
 *   - Workspace resources (`AGENTS.md` + skill index) loaded over RPC and
 *     concatenated into the system prompt.
 *   - A `getApiKey` hook that only verifies provider readiness. Real auth is
 *     injected by the server-side egress proxy, so raw API keys never enter
 *     the worker runtime.
 *
 * No bash, no auto-compaction, no auto-retry, no file-based session JSONL.
 */

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
} from "@mariozechner/pi-agent-core";
import { getModel as piGetModel, type ImageContent } from "@mariozechner/pi-ai";

import type { RuntimeFs } from "./tools/runtime-fs.js";
import { type RpcCaller, loadNatStackResources } from "./resource-loader.js";

import { PiExtensionRuntime } from "./pi-extension-runtime.js";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
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

/**
/** Display name shown in consent/config cards. Falls back to the raw id. */
export function providerDisplayName(providerId: string): string {
  switch (providerId) {
    case "openai-codex":
      return "ChatGPT";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "groq":
      return "Groq";
    case "mistral":
      return "Mistral";
    case "openrouter":
      return "OpenRouter";
    default:
      return providerId;
  }
}

export function isEnvVarOnlyProvider(providerId: string): boolean {
  return new Set([
    "anthropic",
    "openai",
    "google",
    "groq",
    "mistral",
    "openrouter",
  ]).has(providerId);
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
  /** Default thinking level for new sessions. */
  thinkingLevel?: ThinkingLevel;
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

    // 3. Built-in file tools, wrapped with approval-gate dispatch.
    //    The read tool gets the RPC caller for image resize support.
    this.builtinTools = [
      createReadTool(cwd, this.options.fs, { rpc: this.options.rpc }),
      createEditTool(cwd, this.options.fs),
      createWriteTool(cwd, this.options.fs),
      createGrepTool(cwd, this.options.fs),
      createFindTool(cwd, this.options.fs),
      createLsTool(cwd, this.options.fs),
    ].map((t) => this.wrapToolWithApproval(t as AgentTool<any>));

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
        systemPrompt: `${resources.systemPrompt}\n\n${resources.skillIndex}`,
        model,
        thinkingLevel: this.options.thinkingLevel ?? "medium",
        tools: [],
        messages: this.options.initialMessages ?? [],
      },
      getApiKey: async (providerName: string) => {
        await this.ensureProviderReady(providerName);
        return "natstack-proxy";
      },
    });

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

  private async ensureProviderReady(providerName: string): Promise<void> {
    const displayName = providerDisplayName(providerName);
    const connections = await this.options.rpc.call<Array<{ connectionId: string }>>(
      "main",
      "credentials.listConnections",
      { providerId: providerName },
    );

    if (connections.length === 0) {
      if (isEnvVarOnlyProvider(providerName)) {
        this.options.uiCallbacks.requestProviderConfig?.(providerName, displayName);
        throw new Error(`Configuration required for ${displayName}.`);
      }

      this.options.uiCallbacks.requestProviderOAuth(providerName, displayName);
      throw new Error(`Sign in required for ${displayName}.`);
    }

    const hasConsent = await this.options.rpc.call<boolean>(
      "main",
      "credentials.checkConsent",
      { providerId: providerName },
    );
    if (!hasConsent) {
      this.options.uiCallbacks.requestConsentGrant?.(providerName, displayName);
      throw new Error(`Permission required for ${displayName}.`);
    }
  }

  /**
   * Wrap a tool's `execute()` to consult the extension runtime's `tool_call`
   * handlers first. If a handler returns `{ block: true }`, throw — the
   * pi-agent-core agent loop catches the throw and converts it into a
   * `ToolResultMessage` with `isError: true` that flows back to the LLM.
   */
  private wrapToolWithApproval(tool: AgentTool<any>): AgentTool<any> {
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
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    };
    return wrapped;
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
      try {
        await this.options.onPersist?.([...this.agent!.state.messages]);
      } catch (err) {
        console.error("[PiRunner] onPersist threw:", err);
      }
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
