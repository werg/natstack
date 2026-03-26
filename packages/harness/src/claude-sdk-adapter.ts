/**
 * Claude SDK Adapter — translates between HarnessCommand/HarnessOutput and
 * the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).
 *
 * ## Adapter contract
 *
 * A harness adapter receives {@link HarnessCommand} messages and emits
 * {@link HarnessOutput} events. To implement a new adapter:
 *
 * 1. Create a class with a `handleCommand(command: HarnessCommand): Promise<void>` method.
 * 2. Accept a `pushEvent(event: HarnessOutput): Promise<void>` callback in the constructor.
 * 3. Translate provider-specific stream events into the HarnessOutput discriminated union.
 * 4. Tool execution goes through a `callMethod` dep — the adapter never touches
 *    PubSub, channels, or durable objects directly.
 *
 * This adapter manages a Claude Agent SDK session (create, resume, fork) and
 * maps SDK stream events to HarnessOutput:
 *
 * | SDK event                          | HarnessOutput                                  |
 * |------------------------------------|-------------------------------------------------|
 * | content_block_start (thinking)     | thinking-start                                  |
 * | content_block_delta (thinking)     | thinking-delta                                  |
 * | content_block_stop  (thinking)     | thinking-end                                    |
 * | content_block_start (text)         | text-start                                      |
 * | content_block_delta (text)         | text-delta                                      |
 * | content_block_stop  (text)         | text-end                                        |
 * | content_block_start (tool_use)     | (accumulates input)                              |
 * | content_block_stop  (tool_use)     | action-start + action-end                       |
 * | subagent stream event (tool_use)   | action-start + action-end                        |
 * | result (success)                   | turn-complete                                   |
 * | result (error)                     | error                                           |
 *
 * @module
 */

import type {
  HarnessOutput,
  HarnessCommand,
  HarnessConfig,
  HarnessSettings,
  TurnInput,
  TurnUsage,
} from './types.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildMcpToolDefinitions, type McpToolDefinition } from './mcp-tools.js';
import { jsonSchemaToZodRawShape } from './json-schema-to-zod.js';

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * A method discovered from channel participants, suitable for conversion to
 * an MCP tool the Claude SDK can invoke.
 */
export interface DiscoveredMethod {
  /** ID of the participant that provides this method */
  participantId: string;
  /** Method name (becomes the MCP tool name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for the method's parameters (optional) */
  parameters?: unknown;
}

/**
 * Dependencies injected into the adapter at construction time.
 *
 * These isolate the adapter from transport concerns (PubSub, HTTP, etc.)
 * so it can be tested and reused in different hosting environments.
 */
export interface ClaudeAdapterDeps {
  /** Push a HarnessOutput event to the server */
  pushEvent(event: HarnessOutput): Promise<void>;

  /** Execute a tool call on a channel participant */
  callMethod(participantId: string, method: string, args: unknown): Promise<unknown>;

  /** Discover available methods from channel roster */
  discoverMethods(): Promise<DiscoveredMethod[]>;

  /** Optional logger */
  log?: {
    info(...args: unknown[]): void;
    error(...args: unknown[]): void;
    debug?(...args: unknown[]): void;
  };
}

/**
 * Options for constructing the adapter beyond the base HarnessConfig.
 */
export interface ClaudeAdapterOptions {
  /** Session ID from a previous run — used for crash recovery / resume */
  resumeSessionId?: string;
  /** Working directory for the SDK subprocess */
  contextFolderPath?: string;
  /** Path to the `claude` CLI executable */
  claudeExecutablePath?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Accumulates streamed JSON chunks for a single tool_use block */
interface ToolInputAccumulator {
  toolName: string;
  inputChunks: string[];
}

/**
 * Typed subset of the SDK's stream event shape. We use structural typing here
 * rather than importing the SDK types so the adapter can be unit-tested without
 * the SDK installed.
 */
interface SdkStreamEvent {
  type: string;
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
  };
}

/** Structural subset of an SDK message yielded by the query async iterator */
interface SdkMessage {
  type: string;
  uuid?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: SdkStreamEvent;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
    }>;
  };
  subtype?: string;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// ClaudeSdkAdapter
// ---------------------------------------------------------------------------

/**
 * Manages a Claude Agent SDK session and translates between
 * {@link HarnessCommand} inputs and {@link HarnessOutput} events.
 *
 * ## Lifecycle
 *
 * ```text
 * construct → handleCommand('start-turn') → stream events → turn-complete
 *           → handleCommand('start-turn') → ...
 *           → handleCommand('dispose')
 * ```
 *
 * ## Writing a new adapter
 *
 * Implement the same `handleCommand` → `pushEvent` contract:
 *
 * ```typescript
 * class MyAdapter {
 *   constructor(config: HarnessConfig, deps: ClaudeAdapterDeps) { ... }
 *   async handleCommand(cmd: HarnessCommand): Promise<void> { ... }
 * }
 * ```
 *
 * The server doesn't care which adapter is used — it only sees
 * HarnessCommand in and HarnessOutput out.
 */
export class ClaudeSdkAdapter {
  /** The SDK session ID, captured from query results */
  private sessionId?: string;

  /** AbortController for the currently running turn */
  private currentAbort?: AbortController;

  /** Reference to the active SDK Query object (for interrupt) */
  private activeQuery: AsyncGenerator<SdkMessage, void> & { interrupt?(): Promise<void> } | null = null;

  /** Whether the adapter has been disposed */
  private disposed = false;

  /** Turn queueing — prevents concurrent startTurn calls from corrupting state */
  private pendingTurns: TurnInput[] = [];
  private turnInProgress = false;
  private turnCompleteEmitted = false;

  /** Discovered channel methods — cached from buildMcpServers for AskUserQuestion routing */
  private discoveredMethods: DiscoveredMethod[] = [];

  /** Pending tool approval requests — resolved when approve-tool arrives */
  private pendingApprovals = new Map<string, {
    resolve: (result: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }) => void;
    toolName: string;
    input: Record<string, unknown>;
  }>();

  /** Resolved SDK module (lazy-loaded to support environments without the SDK) */
  private sdkModule: {
    query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncGenerator<SdkMessage, void> & { interrupt?(): Promise<void> };
    tool: (name: string, description: string, inputSchema: unknown, handler: (...args: unknown[]) => Promise<unknown>) => unknown;
    createSdkMcpServer: (options: { name: string; version?: string; tools?: unknown[] }) => unknown;
  } | null = null;

  constructor(
    private config: HarnessConfig,
    private deps: ClaudeAdapterDeps,
    private options: ClaudeAdapterOptions = {},
  ) {
    // If a resume session ID was provided, store it
    if (options.resumeSessionId) {
      this.sessionId = options.resumeSessionId;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming command from the server.
   *
   * @param command - The command to process
   */
  async handleCommand(command: HarnessCommand): Promise<void> {
    switch (command.type) {
      case 'start-turn':
        return this.startTurn(command.input);
      case 'approve-tool': {
        // Resolve the pending approval promise for this tool use.
        // The canUseTool callback in the SDK query is blocked on this.
        const pending = this.pendingApprovals.get(command.toolUseId);
        if (pending) {
          this.pendingApprovals.delete(command.toolUseId);
          if (command.allow) {
            pending.resolve({
              behavior: 'allow',
              updatedInput: command.updatedInput ?? pending.input,
            });
          } else {
            pending.resolve({ behavior: 'deny', message: 'User denied tool use' });
          }
        } else {
          this.log('debug', `approve-tool for unknown toolUseId ${command.toolUseId}`);
        }
        return;
      }
      case 'interrupt':
        return this.interrupt();
      case 'fork':
        return this.fork(command.forkPointMessageId, command.turnSessionId);
      case 'dispose':
        return this.dispose();
    }
  }

  /**
   * Get the current SDK session ID (if any).
   * Used by the server to persist session state for crash recovery.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  // -------------------------------------------------------------------------
  // SDK module loading
  // -------------------------------------------------------------------------

  /**
   * Lazily load the Claude Agent SDK.
   * Throws a clear error if the SDK is not installed.
   */
  private async ensureSdk(): Promise<NonNullable<typeof this.sdkModule>> {
    if (this.sdkModule) return this.sdkModule;

    try {
      // Dynamic import so the adapter can be compiled/tested without the SDK
      const sdk = await import('@anthropic-ai/claude-agent-sdk') as Record<string, unknown>;
      this.sdkModule = {
        query: sdk["query"] as typeof this.sdkModule extends null ? never : NonNullable<typeof this.sdkModule>['query'],
        tool: sdk["tool"] as typeof this.sdkModule extends null ? never : NonNullable<typeof this.sdkModule>['tool'],
        createSdkMcpServer: sdk["createSdkMcpServer"] as typeof this.sdkModule extends null ? never : NonNullable<typeof this.sdkModule>['createSdkMcpServer'],
      } as NonNullable<typeof this.sdkModule>;
      return this.sdkModule;
    } catch {
      throw new Error(
        'Claude Agent SDK (@anthropic-ai/claude-agent-sdk) is not installed. ' +
        'Install it to use the ClaudeSdkAdapter.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  /**
   * Queue-aware entry point for starting a turn.
   * If a turn is already in progress, queues the input for later.
   */
  private async startTurn(input: TurnInput): Promise<void> {
    if (this.disposed) {
      await this.pushError('Adapter has been disposed', 'ADAPTER_ERROR');
      return;
    }

    if (this.turnInProgress) {
      this.pendingTurns.push(input);
      return;
    }

    this.turnInProgress = true;
    try {
      await this.runTurn(input);
    } finally {
      this.turnInProgress = false;
      this.drainQueue();
    }
  }

  /** Process the next queued turn, if any */
  private drainQueue(): void {
    if (this.disposed || this.pendingTurns.length === 0) return;
    const next = this.pendingTurns.shift()!;
    void this.startTurn(next);
  }

  /**
   * Run a single AI turn: build SDK options, invoke `query()`, and stream
   * events back as HarnessOutput.
   */
  private async runTurn(input: TurnInput): Promise<void> {
    this.turnCompleteEmitted = false;

    const abort = new AbortController();
    this.currentAbort = abort;

    try {
      const sdk = await this.ensureSdk();

      // Build system prompt — append to SDK defaults unless explicitly replacing.
      // When no custom prompt is configured and mode is append, use the preset
      // as-is so the SDK's built-in instructions (including skill discovery) apply.
      const promptText = buildSystemPrompt(this.config);
      const mode = this.config.systemPromptMode ?? 'append';
      const systemPrompt = mode === 'replace'
        ? (promptText ?? 'You are a helpful assistant.')
        : promptText
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: promptText }
          : { type: 'preset' as const, preset: 'claude_code' as const };

      // Discover and build MCP tools from channel methods
      const mcpServers = await this.buildMcpServers(sdk);

      // Build SDK query options
      const queryOptions: Record<string, unknown> = {
        systemPrompt,
        includePartialMessages: true,
        ...(this.options.contextFolderPath && {
          cwd: this.options.contextFolderPath,
          // Context folder has .claude-plugin/plugin.json and skills/ — register
          // it as a local plugin so the SDK discovers workspace skills.
          plugins: [{ type: 'local' as const, path: this.options.contextFolderPath }],
        }),
        ...(this.options.claudeExecutablePath && {
          pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        }),
        ...(this.sessionId && { resume: this.sessionId }),
        ...(this.resolveModel(input.settings) && { model: this.resolveModel(input.settings) }),
        // Extended thinking: prefer per-turn settings, then config, then default 10240.
        // Without this, the SDK CLI won't pass --max-thinking-tokens and thinking
        // events won't appear in the stream.
        maxThinkingTokens: input.settings?.maxThinkingTokens ?? this.config.maxThinkingTokens ?? 10240,
        ...(input.settings?.temperature !== undefined && { temperature: input.settings.temperature }),
        ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
        ...(this.config.adapterConfig ?? {}),
        abortController: abort,
        // Tool approval: block until the server forwards the user's decision.
        // The SDK expects PermissionResult objects: {behavior: 'allow', updatedInput}
        // or {behavior: 'deny', message}.
        canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal; suggestions?: unknown[] }) => {
          const toolUseId = options.toolUseID;
          this.log('info', `canUseTool: requesting approval for "${toolName}" (toolUseId=${toolUseId})`);

          // AskUserQuestion: route through feedback_form via callMethod (goes through DO as middleware).
          if (toolName === "AskUserQuestion") {
            const feedbackProvider = this.discoveredMethods.find(m => m.name === "feedback_form");
            if (!feedbackProvider) {
              return { behavior: 'deny', message: 'No feedback_form provider available' };
            }

            try {
              // Convert SDK question format to feedback_form fields
              const questions = (toolInput as { questions?: Array<{ question: string; header: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> }).questions;
              const fields: Array<Record<string, unknown>> = [];
              if (Array.isArray(questions)) {
                for (let i = 0; i < questions.length; i++) {
                  const q = questions[i]!;
                  const fieldId = String(i);
                  const fieldOptions = (q.options ?? []).map(opt => ({
                    value: opt.label, label: opt.label, description: opt.description,
                  }));
                  if (fieldOptions.length > 0 && fieldOptions.length < 4) {
                    fieldOptions.push({ value: "__other__", label: "Other", description: "Provide a custom answer" });
                  }
                  if (fieldOptions.length > 0) {
                    fields.push({ key: fieldId, label: q.header, description: q.question, type: q.multiSelect ? "multiSelect" : "segmented", variant: "cards", options: fieldOptions });
                    fields.push({ key: `${fieldId}_other`, label: "Please specify", type: "string", placeholder: "Enter your answer...", visibleWhen: q.multiSelect ? { field: fieldId, operator: "contains", value: "__other__" } : { field: fieldId, operator: "eq", value: "__other__" } });
                  } else {
                    fields.push({ key: fieldId, label: q.header || "Your response", description: q.question, type: "textarea", required: true });
                  }
                }
              } else {
                fields.push({ key: "0", label: "Your response", description: (toolInput["question"] as string) ?? "", type: "textarea", required: true });
              }

              const result = await this.deps.callMethod(feedbackProvider.participantId, "feedback_form", { title: "Claude needs your input", fields, values: {} });
              const feedbackResult = result as { type?: string; value?: Record<string, unknown> };

              if (feedbackResult.type === "cancel") {
                return { behavior: 'deny', message: 'User cancelled' };
              }

              // Map form values back to answers (resolve "Other" fields)
              const formValues = feedbackResult.value ?? {};
              const answers: Record<string, string> = {};
              for (const [key, value] of Object.entries(formValues)) {
                if (key.endsWith("_other")) continue;
                const otherValue = formValues[`${key}_other`];
                if (Array.isArray(value)) {
                  answers[key] = value.map((v: string) => v === "__other__" ? (typeof otherValue === "string" && otherValue ? otherValue : "Other") : v).join(", ");
                } else if (value === "__other__") {
                  answers[key] = typeof otherValue === "string" && otherValue ? otherValue : "Other";
                } else {
                  answers[key] = String(value);
                }
              }

              return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
            } catch (err) {
              return { behavior: 'deny', message: err instanceof Error ? err.message : String(err) };
            }
          }

          // All other approval decisions are made by the DO based on channel config.

          // Register the pending approval BEFORE emitting the event.
          // The DO may auto-approve synchronously during the emit() await,
          // sending approve-tool back before emit returns. If we registered
          // after emit, the approve-tool would find no pending entry and be
          // silently dropped — causing the turn to hang forever.
          const approvalPromise = new Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>((resolve) => {
            this.pendingApprovals.set(toolUseId, {
              resolve,
              toolName,
              input: toolInput,
            });
            // Clean up if the SDK aborts while waiting (e.g., interrupt, timeout)
            if (options.signal.aborted) {
              this.pendingApprovals.delete(toolUseId);
              resolve({ behavior: 'deny', message: 'Operation aborted' });
              return;
            }
            const onAbort = () => {
              if (this.pendingApprovals.has(toolUseId)) {
                this.pendingApprovals.delete(toolUseId);
                resolve({ behavior: 'deny', message: 'Operation aborted' });
              }
            };
            options.signal.addEventListener('abort', onAbort, { once: true });
          });

          await this.emit({
            type: 'approval-needed',
            toolUseId,
            toolName,
            input: toolInput,
          });

          return approvalPromise;
        },
      };

      // Create and run the query
      const queryInstance = sdk.query({
        prompt: input.content,
        options: queryOptions,
      });
      this.activeQuery = queryInstance;

      // Process stream events
      await this.processStream(queryInstance, abort.signal);

    } catch (err) {
      if (!abort.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        await this.pushError(message, 'ADAPTER_ERROR');
      }
    } finally {
      this.activeQuery = null;
      this.currentAbort = undefined;
      // Guarantee the DO always receives a turn-complete to advance its queue
      if (!this.turnCompleteEmitted) {
        await this.emit({
          type: 'turn-complete',
          sessionId: this.sessionId ?? '',
        });
      }
    }
  }

  /**
   * Interrupt the currently running turn.
   */
  private async interrupt(): Promise<void> {
    if (this.activeQuery?.interrupt) {
      try {
        await this.activeQuery.interrupt();
      } catch (err) {
        this.log('error', 'SDK query interrupt failed', err);
      }
    }
    this.currentAbort?.abort();
    // Reject any pending approvals — the tool calls are cancelled
    for (const [, pending] of this.pendingApprovals) {
      pending.resolve({ behavior: 'deny', message: 'Turn interrupted' });
    }
    this.pendingApprovals.clear();
  }

  /**
   * Fork the session at a specific message point.
   *
   * This sets the session ID and configures the next query to resume
   * with `forkSession: true` at the given point.
   */
  private async fork(forkPointMessageId: number, turnSessionId: string): Promise<void> {
    // Store the session to fork from — the next startTurn will use it
    this.sessionId = turnSessionId;
    this.log('info', `Fork requested at message ${forkPointMessageId}, will resume session ${turnSessionId} with fork`);
    // The actual fork happens on the next startTurn via the resume option
  }

  /**
   * Dispose the adapter and release resources.
   */
  private async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingTurns.length = 0;
    await this.interrupt();
    this.log('info', 'ClaudeSdkAdapter disposed');
  }

  // -------------------------------------------------------------------------
  // Stream processing
  // -------------------------------------------------------------------------

  /**
   * Process the async stream of SDK messages and emit HarnessOutput events.
   *
   * This is the core translation layer. It mirrors the event processing loop
   * in claudeAgentResponder.ts (lines ~1048-1266) but emits HarnessOutput
   * events instead of calling PubSub client methods.
   */
  private async processStream(
    queryInstance: AsyncGenerator<SdkMessage, void>,
    signal: AbortSignal,
  ): Promise<void> {
    /** Current active content block type (for tracking start/end) */
    let activeBlockType: 'thinking' | 'text' | null = null;

    /** Whether we received any stream_event messages (used to skip the
     *  assistant message fallback when streaming is active) */
    let hasStreamedContent = false;

    /** Tool input accumulators keyed by tool_use block ID */
    const toolInputAccumulators = new Map<string, ToolInputAccumulator>();

    /** ID of the tool_use block currently streaming input */
    let currentStreamingToolId: string | null = null;

    /** Subagent tool tracking — accumulates input for tool_use blocks in
     *  subagent events so they appear as action beads in the UI */
    const subagentToolAccumulators = new Map<string, ToolInputAccumulator>();
    let currentSubagentToolId: string | null = null;

    /** Session ID captured from messages */
    let capturedSessionId: string | undefined;

    for await (const message of queryInstance) {
      if (signal.aborted) break;

      // Capture session ID from any message that carries it.
      // Update this.sessionId eagerly so the fallback turn-complete in
      // runTurn's finally block has the correct session even on interrupt.
      const sdkMsg = message as SdkMessage;
      if (sdkMsg.session_id) {
        capturedSessionId = sdkMsg.session_id;
        this.sessionId = sdkMsg.session_id;
      }

      // ----- Subagent routing -----
      // Subagent events carry a parent_tool_use_id linking them to the
      // Agent/Task tool call that spawned the sub-session. We parse
      // tool_use blocks and emit action-start/action-end so they appear
      // as visible action beads in the UI alongside the parent's output.
      if (
        sdkMsg.parent_tool_use_id &&
        sdkMsg.type === 'stream_event' &&
        sdkMsg.event
      ) {
        const subEvent = sdkMsg.event;

        // Detect tool_use block start → begin accumulating input JSON
        if (subEvent.type === 'content_block_start' && subEvent.content_block?.type === 'tool_use') {
          const toolBlock = subEvent.content_block as { id: string; name: string };
          subagentToolAccumulators.set(toolBlock.id, {
            toolName: toolBlock.name,
            inputChunks: [],
          });
          currentSubagentToolId = toolBlock.id;
        }

        // Accumulate streamed tool input JSON
        if (subEvent.type === 'content_block_delta' && subEvent.delta?.type === 'input_json_delta') {
          if (currentSubagentToolId && subEvent.delta.partial_json) {
            const acc = subagentToolAccumulators.get(currentSubagentToolId);
            if (acc) acc.inputChunks.push(subEvent.delta.partial_json);
          }
        }

        // Tool_use block complete → emit action-start/action-end bead
        if (subEvent.type === 'content_block_stop' && currentSubagentToolId) {
          const toolId = currentSubagentToolId;
          const acc = subagentToolAccumulators.get(toolId);
          currentSubagentToolId = null;

          if (acc) {
            let description = acc.toolName;
            if (acc.inputChunks.length > 0) {
              try {
                const parsedInput = JSON.parse(acc.inputChunks.join('')) as Record<string, unknown>;
                description = buildToolDescription(acc.toolName, parsedInput);
              } catch {
                // JSON parse failed — use tool name as description
              }
            }

            await this.emit({
              type: 'action-start',
              tool: acc.toolName,
              description,
              toolUseId: toolId,
            });
            await this.emit({ type: 'action-end', toolUseId: toolId });
            subagentToolAccumulators.delete(toolId);
          }
        }

        continue;
      }

      // ----- Stream events (partial messages) -----
      if (message.type === 'stream_event' && sdkMsg.event) {
        hasStreamedContent = true;
        const streamEvent = sdkMsg.event;

        // --- Content block start ---
        if (streamEvent.type === 'content_block_start' && streamEvent.content_block) {
          const blockType = streamEvent.content_block.type;

          if (blockType === 'thinking') {
            // End any previous text block
            if (activeBlockType === 'text') {
              await this.emit({ type: 'text-end' });
            }
            activeBlockType = 'thinking';
            await this.emit({ type: 'thinking-start' });
          } else if (blockType === 'tool_use') {
            // End any previous content block
            if (activeBlockType === 'thinking') {
              await this.emit({ type: 'thinking-end' });
            } else if (activeBlockType === 'text') {
              await this.emit({ type: 'text-end' });
            }
            activeBlockType = null;

            const toolBlock = streamEvent.content_block as {
              type: 'tool_use';
              id: string;
              name: string;
            };
            toolInputAccumulators.set(toolBlock.id!, {
              toolName: toolBlock.name!,
              inputChunks: [],
            });
            currentStreamingToolId = toolBlock.id!;
          } else if (blockType === 'text') {
            // End any previous thinking block
            if (activeBlockType === 'thinking') {
              await this.emit({ type: 'thinking-end' });
            }
            activeBlockType = 'text';
            await this.emit({ type: 'text-start' });
          }
        }

        // --- Content block delta ---
        if (streamEvent.type === 'content_block_delta' && streamEvent.delta) {
          if (streamEvent.delta.type === 'thinking_delta' && streamEvent.delta.thinking) {
            await this.emit({
              type: 'thinking-delta',
              content: streamEvent.delta.thinking,
            });
          }

          if (streamEvent.delta.type === 'text_delta' && streamEvent.delta.text) {
            await this.emit({
              type: 'text-delta',
              content: streamEvent.delta.text,
            });
          }

          if (streamEvent.delta.type === 'input_json_delta' && streamEvent.delta.partial_json) {
            if (currentStreamingToolId) {
              const acc = toolInputAccumulators.get(currentStreamingToolId);
              if (acc) acc.inputChunks.push(streamEvent.delta.partial_json);
            }
          }
        }

        // --- Content block stop ---
        if (streamEvent.type === 'content_block_stop') {
          if (activeBlockType === 'thinking') {
            await this.emit({ type: 'thinking-end' });
            activeBlockType = null;
          }

          if (currentStreamingToolId) {
            const toolId = currentStreamingToolId;
            const acc = toolInputAccumulators.get(toolId);
            currentStreamingToolId = null;

            if (acc) {
              let description = acc.toolName;
              let parsedInput: Record<string, unknown> = {};

              if (acc.inputChunks.length > 0) {
                try {
                  parsedInput = JSON.parse(acc.inputChunks.join('')) as Record<string, unknown>;
                  // Build a readable description from the tool name and input
                  description = buildToolDescription(acc.toolName, parsedInput);
                } catch {
                  // JSON parse failed — use the tool name as description
                }
              }

              await this.emit({
                type: 'action-start',
                tool: acc.toolName,
                description,
                toolUseId: toolId,
              });

              toolInputAccumulators.delete(toolId);

              // Emit action-end immediately — the SDK handles tool execution
              // internally and we emit the action boundaries for UI display.
              await this.emit({ type: 'action-end', toolUseId: toolId });
            }
          }

          // If this was a text block ending (not a tool), close it
          if (activeBlockType === 'text') {
            await this.emit({ type: 'text-end' });
            activeBlockType = null;
          }
        }
      }

      // ----- Assistant message (non-streamed fallback) -----
      // When includePartialMessages is true and streaming occurred, text was
      // already emitted via stream_event. Only emit here as a fallback when
      // no stream events were received (e.g., SDK returned a cached response).
      if (message.type === 'assistant' && sdkMsg.message?.content && !hasStreamedContent) {
        const textBlocks = sdkMsg.message.content.filter(
          (block) => block.type === 'text' && block.text,
        );
        if (textBlocks.length > 0) {
          await this.emit({ type: 'text-start' });
          for (const block of textBlocks) {
            await this.emit({ type: 'text-delta', content: block.text! });
          }
          await this.emit({ type: 'text-end' });
        }

        await this.emit({ type: 'message-complete' });
      }

      // ----- Result message -----
      if (message.type === 'result') {
        // Close any dangling blocks
        if (activeBlockType === 'thinking') {
          await this.emit({ type: 'thinking-end' });
        } else if (activeBlockType === 'text') {
          await this.emit({ type: 'text-end' });
        }
        activeBlockType = null;

        const resultMsg = sdkMsg;
        if (resultMsg.subtype === 'success' && resultMsg.session_id) {
          capturedSessionId = resultMsg.session_id;
        }

        // Capture session ID
        if (capturedSessionId) {
          this.sessionId = capturedSessionId;
        }

        // Build usage info
        const usage = this.extractUsage(resultMsg);

        if (resultMsg.subtype === 'success') {
          await this.emit({
            type: 'turn-complete',
            sessionId: capturedSessionId ?? '',
            usage,
          });
          this.turnCompleteEmitted = true;
        } else {
          // Error result subtypes: error_during_execution, error_max_turns, etc.
          const errors = resultMsg.errors;
          const errorMessage = Array.isArray(errors) && errors.length > 0
            ? errors.join('; ')
            : `Query ended with ${resultMsg.subtype ?? 'error'}`;

          await this.emit({
            type: 'error',
            error: errorMessage,
            code: resultMsg.subtype,
          });

          // Still emit turn-complete with session ID for recovery
          if (capturedSessionId) {
            await this.emit({
              type: 'turn-complete',
              sessionId: capturedSessionId,
              usage,
            });
            this.turnCompleteEmitted = true;
          }
        }
      }
    }

    // If we exited the loop without a result (e.g. interrupt), ensure cleanup
    if (activeBlockType === 'thinking') {
      await this.emit({ type: 'thinking-end' });
    } else if (activeBlockType === 'text') {
      await this.emit({ type: 'text-end' });
    }
  }

  // -------------------------------------------------------------------------
  // MCP server construction
  // -------------------------------------------------------------------------

  /**
   * Build MCP servers from discovered channel methods.
   *
   * Mirrors the tool discovery and MCP server creation in
   * claudeAgentResponder.ts (lines ~818-939).
   */
  private async buildMcpServers(
    sdk: NonNullable<typeof this.sdkModule>,
  ): Promise<Record<string, unknown>> {
    const servers: Record<string, unknown> = {};

    try {
      let methods = await this.deps.discoverMethods();
      this.discoveredMethods = methods;

      // Apply toolAllowlist if configured — defense-in-depth filter that
      // prevents accidental tool exposure even if `internal` flags are missed.
      const allowlist = this.config.toolAllowlist;
      if (allowlist) {
        const allowSet = new Set(allowlist);
        const before = methods.length;
        methods = methods.filter((m) => allowSet.has(m.name));
        this.log('info', `Tool allowlist active: ${before} discovered → ${methods.length} allowed (allowlist: [${allowlist.join(', ')}])`);
      }

      if (methods.length === 0) {
        this.log('info', 'No channel methods discovered');
        return servers;
      }

      this.log('info', `Discovered ${methods.length} channel methods: [${methods.map(m => m.name).join(', ')}]`);

      const toolDefs = buildMcpToolDefinitions(methods, this.deps.callMethod, this.deps.log);

      // Convert to SDK MCP tools. The SDK's `tool()` expects a ZodRawShape
      // (object with Zod type values), not a JSON Schema object. We convert
      // the JSON Schema from discoverMethods → Zod using jsonSchemaToZodRawShape.
      const sdkTools = toolDefs.map((def) => {
        const zodShape = jsonSchemaToZodRawShape(def.parameters);
        this.log('info', `Creating MCP tool: ${def.name} (properties: ${Object.keys(zodShape).join(', ') || 'none'})`);
        return sdk.tool(
          def.name,
          def.description,
          zodShape,
          async (args: unknown) => def.execute(args as Record<string, unknown>),
        );
      });

      if (sdkTools.length > 0) {
        servers['workspace'] = sdk.createSdkMcpServer({
          name: 'workspace',
          version: '1.0.0',
          tools: sdkTools,
        });
      }
    } catch (err) {
      this.log('error', 'Failed to build MCP servers from channel methods', err);
    }

    return servers;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Resolve the model to use, preferring per-turn settings over config */
  private resolveModel(settings?: HarnessSettings): string | undefined {
    return settings?.model ?? this.config.model;
  }

  /** Extract usage metrics from an SDK result message */
  private extractUsage(resultMsg: SdkMessage): TurnUsage | undefined {
    if (!resultMsg.usage) return undefined;

    const u = resultMsg.usage;
    return {
      inputTokens: u['input_tokens'] ?? 0,
      outputTokens: u['output_tokens'] ?? 0,
      cacheReadTokens: u['cache_read_input_tokens'],
      cacheWriteTokens: u['cache_creation_input_tokens'],
    };
  }

  /** Emit an error event */
  private async emit(event: HarnessOutput): Promise<void> {
    await this.deps.pushEvent(event);
  }

  /** Emit an error event */
  private async pushError(message: string, code?: string): Promise<void> {
    await this.emit({ type: 'error', error: message, code });
  }

  /** Log at the given level using the injected logger */
  private log(level: 'info' | 'error' | 'debug', ...args: unknown[]): void {
    const logger = this.deps.log;
    if (!logger) return;

    if (level === 'debug' && logger.debug) {
      logger.debug(...args);
    } else if (level === 'error') {
      logger.error(...args);
    } else if (level === 'info') {
      logger.info(...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Build a human-readable description for a tool action.
 *
 * A simplified tool description builder. A richer version can be injected
 * via adapter config if needed.
 */
function buildToolDescription(toolName: string, input: Record<string, unknown>): string {
  // Common tool name → description patterns
  switch (toolName) {
    case 'Read':
    case 'FileRead':
      return input['file_path'] ? `Reading ${input['file_path']}` : `Reading file`;
    case 'Edit':
    case 'FileEdit':
      return input['file_path'] ? `Editing ${input['file_path']}` : `Editing file`;
    case 'Write':
    case 'FileWrite':
      return input['file_path'] ? `Writing ${input['file_path']}` : `Writing file`;
    case 'Bash':
      return input['command'] ? `Running: ${truncate(String(input['command']), 80)}` : `Running command`;
    case 'Glob':
      return input['pattern'] ? `Searching: ${input['pattern']}` : `File search`;
    case 'Grep':
      return input['pattern'] ? `Searching for: ${truncate(String(input['pattern']), 60)}` : `Content search`;
    case 'Task':
    case 'Agent':
      return input['description'] ? `Subagent: ${truncate(String(input['description']), 60)}` : `Running subagent`;
    case 'TodoWrite':
      return 'Updating task list';
    default:
      // Prettify: "my_tool_name" → "My Tool Name"
      return toolName.replace(/([_-])/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Truncate a string to maxLen, adding "..." if truncated */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
