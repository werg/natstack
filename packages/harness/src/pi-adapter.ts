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
  };

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
        return this.approveTool(
          command.toolUseId,
          command.allow,
          command.alwaysAllow,
        );
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
      };
      this.aborted = false;

      // Ensure session exists — create on first turn, reuse on subsequent turns.
      // The Pi SDK session manages its own conversation history and JSONL persistence.
      if (!this.session) {
        // Discover tools from channel participants
        const methods = await this.deps.discoverMethods();
        const { customTools, originalToDisplay } = convertToPiTools(
          methods,
          (pid, method, args) => this.deps.callMethod(pid, method, args),
        );
        this.originalToDisplay = originalToDisplay;

        log?.info(
          `Discovered ${customTools.length} tools from channel participants`,
        );

        // Create session manager (new or resumed)
        const resumeFile = this.options?.resumeSessionId;
        this.sessionManager = this.deps.createSessionManager(cwd, resumeFile);

        // Create Pi session
        const session = await this.deps.createSession({
          cwd,
          customTools,
          sessionManager: this.sessionManager,
        });
        this.session = session;

        // Subscribe once — stays active across turns. Events only fire during
        // session.prompt(), so the stream state reset above is safe.
        this.unsubscribe = session.subscribe((event) => {
          this.handlePiEvent(event);
        });
      }

      // Run the prompt (blocks until agent finishes)
      await this.session.prompt(input.content);

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
        const message =
          err instanceof Error ? err.message : String(err);
        log?.error("Pi turn error:", message);
        this.deps.pushEvent({ type: "error", error: message });
      }
    } finally {
      // Ensure thinking/text blocks are closed
      this.closeOpenBlocks();
      // DON'T unsubscribe — keep the subscription active for the next turn
    }
  }

  // ---------------------------------------------------------------------------
  // approve-tool
  // ---------------------------------------------------------------------------

  private approveTool(
    _toolUseId: string,
    _allow: boolean,
    _alwaysAllow?: boolean,
  ): void {
    // Pi SDK handles tool approval via its extension hook (tool_call event),
    // not the harness approve/reject flow. Approval gating is controlled by
    // the autonomy level configured in adapterConfig, not interactive prompts.
    // This method is intentionally a no-op for Pi.
    this.deps.log?.debug(
      `approve-tool command received (toolUseId=${_toolUseId}, allow=${_allow}) — ` +
        `Pi uses extension-hook-based approval, not harness commands`,
    );
  }

  // ---------------------------------------------------------------------------
  // interrupt
  // ---------------------------------------------------------------------------

  private async interrupt(): Promise<void> {
    this.aborted = true;
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
    this.originalToDisplay.clear();
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
  }

  private handleToolStart(
    event: Extract<PiSessionEvent, { type: "tool_execution_start" }>,
  ): void {
    // Close any open blocks
    if (this.streamState.isThinking) {
      this.deps.pushEvent({ type: "thinking-end" });
      this.streamState.isThinking = false;
    }
    if (this.streamState.inTextBlock) {
      this.deps.pushEvent({ type: "text-end" });
      this.streamState.inTextBlock = false;
    }

    const displayName =
      this.originalToDisplay.get(event.toolName) ??
      prettifyToolName(event.toolName);
    const toolUseId = event.toolCallId ?? generateId();
    const args = (event.args ?? {}) as Record<string, unknown>;

    this.streamState.currentToolUseId = toolUseId;

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

/** Generate a simple unique ID */
function generateId(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
