/**
 * Pi Harness Adapter
 *
 * Translates Pi SDK session events into the HarnessOutput format.
 * Receives HarnessCommand, emits HarnessOutput — same contract as
 * the Claude SDK adapter.
 *
 * Key differences from the Claude adapter:
 * - Sessions are NatStack-owned JSONL trees (Pi SDK's SessionManager)
 * - Fork = extract path from JSONL tree + create new session file
 * - Resume = path to existing JSONL file
 * - Tool discovery from channel participants via injected deps
 *
 * This module does NOT import from `src/server/` or depend on pubsub/channels.
 * All external interactions go through the `PiAdapterDeps` interface.
 */

import type {
  HarnessCommand,
  HarnessConfig,
  HarnessOutput,
  TurnInput,
  TurnUsage,
} from "./types.js";
import {
  convertToPiTools,
  type DiscoveredMethod,
  type PiToolDefinition,
} from "./pi-tools.js";

// =============================================================================
// Pi SDK structural types (declared locally to avoid importing the SDK)
// =============================================================================

/**
 * Subset of `@mariozechner/pi-coding-agent`'s AgentSession used by the adapter.
 * The full session is injected via `PiAdapterDeps.createSession`.
 */
export interface PiSession {
  /** Send a prompt and wait for the agent loop to complete */
  prompt(
    text: string,
    options?: { images?: unknown[] },
  ): Promise<void>;

  /** Queue a follow-up message for when the agent finishes */
  followUp(text: string, images?: unknown[]): Promise<void>;

  /** Subscribe to session events. Returns unsubscribe function. */
  subscribe(listener: (event: PiSessionEvent) => void): () => void;

  /** Abort current operation */
  abort(): Promise<void>;

  /** Clean up the session */
  dispose(): void;

  /** Current session file path (JSONL) */
  readonly sessionFile: string | undefined;

  /** Get cumulative session statistics */
  getSessionStats(): PiSessionStats;
}

/** Subset of Pi SDK's AgentEvent / AgentSessionEvent union */
export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown[] }
  | {
      type: "message_start";
      message?: unknown;
    }
  | {
      type: "message_update";
      message?: unknown;
      assistantMessageEvent: {
        type: string;
        delta?: string;
        content?: string;
        reason?: string;
      };
    }
  | {
      type: "message_end";
      message?: {
        content?: Array<{ type: string; text?: string }>;
      };
    }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args?: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "auto_compaction_start"; reason: string }
  | {
      type: "auto_compaction_end";
      result?: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** Subset of Pi SDK's SessionStats */
export interface PiSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

/** Options for creating a Pi SDK session via the injected factory */
export interface CreatePiSessionOptions {
  cwd: string;
  model?: unknown;
  thinkingLevel?: string;
  customTools?: PiToolDefinition[];
  sessionManager?: unknown;
  resourceLoader?: unknown;
  authStorage?: unknown;
  modelRegistry?: unknown;
}

// =============================================================================
// Adapter dependencies
// =============================================================================

export interface PiAdapterDeps {
  /** Push a HarnessOutput event to the server */
  pushEvent(event: HarnessOutput): void;

  /** Execute a tool call on a channel participant */
  callMethod(
    participantId: string,
    method: string,
    args: unknown,
  ): Promise<unknown>;

  /** Discover available methods from channel roster */
  discoverMethods(): Promise<DiscoveredMethod[]>;

  /**
   * Create a Pi SDK session.
   *
   * The adapter delegates session creation to the host because the Pi SDK
   * has complex setup (AuthStorage, ModelRegistry, ResourceLoader, extension
   * factories) that belongs outside the harness boundary.
   */
  createSession(options: CreatePiSessionOptions): Promise<PiSession>;

  /**
   * Create a Pi SDK SessionManager.
   *
   * Returns a session manager — either `SessionManager.create(cwd)` for new
   * sessions or `SessionManager.open(path)` for resumed ones.
   * The adapter only needs the `sessionFile`, `createBranchedSession`,
   * and `getEntries` / `getEntry` subset.
   */
  createSessionManager(
    cwd: string,
    resumeSessionFile?: string,
  ): PiSessionManager;

  /** Logger */
  log?: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    debug(...args: unknown[]): void;
  };
}

/** Subset of Pi SDK's SessionManager used for fork/resume */
export interface PiSessionManager {
  /** Create a new session file containing only the branch to the given leaf */
  createBranchedSession(leafId: string): string | undefined;
  /** Get entry by ID */
  getEntry(id: string): unknown | undefined;
  /** Get all entries */
  getEntries(): Array<{ id: string; parentId: string | null; type: string }>;
  /** Current session file path */
  getSessionFile(): string | undefined;
}

// =============================================================================
// Adapter options
// =============================================================================

export interface PiAdapterOptions {
  /** Path to JSONL file for session resumption */
  resumeSessionId?: string;
  /** Working directory for Pi session */
  contextFolderPath?: string;
}

// =============================================================================
// Pi Adapter
// =============================================================================

export class PiAdapter {
  private session: PiSession | null = null;
  private sessionManager: PiSessionManager | null = null;
  private unsubscribe: (() => void) | null = null;
  private aborted = false;

  /** Previous cumulative token counts for computing per-turn deltas */
  private prevTokens = { input: 0, output: 0, cost: 0 };

  /** Map from Pi wire name to display name */
  private originalToDisplay = new Map<string, string>();

  /** Stream state tracking per turn */
  private streamState = {
    hasStreamedText: false,
    isThinking: false,
    inTextBlock: false,
    currentToolUseId: null as string | null,
    messageCompleteEmitted: false,
  };

  /** Pending tool approval requests — resolved when approve-tool arrives */
  private pendingApprovals = new Map<
    string,
    {
      resolve: (result: {
        allow: boolean;
        updatedInput?: Record<string, unknown>;
      }) => void;
    }
  >();

  /** Cached tools from first discovery (reused across session recreations) */
  private allTools: PiToolDefinition[] | null = null;

  /** Filtered methods from discovery (post-allowlist) */
  private discoveredMethods: DiscoveredMethod[] = [];

  /** Settings used to create the current session — compared per-turn */
  private activeModel: string | undefined;
  private activeThinkingLevel: string | undefined;

  constructor(
    private readonly config: HarnessConfig,
    private readonly deps: PiAdapterDeps,
    private readonly options?: PiAdapterOptions,
  ) {}

  // ---------------------------------------------------------------------------
  // Command dispatch
  // ---------------------------------------------------------------------------

  async handleCommand(command: HarnessCommand): Promise<void> {
    switch (command.type) {
      case "start-turn":
        return this.startTurn(command.input);
      case "approve-tool":
        this.approveTool(
          command.toolUseId,
          command.allow,
          command.updatedInput,
        );
        return;
      case "interrupt":
        return this.interrupt();
      case "fork":
        return this.fork(command.forkPointMessageId, command.turnSessionId);
      case "dispose":
        return this.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // start-turn
  // ---------------------------------------------------------------------------

  private async startTurn(input: TurnInput): Promise<void> {
    const log = this.deps.log;
    const cwd = this.options?.contextFolderPath ?? process.cwd();

    try {
      // Reset stream state for new turn
      this.streamState = {
        hasStreamedText: false,
        isThinking: false,
        inTextBlock: false,
        currentToolUseId: null,
        messageCompleteEmitted: false,
      };
      this.aborted = false;

      // ----- Tool discovery (first turn only) -----
      if (!this.allTools) {
        let methods = await this.deps.discoverMethods();

        // Apply tool allowlist BEFORE caching — defense-in-depth filter.
        const allowlist = this.config.toolAllowlist;
        if (allowlist) {
          const allowSet = new Set(allowlist);
          const before = methods.length;
          methods = methods.filter((m) => allowSet.has(m.name));
          log?.info(
            `Tool allowlist: ${before} discovered → ${methods.length} allowed`,
          );
        }

        // Store filtered set — createAskUserTool reads from this
        this.discoveredMethods = methods;

        const { customTools, originalToDisplay } = convertToPiTools(
          methods,
          (pid, method, args) => this.deps.callMethod(pid, method, args),
        );
        this.originalToDisplay = originalToDisplay;

        // Wrap custom tools with approval gating — the server/DO decides
        // whether to auto-approve or prompt the user interactively.
        const approvalWrappedTools: PiToolDefinition[] = customTools.map(
          (tool) => ({
            ...tool,
            execute: async (
              toolCallId: string,
              params: Record<string, unknown>,
              signal: AbortSignal | undefined,
              onUpdate: Parameters<PiToolDefinition["execute"]>[3],
              ctx: unknown,
            ): ReturnType<PiToolDefinition["execute"]> => {
              const approval = await this.requestToolApproval(
                toolCallId,
                tool.name,
                params,
                signal,
              );
              if (!approval.allow) {
                // Emit action-start/end so the UI shows the denied attempt
                const displayName =
                  this.originalToDisplay.get(tool.name) ??
                  prettifyToolName(tool.name);
                this.deps.pushEvent({
                  type: "action-start",
                  tool: displayName,
                  description: getToolDescription(displayName, params),
                  toolUseId: toolCallId,
                });
                return {
                  content: [
                    { type: "text" as const, text: "Tool use denied by user" },
                  ],
                  details: undefined as unknown,
                };
              }
              // Emit action-start after approval — matches Claude's ordering
              // where canUseTool resolves before the action bead appears.
              const displayName =
                this.originalToDisplay.get(tool.name) ??
                prettifyToolName(tool.name);
              const finalParams = approval.updatedInput ?? params;
              this.deps.pushEvent({
                type: "action-start",
                tool: displayName,
                description: getToolDescription(displayName, finalParams),
                toolUseId: toolCallId,
              });
              return tool.execute(toolCallId, finalParams, signal, onUpdate, ctx);
            },
          }),
        );

        // Add AskUserQuestion tool if feedback_form is available
        const askUserTool = this.createAskUserTool();
        this.allTools = askUserTool
          ? [...approvalWrappedTools, askUserTool]
          : approvalWrappedTools;

        log?.info(
          `Discovered ${this.allTools.length} tools from channel participants`,
        );
      }

      // ----- Session creation / recreation -----
      // Resolve effective settings for this turn
      const turnModel = input.settings?.model ?? this.config.model;
      const turnThinking =
        input.settings?.maxThinkingTokens !== undefined
          ? mapThinkingTokensToLevel(input.settings.maxThinkingTokens)
          : this.config.maxThinkingTokens !== undefined
            ? mapThinkingTokensToLevel(this.config.maxThinkingTokens)
            : undefined;

      const settingsChanged =
        this.session &&
        (turnModel !== this.activeModel ||
          turnThinking !== this.activeThinkingLevel);

      if (!this.session || settingsChanged) {
        // Dispose existing session, preserving session file for resume
        let resumeFile = this.options?.resumeSessionId;
        if (this.session) {
          resumeFile = this.session.sessionFile ?? undefined;
          log?.info(
            `Recreating session (model: ${this.activeModel} → ${turnModel}, ` +
              `thinking: ${this.activeThinkingLevel} → ${turnThinking})`,
          );
          this.teardownSession();
        }

        this.sessionManager = this.deps.createSessionManager(cwd, resumeFile);

        const session = await this.deps.createSession({
          cwd,
          customTools: this.allTools!,
          sessionManager: this.sessionManager,
          ...(turnModel && { model: turnModel }),
          ...(turnThinking && { thinkingLevel: turnThinking }),
        });
        this.session = session;
        this.activeModel = turnModel;
        this.activeThinkingLevel = turnThinking;

        this.unsubscribe = session.subscribe((event) => {
          this.handlePiEvent(event);
        });
      }

      // Run the prompt (blocks until agent finishes)
      await this.session.prompt(input.content);

      // Ensure message-complete is emitted if we had content.
      // Close open blocks first so text-end precedes message-complete.
      if (
        this.streamState.hasStreamedText &&
        !this.streamState.messageCompleteEmitted
      ) {
        this.closeOpenBlocks();
        this.deps.pushEvent({ type: "message-complete" });
      }

      // Emit turn-complete with session file as sessionId
      const usage = this.computeTurnUsage();
      const sessionId = this.session.sessionFile ?? "";
      this.deps.pushEvent({
        type: "turn-complete",
        sessionId,
        usage,
      });
    } catch (err) {
      // Aborted sessions may throw — only report unexpected errors
      if (!this.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        log?.error("Pi turn error:", message);
        this.deps.pushEvent({ type: "error", error: message });

        // Emit turn-complete with sessionId for crash recovery
        const sessionId = this.session?.sessionFile ?? "";
        if (sessionId) {
          this.deps.pushEvent({
            type: "turn-complete",
            sessionId,
            usage: this.computeTurnUsage(),
          });
        }
      }
    } finally {
      // Ensure thinking/text blocks are closed
      this.closeOpenBlocks();
      // DON'T unsubscribe — keep the subscription active for the next turn
    }
  }

  /** Tear down the current session without clearing tools or discovery state */
  private teardownSession(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.session) {
      try {
        this.session.dispose();
      } catch (err) {
        this.deps.log?.warn(`Session dispose error: ${err}`);
      }
      this.session = null;
    }
    this.sessionManager = null;
  }

  // ---------------------------------------------------------------------------
  // approve-tool
  // ---------------------------------------------------------------------------

  private approveTool(
    toolUseId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
  ): void {
    const pending = this.pendingApprovals.get(toolUseId);
    if (pending) {
      this.pendingApprovals.delete(toolUseId);
      pending.resolve({ allow, updatedInput });
    } else {
      this.deps.log?.debug(
        `approve-tool for unknown toolUseId ${toolUseId}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // interrupt
  // ---------------------------------------------------------------------------

  private async interrupt(): Promise<void> {
    this.aborted = true;
    // Reject all pending approvals — the tool calls are cancelled
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ allow: false });
    }
    this.pendingApprovals.clear();
    if (this.session) {
      try {
        await this.session.abort();
      } catch (err) {
        this.deps.log?.warn(`Session abort error: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // fork
  // ---------------------------------------------------------------------------

  private fork(
    forkPointMessageId: number,
    turnSessionId: string,
  ): void {
    // Pi sessions are JSONL trees. Forking means:
    // 1. Open the session file identified by turnSessionId
    // 2. Find the entry closest to forkPointMessageId
    // 3. Call SessionManager.createBranchedSession(entryId) to extract a new file
    //
    // The turnSessionId IS the JSONL file path (set in turn-complete).
    //
    // The forked session file path is returned via a turn-complete event
    // so the server can use it for the next respawn.

    if (!turnSessionId) {
      this.deps.pushEvent({
        type: "error",
        error: "Cannot fork: no session file (turnSessionId is empty)",
        code: "FORK_NO_SESSION",
      });
      return;
    }

    try {
      const sm = this.deps.createSessionManager(
        this.options?.contextFolderPath ?? process.cwd(),
        turnSessionId,
      );

      // Find the entry to fork from. forkPointMessageId is a numeric message ID
      // from pubsub; we need to map it to a JSONL entry ID. The entries are
      // ordered, so we use the index as a proxy.
      const entries = sm.getEntries();
      const messageEntries = entries.filter((e) => e.type === "message");

      // Clamp to valid range
      const idx = Math.min(
        Math.max(0, forkPointMessageId),
        messageEntries.length - 1,
      );
      const targetEntry = messageEntries[idx];

      if (!targetEntry) {
        this.deps.pushEvent({
          type: "error",
          error: `Cannot fork: no entry found at index ${forkPointMessageId}`,
          code: "FORK_NO_ENTRY",
        });
        return;
      }

      const newSessionFile = sm.createBranchedSession(targetEntry.id);
      if (!newSessionFile) {
        this.deps.pushEvent({
          type: "error",
          error: "Fork failed: SessionManager returned no file (in-memory session?)",
          code: "FORK_FAILED",
        });
        return;
      }

      this.deps.log?.info(
        `Forked session at entry ${targetEntry.id} -> ${newSessionFile}`,
      );

      // Emit turn-complete with the new session file so the server can respawn
      this.deps.pushEvent({
        type: "turn-complete",
        sessionId: newSessionFile,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.pushEvent({
        type: "error",
        error: `Fork error: ${message}`,
        code: "FORK_ERROR",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  private dispose(): void {
    // Reject pending approvals
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ allow: false });
    }
    this.pendingApprovals.clear();
    this.teardownSession();
    this.allTools = null;
    this.originalToDisplay.clear();
    this.discoveredMethods = [];
    this.activeModel = undefined;
    this.activeThinkingLevel = undefined;
    this.prevTokens = { input: 0, output: 0, cost: 0 };
  }

  // ---------------------------------------------------------------------------
  // Pi event -> HarnessOutput mapping
  // ---------------------------------------------------------------------------

  private handlePiEvent(event: PiSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        // Agent loop started — no HarnessOutput equivalent needed
        break;

      case "message_update":
        this.handleMessageUpdate(event);
        break;

      case "message_start":
        // If we were thinking, close the thinking block
        if (this.streamState.isThinking) {
          this.deps.pushEvent({ type: "thinking-end" });
          this.streamState.isThinking = false;
        }
        break;

      case "message_end":
        this.handleMessageEnd(event);
        break;

      case "tool_execution_start":
        this.handleToolStart(event);
        break;

      case "tool_execution_end":
        this.handleToolEnd(event);
        break;

      case "turn_end":
        // Turn-level completion is handled after prompt() resolves
        break;

      case "agent_end":
        // Agent loop finished — completion handled after prompt() resolves
        break;

      default:
        this.deps.log?.debug(`Unhandled Pi event type: ${event.type}`);
        break;
    }
  }

  private handleMessageUpdate(
    event: Extract<PiSessionEvent, { type: "message_update" }>,
  ): void {
    const ame = event.assistantMessageEvent;

    if (ame.type === "thinking_delta" && ame.delta) {
      // Start thinking block if not already open
      if (!this.streamState.isThinking) {
        this.deps.pushEvent({ type: "thinking-start" });
        this.streamState.isThinking = true;
      }
      this.deps.pushEvent({ type: "thinking-delta", content: ame.delta });
    } else if (ame.type === "text_delta" && ame.delta) {
      // Close thinking block if open
      if (this.streamState.isThinking) {
        this.deps.pushEvent({ type: "thinking-end" });
        this.streamState.isThinking = false;
      }
      // Open text block if not already open
      if (!this.streamState.inTextBlock) {
        this.deps.pushEvent({ type: "text-start" });
        this.streamState.inTextBlock = true;
      }
      this.streamState.hasStreamedText = true;
      this.deps.pushEvent({ type: "text-delta", content: ame.delta });
    } else if (
      ame.type === "text_end" &&
      ame.content &&
      !this.streamState.hasStreamedText
    ) {
      // Fallback: text_end delivers full text when text_delta events were skipped
      if (this.streamState.isThinking) {
        this.deps.pushEvent({ type: "thinking-end" });
        this.streamState.isThinking = false;
      }
      if (!this.streamState.inTextBlock) {
        this.deps.pushEvent({ type: "text-start" });
        this.streamState.inTextBlock = true;
      }
      this.streamState.hasStreamedText = true;
      this.deps.pushEvent({ type: "text-delta", content: ame.content });
    } else if (ame.type === "error") {
      this.deps.log?.warn(`Pi SDK error event: ${ame.reason ?? "unknown"}`);
      this.deps.pushEvent({
        type: "error",
        error: ame.reason ?? "Pi SDK error",
        code: "PI_SDK_ERROR",
      });
    }
  }

  private handleMessageEnd(
    event: Extract<PiSessionEvent, { type: "message_end" }>,
  ): void {
    // Close thinking if still open
    if (this.streamState.isThinking) {
      this.deps.pushEvent({ type: "thinking-end" });
      this.streamState.isThinking = false;
    }

    // Fallback: if no text was streamed, extract from the complete message
    if (!this.streamState.hasStreamedText && event.message?.content) {
      const textParts = event.message.content.filter(
        (c) => c.type === "text" && c.text,
      );
      const fullText = textParts.map((c) => c.text).join("") ?? "";
      if (fullText) {
        if (!this.streamState.inTextBlock) {
          this.deps.pushEvent({ type: "text-start" });
          this.streamState.inTextBlock = true;
        }
        this.streamState.hasStreamedText = true;
        this.deps.pushEvent({ type: "text-delta", content: fullText });
        this.deps.log?.info(
          "Used message_end fallback (no streaming events received)",
        );
      }
    }

    // Close text block
    if (this.streamState.inTextBlock) {
      this.deps.pushEvent({ type: "text-end" });
      this.streamState.inTextBlock = false;
    }

    // Emit message-complete
    this.deps.pushEvent({ type: "message-complete" });
    this.streamState.messageCompleteEmitted = true;
  }

  private handleToolStart(
    event: Extract<PiSessionEvent, { type: "tool_execution_start" }>,
  ): void {
    // Close any open blocks before the tool runs
    if (this.streamState.isThinking) {
      this.deps.pushEvent({ type: "thinking-end" });
      this.streamState.isThinking = false;
    }
    if (this.streamState.inTextBlock) {
      this.deps.pushEvent({ type: "text-end" });
      this.streamState.inTextBlock = false;
    }

    const toolUseId = event.toolCallId ?? generateId();
    this.streamState.currentToolUseId = toolUseId;

    // Approval-gated tools (in originalToDisplay) defer action-start until
    // after the approval resolves — the execute wrapper emits it. This matches
    // Claude's ordering where canUseTool fires before the action bead.
    if (this.originalToDisplay.has(event.toolName)) {
      return;
    }

    // Non-approval tools (Pi built-ins, ask_user) emit action-start immediately
    const displayName = prettifyToolName(event.toolName);
    const args = (event.args ?? {}) as Record<string, unknown>;
    this.deps.pushEvent({
      type: "action-start",
      tool: displayName,
      description: getToolDescription(displayName, args),
      toolUseId,
    });
  }

  private handleToolEnd(
    event: Extract<PiSessionEvent, { type: "tool_execution_end" }>,
  ): void {
    const toolUseId =
      event.toolCallId ?? this.streamState.currentToolUseId ?? generateId();

    this.deps.pushEvent({
      type: "action-end",
      toolUseId,
    });

    this.streamState.currentToolUseId = null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Emit approval-needed and wait for the server/DO to approve or deny.
   *  If the signal fires (interrupt/abort), auto-deny so the promise resolves. */
  private requestToolApproval(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ allow: boolean; updatedInput?: Record<string, unknown> }> {
    return new Promise((resolve) => {
      // If already aborted, deny immediately
      if (signal?.aborted) {
        resolve({ allow: false });
        return;
      }

      this.pendingApprovals.set(toolUseId, { resolve });

      // Auto-deny if the signal fires while waiting (interrupt, timeout, etc.)
      const onAbort = () => {
        if (this.pendingApprovals.has(toolUseId)) {
          this.pendingApprovals.delete(toolUseId);
          resolve({ allow: false });
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.deps.pushEvent({
        type: "approval-needed",
        toolUseId,
        toolName,
        input,
      });
    });
  }

  /** Create an AskUserQuestion custom tool that routes through feedback_form.
   *  Supports both simple single-question and multi-question with options,
   *  matching the Claude SDK's AskUserQuestion format. */
  private createAskUserTool(): PiToolDefinition | null {
    const feedbackProvider = this.discoveredMethods.find(
      (m) => m.name === "feedback_form",
    );
    if (!feedbackProvider) return null;

    return {
      name: "ask_user",
      label: "Ask User",
      description:
        "Ask the user a question and wait for their response. " +
        "Use `question` for a single free-text question, or `questions` " +
        "for multiple questions with optional choice options.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Simple single question text",
          },
          questions: {
            type: "array",
            description: "Array of structured questions",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                header: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
                multiSelect: { type: "boolean" },
              },
            },
          },
        },
      },
      execute: async (_toolCallId, params) => {
        try {
          const fields = buildAskUserFields(params);
          const result = await this.deps.callMethod(
            feedbackProvider.participantId,
            "feedback_form",
            { title: "Agent needs your input", fields, values: {} },
          );
          const fr = result as {
            type?: string;
            value?: Record<string, unknown>;
          };
          if (fr.type === "cancel") {
            return {
              content: [
                { type: "text" as const, text: "User cancelled the question." },
              ],
              details: undefined as unknown,
            };
          }

          // Collect answers, resolving "Other" fields
          const formValues = fr.value ?? {};
          const answers: string[] = [];
          for (const [key, value] of Object.entries(formValues)) {
            if (key.endsWith("_other")) continue;
            const otherValue = formValues[`${key}_other`];
            let answer: string;
            if (Array.isArray(value)) {
              answer = value
                .map((v: string) =>
                  v === "__other__"
                    ? (typeof otherValue === "string" && otherValue) || "Other"
                    : v,
                )
                .join(", ");
            } else if (value === "__other__") {
              answer =
                (typeof otherValue === "string" && otherValue) || "Other";
            } else {
              answer = String(value);
            }
            if (answer) answers.push(answer);
          }

          const text = answers.join("\n") || "(no response)";
          return {
            content: [{ type: "text" as const, text }],
            details: undefined as unknown,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text" as const, text: `Error asking user: ${msg}` },
            ],
            details: undefined as unknown,
          };
        }
      },
    };
  }

  /** Close any open thinking/text blocks */
  private closeOpenBlocks(): void {
    if (this.streamState.isThinking) {
      this.deps.pushEvent({ type: "thinking-end" });
      this.streamState.isThinking = false;
    }
    if (this.streamState.inTextBlock) {
      this.deps.pushEvent({ type: "text-end" });
      this.streamState.inTextBlock = false;
    }
  }

  /** Compute per-turn token usage from cumulative session stats */
  private computeTurnUsage(): TurnUsage | undefined {
    if (!this.session) return undefined;
    try {
      const stats = this.session.getSessionStats();
      const inputDelta = stats.tokens.input - this.prevTokens.input;
      const outputDelta = stats.tokens.output - this.prevTokens.output;
      this.prevTokens = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cost: stats.cost,
      };
      if (inputDelta > 0 || outputDelta > 0) {
        return {
          inputTokens: inputDelta,
          outputTokens: outputDelta,
          cacheReadTokens: stats.tokens.cacheRead,
          cacheWriteTokens: stats.tokens.cacheWrite,
        };
      }
    } catch (err) {
      this.deps.log?.debug(`Failed to get session stats: ${err}`);
    }
    return undefined;
  }
}

// =============================================================================
// Utility functions
// =============================================================================

/** Simple prettification of tool names (snake_case -> Title Case) */
function prettifyToolName(name: string): string {
  return name
    .replace(/^pubsub_[^_]+_/, "") // strip pubsub prefix
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Generate a short action description from tool name and args */
function getToolDescription(
  tool: string,
  args: Record<string, unknown>,
): string {
  // Pull out common argument patterns for a readable description
  const path =
    (args["file_path"] as string) ??
    (args["path"] as string) ??
    (args["command"] as string);

  if (path) {
    return `${tool}: ${String(path).slice(0, 120)}`;
  }
  return tool;
}

/** Build feedback_form fields from ask_user params (single or multi-question) */
function buildAskUserFields(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const questions = params["questions"] as
    | Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
      }>
    | undefined;

  const fields: Array<Record<string, unknown>> = [];

  if (Array.isArray(questions) && questions.length > 0) {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const fieldId = String(i);
      const fieldOptions = (q.options ?? []).map((opt) => ({
        value: opt.label,
        label: opt.label,
        description: opt.description,
      }));
      // Add "Other" option for short option lists
      if (fieldOptions.length > 0 && fieldOptions.length < 4) {
        fieldOptions.push({
          value: "__other__",
          label: "Other",
          description: "Provide a custom answer",
        });
      }
      if (fieldOptions.length > 0) {
        fields.push({
          key: fieldId,
          label: q.header || q.question,
          description: q.question,
          type: q.multiSelect ? "multiSelect" : "segmented",
          variant: "cards",
          options: fieldOptions,
        });
        fields.push({
          key: `${fieldId}_other`,
          label: "Please specify",
          type: "string",
          placeholder: "Enter your answer...",
          visibleWhen: q.multiSelect
            ? { field: fieldId, operator: "contains", value: "__other__" }
            : { field: fieldId, operator: "eq", value: "__other__" },
        });
      } else {
        fields.push({
          key: fieldId,
          label: q.header || "Your response",
          description: q.question,
          type: "textarea",
          required: true,
        });
      }
    }
  } else {
    // Single question fallback
    const question =
      (params["question"] as string) ?? "Do you have any input?";
    fields.push({
      key: "0",
      label: "Your response",
      description: question,
      type: "textarea",
      required: true,
    });
  }

  return fields;
}

/** Map maxThinkingTokens (number) to Pi's ThinkingLevel (string) */
function mapThinkingTokensToLevel(mtk: number): string {
  if (!mtk || mtk === 0) return "off";
  if (mtk <= 1024) return "minimal";
  if (mtk <= 4096) return "low";
  if (mtk <= 16384) return "medium";
  if (mtk <= 65536) return "high";
  return "xhigh";
}

/** Generate a simple unique ID */
function generateId(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
