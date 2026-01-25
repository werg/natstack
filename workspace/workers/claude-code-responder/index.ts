/**
 * Claude Code Responder Worker
 *
 * An unsafe worker that uses the Claude Agent SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Claude.
 */

import { execSync } from "child_process";
import { readdir, stat, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { pubsubConfig, id, contextId, getStateArgs } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  createLogger,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  formatMissedContext,
  showPermissionPrompt,
  validateRestrictedMode,
  getCanonicalToolName,
  createThinkingTracker,
  createActionTracker,
  createTypingTracker,
  getDetailedActionDescription,
  needsApprovalForTool,
  CONTENT_TYPE_TYPING,
  // Image processing utilities
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  type Attachment,
  type AgenticClient,
  type AgentSDKToolDefinition,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import {
  CLAUDE_CODE_PARAMETERS,
  CLAUDE_MODEL_FALLBACKS,
} from "@natstack/agentic-messaging/config";
import { z } from "zod";

// =============================================================================
// Bounded Image Cache - LRU eviction with count and memory limits
// =============================================================================

/** Maximum number of historical images to keep in memory */
const MAX_HISTORICAL_IMAGES = 20;
/** Maximum total bytes of image data to keep in memory (100MB) */
const MAX_IMAGE_MEMORY_BYTES = 100 * 1024 * 1024;

/**
 * A bounded cache for image attachments with LRU eviction.
 * Enforces both count and memory limits to prevent unbounded memory usage.
 */
class BoundedImageCache {
  private cache = new Map<string, Attachment>();
  private accessOrder: string[] = []; // Most recently accessed at end
  private totalBytes = 0;

  constructor(
    private maxCount: number = MAX_HISTORICAL_IMAGES,
    private maxBytes: number = MAX_IMAGE_MEMORY_BYTES
  ) {}

  /**
   * Add or update an image in the cache.
   * May evict older images to stay within limits.
   */
  set(id: string, attachment: Attachment): void {
    // If already exists, remove old entry first (will be re-added as most recent)
    if (this.cache.has(id)) {
      const existing = this.cache.get(id)!;
      this.totalBytes -= existing.data.length;
      this.accessOrder = this.accessOrder.filter((i) => i !== id);
    }

    // Check if this single image exceeds memory limit - skip if so
    if (attachment.data.length > this.maxBytes) {
      return; // Don't cache images larger than the entire limit
    }

    // Evict oldest entries until we have room
    while (
      this.accessOrder.length > 0 &&
      (this.cache.size >= this.maxCount ||
        this.totalBytes + attachment.data.length > this.maxBytes)
    ) {
      const oldestId = this.accessOrder.shift()!;
      const oldest = this.cache.get(oldestId);
      if (oldest) {
        this.totalBytes -= oldest.data.length;
        this.cache.delete(oldestId);
      }
    }

    // Add the new entry
    this.cache.set(id, attachment);
    this.accessOrder.push(id);
    this.totalBytes += attachment.data.length;
  }

  /**
   * Get an image from the cache (also updates access order for LRU).
   */
  get(id: string): Attachment | undefined {
    const attachment = this.cache.get(id);
    if (attachment) {
      // Move to end of access order (most recently used)
      this.accessOrder = this.accessOrder.filter((i) => i !== id);
      this.accessOrder.push(id);
    }
    return attachment;
  }

  /**
   * Check if an image exists in the cache.
   */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /**
   * Get all entries as an iterator (does not update access order).
   */
  entries(): IterableIterator<[string, Attachment]> {
    return this.cache.entries();
  }

  /**
   * Get the number of images in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get the total bytes of image data in the cache.
   */
  get bytes(): number {
    return this.totalBytes;
  }
}
import { query, tool, createSdkMcpServer, type Query, type SDKResultMessage, type CanUseTool, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Find an executable in the system PATH.
 * Cross-platform: uses `where` on Windows, `which` on Unix-like systems.
 */
function findExecutable(name: string): string | undefined {
  const isWindows = process.platform === "win32";
  const command = isWindows ? `where ${name}` : `which ${name}`;

  try {
    const result = execSync(command, { encoding: "utf-8" }).trim();
    // `where` on Windows may return multiple lines; take the first one
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the most recently modified plan file in ~/.claude/plans/
 * Used as a heuristic to find the current plan when ExitPlanMode is called.
 */
async function findMostRecentPlanFile(): Promise<string | null> {
  const plansDir = join(homedir(), ".claude", "plans");
  try {
    const files = await readdir(plansDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    if (mdFiles.length === 0) return null;

    const fileStats = await Promise.all(
      mdFiles.map(async (f) => {
        const filePath = join(plansDir, f);
        const stats = await stat(filePath);
        return { path: filePath, mtime: stats.mtime };
      })
    );

    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return fileStats[0]?.path ?? null;
  } catch {
    return null;
  }
}

/** Type for SDK's AskUserQuestion question structure */
interface AskUserQuestionQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

const log = createLogger("Claude Code", id);

/**
 * Get a human-readable description for a tool action.
 */
function getActionDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    Read: "Reading file",
    Write: "Writing file",
    Edit: "Editing file",
    Bash: "Running command",
    Glob: "Searching for files",
    Grep: "Searching file contents",
    WebSearch: "Searching the web",
    WebFetch: "Fetching web content",
    Task: "Delegating to subagent",
    TodoWrite: "Updating task list",
    AskUserQuestion: "Asking user",
  };
  return descriptions[toolName] ?? `Using ${toolName}`;
}

/**
 * StateArgs passed at spawn time via createChild().
 * Defined in package.json stateArgs schema.
 */
interface ClaudeCodeStateArgs {
  channel: string;
  handle?: string;
  model?: string;
  maxThinkingTokens?: number;
  executionMode?: "plan" | "edit";
  autonomyLevel?: number; // 0=Ask, 1=Auto-edits, 2=Full Auto
  // Channel config values passed via stateArgs to avoid timing issues
  // (workers may connect before chat panel sets channelConfig)
  workingDirectory?: string;
  restrictedMode?: boolean;
}

/** Worker-local settings interface (runtime-adjustable) */
interface ClaudeCodeWorkerSettings {
  model?: string;
  maxThinkingTokens?: number;
  executionMode?: "plan" | "edit";
  autonomyLevel?: number; // 0=Ask, 1=Auto-edits, 2=Full Auto
  /** Whether we've shown at least one approval prompt (for first-time grant UI) */
  hasShownApprovalPrompt?: boolean;
}

// =============================================================================
// Message Queue - Producer-Consumer Pattern for Message Interleaving
// =============================================================================

/** A queued message waiting to be processed */
interface QueuedMessage {
  event: IncomingNewMessage;
  prompt: string;
  attachments?: Attachment[];
  enqueuedAt: number;
  typingTracker: ReturnType<typeof createTypingTracker> | null;
}

/** Current processing state shared between observer and processor */
interface ProcessingState {
  currentMessage: QueuedMessage | null;
  queryInstance: Query | null;
}

/**
 * AsyncQueue - A bidirectional buffer supporting both push (producer) and async iteration (consumer).
 * Based on the pattern from agentic-messaging/src/client.ts
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as T, done: true });
    }
    this.resolvers = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

/**
 * MessageQueue - FIFO queue with inspection capability for managing queued messages.
 * Allows both async iteration (for processor) and inspection (for queue position tracking).
 */
class MessageQueue implements AsyncIterable<QueuedMessage> {
  private queue = new AsyncQueue<QueuedMessage>();
  private _pending: QueuedMessage[] = [];

  enqueue(msg: QueuedMessage): void {
    this._pending.push(msg);
    this.queue.push(msg);
  }

  dequeue(): void {
    this._pending.shift();
  }

  get pending(): readonly QueuedMessage[] {
    return this._pending;
  }

  close(): void {
    this.queue.close();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<QueuedMessage> {
    return this.queue[Symbol.asyncIterator]();
  }
}

/** Current settings state - initialized from agent config and persisted settings */
let currentSettings: ClaudeCodeWorkerSettings = {};

/** Reference to the current query instance for model discovery */
let activeQueryInstance: Query | null = null;

/**
 * Worker-local fallback for SDK session ID.
 * Used when client.sessionKey is unavailable (workspaceId not set),
 * allowing session resumption within the same worker lifetime.
 */
let localSdkSessionId: string | undefined;

// =============================================================================
// Observer (Producer) - Non-blocking message observation and queuing
// =============================================================================

/**
 * Observe incoming messages and enqueue them with immediate acknowledgment.
 * This runs as a background task, never blocking on message processing.
 */
async function observeMessages(
  client: AgenticClient<ChatParticipantMetadata>,
  queue: MessageQueue,
  state: ProcessingState
): Promise<void> {
  for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
    // Quick filtering (same as original)
    if (event.type !== "message") continue;
    if (event.kind === "replay") continue;
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) continue;

    const sender = client.roster[event.senderId];
    if (sender?.metadata.type !== "panel" || event.senderId === id) continue;

    // Calculate queue position for typing context
    const queuePosition = queue.pending.length;
    const typingContext = state.currentMessage
      ? (queuePosition === 0 ? "queued, waiting..." : `queued (position ${queuePosition + 1})`)
      : "preparing response";

    // Create typing indicator immediately
    const typing = createTypingTracker({
      client,
      log,
      replyTo: event.id,
      senderInfo: {
        senderId: client.clientId ?? "",
        senderName: "Claude Code",
        senderType: "claude-code",
      },
    });
    await typing.startTyping(typingContext);

    // Enqueue the message
    queue.enqueue({
      event: event as IncomingNewMessage,
      prompt: event.content,
      attachments: (event as { attachments?: Attachment[] }).attachments,
      enqueuedAt: Date.now(),
      typingTracker: typing,
    });

    log(`Message queued: ${event.content.slice(0, 50)}... (position ${queuePosition + 1})`);
  }
}

// =============================================================================
// Processor (Consumer) - Sequential message processing from queue
// =============================================================================

/**
 * Process messages from the queue sequentially.
 * Updates queue position indicators for waiting messages.
 */
async function processMessages(
  client: AgenticClient<ChatParticipantMetadata>,
  queue: MessageQueue,
  state: ProcessingState,
  workingDirectory: string | undefined,
  claudeExecutable: string,
  isRestrictedMode: boolean,
  getMissedContext: () => { formatted: string; lastPubsubId: number } | null,
  updateLastMissedPubsubId: (id: number) => void
): Promise<void> {
  for await (const queuedMessage of queue) {
    state.currentMessage = queuedMessage;
    queue.dequeue();

    log(`Processing message: ${queuedMessage.event.content.slice(0, 50)}...`);

    // Update queue position indicators for remaining messages
    for (let i = 0; i < queue.pending.length; i++) {
      const msg = queue.pending[i];
      if (msg.typingTracker) {
        // startTyping automatically stops previous indicator
        await msg.typingTracker.startTyping(
          i === 0 ? "queued, waiting..." : `queued (position ${i + 1})`
        );
      }
    }

    try {
      // Apply missed context if available
      let prompt = queuedMessage.prompt;
      const missed = getMissedContext();
      if (missed) {
        prompt = `<missed_context>\n${missed.formatted}\n</missed_context>\n\n${prompt}`;
        updateLastMissedPubsubId(missed.lastPubsubId);
      }

      await handleUserMessage(
        client,
        queuedMessage.event,
        prompt,
        workingDirectory,
        claudeExecutable,
        isRestrictedMode,
        queuedMessage.attachments,
        queuedMessage.typingTracker ?? undefined
      );
    } finally {
      state.currentMessage = null;
    }
  }
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get stateArgs passed at spawn time
  const stateArgs = getStateArgs<ClaudeCodeStateArgs>();
  const channelName = stateArgs.channel;
  const handle = stateArgs.handle ?? "claude";

  if (!channelName) {
    console.error("No channel specified in stateArgs");
    return;
  }

  log("Starting Claude Code responder...");

  // Find the claude executable path for the SDK
  const claudeExecutable = findExecutable("claude");
  if (!claudeExecutable) {
    console.error("Claude Code CLI not found in PATH. Please install claude-code.");
    return;
  }
  log(`Claude executable: ${claudeExecutable}`);
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel
  // contextId is obtained automatically from the server's ready message
  log(`Connecting to channel ${channelName} at ${pubsubConfig.serverUrl}...`);
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "Claude Code",
    type: "claude-code",
    reconnect: true,
    // Enable session persistence for SDK session resumption across worker reloads
    workspaceId: contextId || undefined,
    methods: {
      pause: createPauseMethodDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
      settings: {
        description: "Configure Claude Code settings",
        parameters: z.object({}),
        menu: true,
        execute: async () => {
          // Find the chat panel participant
          const panel = Object.values(client.roster).find(
            (p) => p.metadata.type === "panel"
          );
          if (!panel) throw new Error("No panel found");

          // Fetch models dynamically from SDK if we have an active query
          let modelOptions: Array<{ value: string; label: string }> = [];
          try {
            if (activeQueryInstance) {
              const sdkModels = await activeQueryInstance.supportedModels();
              modelOptions = sdkModels.map((m) => ({ value: m.value, label: m.displayName }));
            }
          } catch (err) {
            log(`Failed to fetch models: ${err}`);
          }

          // Fallback to known Claude models if dynamic discovery unavailable
          if (modelOptions.length === 0) {
            modelOptions = CLAUDE_MODEL_FALLBACKS;
          }

          // Build fields with dynamic model options
          const fields = CLAUDE_CODE_PARAMETERS
            .filter((p) => p.key !== "workingDirectory") // workingDirectory is set at init only
            .map((f) => {
              // Override model options with dynamic list if available
              if (f.key === "model" && modelOptions.length > 0) {
                return { ...f, options: modelOptions };
              }
              return f;
            });

          // Call feedback_form on the panel
          const handle = client.callMethod(panel.id, "feedback_form", {
            title: "Claude Code Settings",
            fields,
            values: currentSettings,
          });
          const result = await handle.result;
          const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

          // Handle the three cases: submit, cancel, error
          if (feedbackResult.type === "cancel") {
            log("Settings cancelled");
            return { success: false, cancelled: true };
          }

          if (feedbackResult.type === "error") {
            log(`Settings error: ${feedbackResult.message}`);
            return { success: false, error: feedbackResult.message };
          }

          // Apply new settings (submit case)
          const newSettings = feedbackResult.value as ClaudeCodeWorkerSettings;
          Object.assign(currentSettings, newSettings);
          log(`Settings updated: ${JSON.stringify(currentSettings)}`);

          // Persist settings if session is available
          if (client.sessionKey) {
            try {
              await client.updateSettings(currentSettings);
            } catch (err) {
              log(`Failed to persist settings: ${err}`);
            }
          }

          return { success: true, settings: currentSettings };
        },
      },
    },
  });

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  log(`Connected to channel: ${channelName}`);

  // Get channel config - prefer stateArgs (reliable) over channelConfig (may be empty due to timing)
  // Workers may connect before chat panel and create channel without config
  const channelConfigWorkingDirectory = client.channelConfig?.workingDirectory;
  const channelConfigRestrictedMode = client.channelConfig?.restrictedMode;
  const workingDirectory = stateArgs.workingDirectory?.trim() || channelConfigWorkingDirectory?.trim() || process.env["NATSTACK_WORKSPACE"];
  const restrictedMode = stateArgs.restrictedMode ?? channelConfigRestrictedMode;

  if (workingDirectory) {
    log(`Working directory: ${workingDirectory}`);
  }
  if (restrictedMode) {
    log(`Restricted mode: enabled`);
  }

  // Initialize settings with proper precedence:
  // 1. Apply initialization config (from stateArgs passed at spawn time)
  const initConfigSettings: ClaudeCodeWorkerSettings = {};
  if (stateArgs.model) initConfigSettings.model = stateArgs.model;
  if (stateArgs.maxThinkingTokens !== undefined) initConfigSettings.maxThinkingTokens = stateArgs.maxThinkingTokens;
  if (stateArgs.executionMode) initConfigSettings.executionMode = stateArgs.executionMode;
  if (stateArgs.autonomyLevel !== undefined) initConfigSettings.autonomyLevel = stateArgs.autonomyLevel;
  Object.assign(currentSettings, initConfigSettings);
  if (Object.keys(initConfigSettings).length > 0) {
    log(`Applied init config: ${JSON.stringify(initConfigSettings)}`);
  }

  // 2. Apply persisted settings (runtime changes from previous sessions)
  if (client.sessionKey) {
    log(`Session persistence enabled: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}, SDK session: ${client.sdkSessionId ?? "none"}`);
    // Initialize local fallback from persisted session
    if (client.sdkSessionId) {
      localSdkSessionId = client.sdkSessionId;
    }

    try {
      const savedSettings = await client.getSettings<ClaudeCodeWorkerSettings>();
      if (savedSettings) {
        Object.assign(currentSettings, savedSettings);
        log(`Applied persisted settings: ${JSON.stringify(savedSettings)}`);
      }
    } catch (err) {
      log(`Failed to load settings: ${err}`);
    }
  } else {
    log(`Session persistence disabled (no contextId available)`);
  }

  if (Object.keys(currentSettings).length > 0) {
    log(`Final settings: ${JSON.stringify(currentSettings)}`);
  }

  // Validate required methods in restricted mode (from channel config)
  if (restrictedMode) {
    await validateRestrictedMode(client, log);
  }

  let lastMissedPubsubId = 0;
  const buildMissedContext = () => {
    const missed = client.missedMessages.filter((event) => event.pubsubId > lastMissedPubsubId);
    if (missed.length === 0) return null;
    return formatMissedContext(missed, { maxChars: DEFAULT_MISSED_CONTEXT_MAX_CHARS });
  };

  let pendingMissedContext = buildMissedContext();

  client.onReconnect(() => {
    pendingMissedContext = buildMissedContext();
  });

  // =============================================================================
  // Producer-Consumer Pattern for Message Interleaving
  // =============================================================================
  // - Observer (producer): Non-blocking loop that immediately acknowledges messages
  // - Processor (consumer): Sequential processing loop
  // This allows new messages to be observed and acknowledged while processing others.

  const messageQueue = new MessageQueue();
  const processingState: ProcessingState = { currentMessage: null, queryInstance: null };

  // Start observer in background (fire-and-forget)
  // This continuously observes messages and enqueues them with immediate typing indicators
  void observeMessages(client, messageQueue, processingState);

  // Start processor (blocks until queue closes)
  // This processes messages sequentially from the queue
  await processMessages(
    client,
    messageQueue,
    processingState,
    workingDirectory,
    claudeExecutable,
    restrictedMode ?? false,
    () => {
      // Get missed context if available
      if (!pendingMissedContext || pendingMissedContext.count === 0) return null;
      const result = { formatted: pendingMissedContext.formatted, lastPubsubId: pendingMissedContext.lastPubsubId };
      pendingMissedContext = null;
      return result;
    },
    (id) => {
      lastMissedPubsubId = id;
    }
  );
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  workingDirectory: string | undefined,
  claudeExecutable: string,
  isRestrictedMode: boolean,
  attachments?: Attachment[],
  existingTypingTracker?: ReturnType<typeof createTypingTracker>
) {
  log(`Received message: ${incoming.content}`);

  // Collect ALL image attachments: historical (from replay) + current message
  // This allows Claude to access images from earlier in the conversation
  // Uses BoundedImageCache for LRU eviction to prevent unbounded memory growth
  const allImageAttachments = new BoundedImageCache();

  // 1. Collect historical attachments from replay/missed messages
  for (const msg of client.missedMessages) {
    const msgAttachments = (msg as { attachments?: Attachment[] }).attachments;
    if (msgAttachments) {
      for (const a of filterImageAttachments(msgAttachments)) {
        allImageAttachments.set(a.id, a);
      }
    }
  }

  // 2. Add current message attachments (these take precedence if IDs conflict)
  const currentImageAttachments = filterImageAttachments(attachments);
  for (const a of currentImageAttachments) {
    allImageAttachments.set(a.id, a);
  }

  if (currentImageAttachments.length > 0) {
    // Validate current message attachments
    const validation = validateAttachments(currentImageAttachments);
    if (!validation.valid) {
      log(`Attachment validation failed: ${validation.error}`);
      // Still proceed but warn - don't block the message
    }
    log(`Processing ${currentImageAttachments.length} new image attachment(s), ${allImageAttachments.size} total in cache (${(allImageAttachments.bytes / 1024 / 1024).toFixed(1)}MB)`);
  } else if (allImageAttachments.size > 0) {
    log(`${allImageAttachments.size} historical image attachment(s) in cache (${(allImageAttachments.bytes / 1024 / 1024).toFixed(1)}MB)`);
  }

  // NOTE: The Claude Agent SDK's query() only accepts string prompts, not content blocks.
  // Passing content blocks causes the CLI to crash. Instead, we use an MCP tool to deliver images.
  // When images are attached, we add a note to the prompt telling Claude to call the tool.

  // Create typing tracker for ephemeral "typing..." indicator
  // Shows immediately until first thinking/action/text appears
  // If an existing tracker was passed (from message queue), reuse it
  const typing = existingTypingTracker ?? createTypingTracker({
    client,
    log,
    replyTo: incoming.id,
    senderInfo: {
      senderId: client.clientId ?? "",
      senderName: "Claude Code",
      senderType: "claude-code",
    },
  });

  // Start/update typing indicator - if existing tracker was passed, update context
  // Otherwise start fresh
  await typing.startTyping("preparing response");

  // Defer creating the response message until we have text content
  // This avoids creating empty messages that pollute the chat
  let responseId: string | null = null;
  const ensureResponseMessage = async (): Promise<string> => {
    // Stop typing indicator when we start producing actual content
    if (typing.isTyping()) {
      await typing.stopTyping();
    }
    if (!responseId) {
      const { messageId } = await client.send("", { replyTo: incoming.id });
      responseId = messageId;
      log(`Created response message: ${responseId}`);
    }
    return responseId;
  };

  // Helper to stop typing when thinking/action starts
  const stopTypingIfNeeded = async () => {
    if (typing.isTyping()) {
      await typing.stopTyping();
    }
  };

  // Create thinking tracker for managing thinking/reasoning message state
  // Defined before try block so cleanup can be called in catch
  const thinking = createThinkingTracker({ client, log, replyTo: incoming.id });

  // Create action tracker for managing action message state (tool use indicators)
  const action = createActionTracker({ client, log, replyTo: incoming.id });

  // Keep reference to the query for interrupt handling via RPC pause mechanism
  let queryInstance: Query | null = null;

  // Set up RPC pause handler - monitors for pause tool calls
  // Declared outside try so we can clean it up in both success and error cases
  const interruptHandler = createInterruptHandler({
    client,
    messageId: incoming.id,
    onPause: async (reason) => {
      log(`Pause RPC received: ${reason}`);
      // Interrupt the SDK query to stop it gracefully
      // queryInstance is assigned later but captured via closure
      if (queryInstance) {
        try {
          await queryInstance.interrupt();
          log("SDK query interrupted successfully");
        } catch (err) {
          // Interrupt may fail if query already completed - that's ok
          log(`SDK query interrupt failed (may have already completed): ${err}`);
        }
      }
    }
  });

  try {
    // Start monitoring for pause events in background
    void interruptHandler.monitor();

    // In restricted mode: Create tools from pubsub participants and expose via MCP
    // In unrestricted mode: Use SDK's native tools (no pubsub tools)
    let pubsubServer: ReturnType<typeof createSdkMcpServer> | undefined;
    let allowedTools: string[] = [];

    if (isRestrictedMode) {
      // Create tools from other pubsub participants
      const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
        namePrefix: "pubsub",
      });

      log(`Discovered ${toolDefs.length} tools from pubsub participants (restricted mode)`);

      // Convert pubsub tools to Claude Agent SDK MCP tools
      // Use canonical names (Read, Write, Edit, etc.) for LLM familiarity
      const mcpServerName = "workspace";

      const mcpTools = toolDefs.map((toolDef: AgentSDKToolDefinition) => {
        // Use canonical name for display (e.g., file_read -> Read)
        const displayName = getCanonicalToolName(toolDef.originalMethodName);

        return tool(
          displayName,
          toolDef.description ?? "",
          jsonSchemaToZodRawShape(toolDef.parameters),
          async (args: unknown) => {
            log(`Tool call: ${displayName} args=${formatArgsForLog(args)}`);
            // Use the original prefixed name for execution (required by executeTool)
            const result = await executeTool(toolDef.name, args);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          }
        );
      });

      // Create MCP server with pubsub tools
      pubsubServer = createSdkMcpServer({
        name: mcpServerName,
        version: "1.0.0",
        tools: mcpTools,
      });

      // Determine allowed tools for restricted mode
      allowedTools = mcpTools.map((t) => `mcp__${mcpServerName}__${t.name}`);
    } else {
      log("Unrestricted mode - using SDK native tools");
    }

    // Create MCP server for image attachments (works in both restricted and unrestricted modes)
    // The Claude Agent SDK's query() only accepts string prompts, not content blocks.
    // We deliver images via MCP tools that Claude can call to view attachments.
    let attachmentsMcpServer: ReturnType<typeof createSdkMcpServer> | undefined;

    if (allImageAttachments.size > 0) {
      // Tool to list all available images with their IDs
      const listImagesTool = tool(
        "list_images",
        "List all available images in the conversation. Returns image IDs that can be used with get_image to view specific images.",
        {},
        async () => {
          const imageList = Array.from(allImageAttachments.entries()).map(([id, a]) => ({
            id,
            mimeType: a.mimeType,
            name: a.name,
            size: a.data.length,
          }));
          log(`list_images called - ${imageList.length} image(s) available`);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ images: imageList }, null, 2),
            }],
          };
        }
      );

      // Tool to get a specific image by ID
      const getImageTool = tool(
        "get_image",
        "View a specific image by its ID. Use list_images first to see available image IDs.",
        { image_id: z.string().describe("The image ID (e.g., 'img_1', 'img_2')") },
        async ({ image_id }: { image_id: string }) => {
          const attachment = allImageAttachments.get(image_id);
          if (!attachment) {
            log(`get_image called with invalid ID: ${image_id}`);
            return {
              content: [{
                type: "text" as const,
                text: `Error: Image with ID "${image_id}" not found. Use list_images to see available images.`,
              }],
            };
          }
          log(`get_image called - returning image ${image_id}`);
          return {
            content: [{
              type: "image" as const,
              data: uint8ArrayToBase64(attachment.data),
              mimeType: attachment.mimeType,
            }],
          };
        }
      );

      // Tool to get all images from the current message
      const getCurrentImagesTools = tool(
        "get_current_images",
        "View all images attached to the current user message (the message you're responding to now).",
        {},
        async () => {
          if (currentImageAttachments.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: "No images were attached to the current message.",
              }],
            };
          }
          log(`get_current_images called - returning ${currentImageAttachments.length} image(s)`);
          return {
            content: currentImageAttachments.map((a: Attachment) => ({
              type: "image" as const,
              data: uint8ArrayToBase64(a.data),
              mimeType: a.mimeType,
            })),
          };
        }
      );

      attachmentsMcpServer = createSdkMcpServer({
        name: "attachments",
        version: "1.0.0",
        tools: [listImagesTool, getImageTool, getCurrentImagesTools],
      });

      log(`Created attachments MCP server with ${allImageAttachments.size} image(s) available`);
    }

    // Build the final prompt - add note about images if present
    const promptWithImageNote = currentImageAttachments.length > 0
      ? `${prompt}\n\n[${currentImageAttachments.length} image(s) attached to this message. Call get_current_images to view them, or list_images to see all available images in the conversation.]`
      : allImageAttachments.size > 0
        ? `${prompt}\n\n[${allImageAttachments.size} historical image(s) available from earlier in the conversation. Call list_images to see them.]`
        : prompt;

    // Create permission handler that prompts user via feedback_form
    // Respects autonomy settings: only shows prompt if approval is actually needed
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      log(`Permission requested for tool: ${toolName}`);

      // =========================================
      // SPECIAL HANDLING: AskUserQuestion
      // =========================================
      // The SDK's built-in AskUserQuestion tool expects us to populate the
      // `answers` field. We show our feedback_form UI and return the answers
      // via updatedInput. This avoids the double-UI problem.
      if (toolName === "AskUserQuestion") {
        const panel = Object.values(client.roster).find(
          (p) => p.metadata.type === "panel"
        );

        if (!panel) {
          return {
            behavior: "deny" as const,
            message: "No panel available to show questions",
            toolUseID: options.toolUseID,
          };
        }

        // Transform SDK question format to feedback_form fields
        const questions = (input as { questions: AskUserQuestionQuestion[] }).questions;
        const fields: Array<{
          key: string;
          label?: string;
          description?: string;
          type: string;
          variant?: "buttons" | "cards" | "list";
          options?: Array<{ value: string; label: string; description?: string }>;
          visibleWhen?: { field: string; operator: string; value: string };
          placeholder?: string;
        }> = [];

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i]!;
          const fieldId = String(i);
          const fieldOptions = q.options.map((opt) => ({
            value: opt.label,
            label: opt.label,
            description: opt.description,
          }));
          // Add "Other" option for free-text input
          fieldOptions.push({
            value: "__other__",
            label: "Other",
            description: "Provide a custom answer",
          });

          if (q.multiSelect) {
            fields.push({
              key: fieldId,
              label: q.header,
              description: q.question,
              type: "multiSelect",
              variant: "cards",
              options: fieldOptions,
            });
          } else {
            fields.push({
              key: fieldId,
              label: q.header,
              description: q.question,
              type: "segmented",
              variant: "cards",
              options: fieldOptions,
            });
          }

          // Conditional text field for "Other" option
          fields.push({
            key: `${fieldId}_other`,
            label: "Please specify",
            type: "string",
            placeholder: "Enter your answer...",
            visibleWhen: q.multiSelect
              ? { field: fieldId, operator: "contains", value: "__other__" }
              : { field: fieldId, operator: "eq", value: "__other__" },
          });
        }

        // Show feedback_form and wait for user response
        try {
          const handle = client.callMethod(panel.id, "feedback_form", {
            title: "Claude needs your input",
            fields,
            values: {},
          });
          const result = await handle.result;
          const feedbackResult = result.content as { type: string; value?: Record<string, unknown>; message?: string };

          if (feedbackResult.type === "cancel") {
            return {
              behavior: "deny" as const,
              message: "User cancelled the question",
              interrupt: true,
              toolUseID: options.toolUseID,
            };
          }

          // Extract answers from form result
          // Form returns { "0": "selected option", "1": ["multi", "select"], ... }
          const formValues = feedbackResult.value as Record<string, string | string[]>;
          const answers: Record<string, string> = {};

          for (const [key, value] of Object.entries(formValues ?? {})) {
            // Skip the _other fields - we handle them with the main field
            if (key.endsWith("_other")) continue;

            const otherKey = `${key}_other`;
            const otherValue = formValues?.[otherKey];

            if (Array.isArray(value)) {
              // multiSelect - handle __other__
              // Replace __other__ with the custom text, or "Other" if no text provided
              const processed = value.map((v) =>
                v === "__other__"
                  ? (typeof otherValue === "string" && otherValue ? otherValue : "Other")
                  : v
              );
              answers[key] = processed.join(", ");
            } else if (value === "__other__") {
              // User selected "Other" - use the text field
              answers[key] = typeof otherValue === "string" && otherValue
                ? otherValue
                : "Other";
            } else {
              answers[key] = value;
            }
          }

          log(`AskUserQuestion answered: ${JSON.stringify(answers)}`);

          // Return allow with answers populated
          return {
            behavior: "allow" as const,
            updatedInput: { ...input, answers },
            toolUseID: options.toolUseID,
          };
        } catch (err) {
          log(`AskUserQuestion failed: ${err}`);
          return {
            behavior: "deny" as const,
            message: `Failed to show question form: ${err instanceof Error ? err.message : String(err)}`,
            toolUseID: options.toolUseID,
          };
        }
      }

      // =========================================
      // SPECIAL HANDLING: ExitPlanMode
      // =========================================
      // Read the plan file and include its content in the tool input
      // so the UI can display it.
      if (toolName === "ExitPlanMode") {
        let planFilePath = (input as Record<string, unknown>).planFilePath as string | undefined;

        // If SDK didn't provide path, find most recently modified plan file
        if (!planFilePath) {
          planFilePath = await findMostRecentPlanFile() ?? undefined;
        }

        // Read plan content if we have a path
        let plan: string | undefined;
        if (planFilePath) {
          try {
            plan = await readFile(planFilePath, "utf-8");
            log(`Read plan file: ${planFilePath} (${plan.length} chars)`);
          } catch (err) {
            log(`Failed to read plan file ${planFilePath}: ${err}`);
          }
        }

        // Update input with plan content, then continue to normal permission flow
        // (ExitPlanMode still needs user approval to proceed with the plan)
        input = { ...input, plan, planFilePath };
      }

      // Check if approval is needed based on autonomy level
      // EXCEPTION: Interactive tools (AskUserQuestion, ExitPlanMode, EnterPlanMode)
      // ALWAYS require user interaction regardless of autonomy level
      const isInteractiveTool = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].includes(toolName);
      const autonomyLevel = currentSettings.autonomyLevel ?? 0;

      if (!isInteractiveTool && !needsApprovalForTool(toolName, autonomyLevel)) {
        // Auto-approve based on autonomy settings (e.g., read-only tools at level 1)
        log(`Auto-approving ${toolName} based on autonomy level ${autonomyLevel}`);
        return {
          behavior: "allow" as const,
          updatedInput: input,
          toolUseID: options.toolUseID,
        };
      }

      // Find the chat panel participant
      const panel = Object.values(client.roster).find(
        (p) => p.metadata.type === "panel"
      );

      if (!panel) {
        // No panel to ask - deny by default
        log(`No panel found, denying permission for ${toolName}`);
        return {
          behavior: "deny" as const,
          message: "No panel available to request permission",
          toolUseID: options.toolUseID,
        };
      }

      // Determine if this is the first approval prompt in this session (shows different UI)
      // Persisted in settings so it survives across conversation turns
      const isFirstTimeGrant = !currentSettings.hasShownApprovalPrompt;

      try {
        // Use feedback_form with buttonGroup for permission prompts
        const { allow, alwaysAllow } = await showPermissionPrompt(
          client,
          panel.id,
          toolName,
          input,
          {
            decisionReason: options.decisionReason,
            isFirstTimeGrant,
            floorLevel: autonomyLevel,
          }
        );

        // Mark that we've shown at least one approval prompt (persisted for session)
        if (!currentSettings.hasShownApprovalPrompt) {
          currentSettings.hasShownApprovalPrompt = true;
          if (client.sessionKey) {
            client.updateSettings(currentSettings).catch((err) => {
              log(`Failed to persist hasShownApprovalPrompt: ${err}`);
            });
          }
        }

        if (allow) {
          // If user selected "Always Allow", bump autonomy level to Full Auto
          if (alwaysAllow) {
            log(`User selected "Always Allow" - setting autonomy to Full Auto`);
            currentSettings.autonomyLevel = 2;
            // Persist the setting so it survives reconnection
            if (client.sessionKey) {
              client.updateSettings(currentSettings).catch((err) => {
                log(`Failed to persist autonomy setting: ${err}`);
              });
            }
          }

          log(`Permission granted for ${toolName}`);
          return {
            behavior: "allow" as const,
            updatedInput: input,
            toolUseID: options.toolUseID,
          };
        } else {
          log(`Permission denied for ${toolName}`);
          return {
            behavior: "deny" as const,
            message: "User denied permission",
            toolUseID: options.toolUseID,
          };
        }
      } catch (err) {
        log(`Permission prompt failed: ${err}`);
        return {
          behavior: "deny" as const,
          message: `Permission prompt failed: ${err instanceof Error ? err.message : String(err)}`,
          toolUseID: options.toolUseID,
        };
      }
    };

    // Get session state for resumption
    const resumeSessionId = client.sdkSessionId || localSdkSessionId;
    if (resumeSessionId) {
      log(`Resuming session: ${resumeSessionId}${client.sdkSessionId ? " (persisted)" : " (local fallback)"}`);
    } else {
      log("Starting new session (no previous session ID)");
    }

    const queryOptions: Parameters<typeof query>[0]["options"] = {
      // Build mcpServers object combining workspace tools, UI tools, and attachments
      ...(() => {
        const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
        if (isRestrictedMode && pubsubServer) {
          servers.workspace = pubsubServer;
        }
        if (attachmentsMcpServer) {
          servers.attachments = attachmentsMcpServer;
        }
        return { mcpServers: servers };
      })(),
      // Use restricted mode system prompt when bash is unavailable
      systemPrompt: isRestrictedMode
        ? createRestrictedModeSystemPrompt()
        : createRichTextChatSystemPrompt(),
      // Provide explicit path to Claude Code CLI (required for bundled workers)
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(allowedTools.length > 0 && { allowedTools }),
      // In restricted mode, disallow tools that we replace via pubsub
      // WebSearch and WebFetch remain enabled (full network access available)
      //
      // Task is disallowed because subagents cannot inherit MCP servers.
      // The SDK's AgentDefinition type only supports:
      //   type AgentDefinition = {
      //     description: string;
      //     tools?: string[];           // If omitted, inherits from parent
      //     disallowedTools?: string[];
      //     prompt: string;
      //     model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
      //   };
      // Note: mcpServers is only available on top-level Options, not AgentDefinition.
      //
      // TODO: Future work - implement a pubsub-based Task tool that spawns subagents
      // through the pubsub agent system, allowing them to access workspace tools.
      disallowedTools: isRestrictedMode
        ? ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "NotebookEdit"]
        : [],
      // Set working directory if provided via config
      ...(workingDirectory && { cwd: workingDirectory }),
      // Enable streaming of partial messages for token-by-token delivery
      includePartialMessages: true,
      // Resume from previous session if available
      // Priority: persisted session ID > worker-local fallback
      ...(resumeSessionId && { resume: resumeSessionId }),
      // Apply user settings
      ...(currentSettings.model && { model: currentSettings.model }),
      ...(currentSettings.maxThinkingTokens && { maxThinkingTokens: currentSettings.maxThinkingTokens }),
      // Permission handling: Always wire canUseTool so interactive tools (AskUserQuestion,
      // ExitPlanMode, EnterPlanMode) can prompt the user even in Full Auto mode.
      // We handle auto-approval logic inside canUseTool based on autonomy level and tool type.
      // NOTE: We intentionally don't use allowDangerouslySkipPermissions because it would
      // bypass canUseTool entirely, preventing interactive tools from prompting the user.
      canUseTool,
    };

    // Query Claude using the Agent SDK
    // Always pass a string prompt - images are delivered via the get_attached_images MCP tool
    queryInstance = query({
      prompt: promptWithImageNote,
      options: queryOptions,
    });

    // Store reference for settings method to use for model discovery
    activeQueryInstance = queryInstance;

    let capturedSessionId: string | undefined;
    let checkpointCommitted = false;
    let sawStreamedText = false;

    // Track tool input JSON for accumulating input_json_delta events
    const toolInputAccumulators = new Map<string, {
      toolName: string;
      inputChunks: string[];
    }>();

    for await (const message of queryInstance) {
      // Check if pause was requested and break early
      if (interruptHandler.isPaused()) {
        log("Execution paused, breaking out of query loop");
        break;
      }

      if (message.type === "stream_event") {
        // Handle streaming message events (token-by-token with includePartialMessages: true)
        const streamEvent = message.event as {
          type: string;
          delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
          content_block?: { type?: string; id?: string; name?: string };
          index?: number;
        };

        // Handle message_start - this signals a new SDK message (turn boundary)
        // When Claude responds after a tool result, a new message_start is emitted
        if (streamEvent.type === "message_start") {
          // Complete current response message if one exists - new turn is starting
          if (responseId) {
            await client.complete(responseId);
            log(`Completed response message ${responseId} at message_start (turn boundary)`);
            responseId = null;
          }
          // Also reset sawStreamedText for the new turn
          sawStreamedText = false;
        }

        // Handle content block start - detect thinking vs text vs tool_use
        if (streamEvent.type === "content_block_start" && streamEvent.content_block) {
          const blockType = streamEvent.content_block.type;
          if (blockType === "thinking") {
            // Stop typing indicator - first content is appearing
            await stopTypingIfNeeded();
            // Complete action if active before starting thinking
            if (action.isActive()) {
              await action.completeAction();
            }
            // Create a new message for thinking content
            await thinking.startThinking();
          } else if (blockType === "tool_use") {
            // Stop typing indicator - first content is appearing
            await stopTypingIfNeeded();
            // Complete thinking if active before starting tool use
            if (thinking.isThinking()) {
              await thinking.endThinking();
            }

            // Note: Turn splitting is handled by message_start events above.
            // Each new SDK message (after tool results) emits message_start,
            // which completes the previous response and prepares for a new one.

            // Extract tool info from content_block
            const toolBlock = streamEvent.content_block as {
              type: "tool_use";
              id: string;
              name: string;
            };

            // Initialize input accumulator for this tool use
            toolInputAccumulators.set(toolBlock.id, {
              toolName: toolBlock.name,
              inputChunks: [],
            });

            // Start action message for this tool use (with generic description initially)
            await action.startAction({
              type: toolBlock.name,
              description: getActionDescription(toolBlock.name),
              toolUseId: toolBlock.id,
            });
          } else if (blockType === "text") {
            // Stop typing indicator - text content is appearing
            await stopTypingIfNeeded();
            // Complete thinking and action if we were in those modes
            if (thinking.isThinking()) {
              await thinking.endThinking();
            }
            if (action.isActive()) {
              await action.completeAction();
            }
            thinking.setTextMode();
          }
        }

        // Handle thinking delta
        if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "thinking_delta") {
          if (streamEvent.delta.thinking) {
            await thinking.updateThinking(streamEvent.delta.thinking);
          }
        }

        // Handle text delta
        if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
          if (streamEvent.delta.text) {
            // Ensure we have a response message (creates lazily on first text)
            // All text within a single query() goes to the same message
            const msgId = await ensureResponseMessage();

            // Send each text delta immediately (real streaming)
            await client.update(msgId, streamEvent.delta.text);
            sawStreamedText = true;

            if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
              await client.commitCheckpoint(incoming.pubsubId);
              checkpointCommitted = true;
            }
          }
        }

        // Handle tool input delta - accumulate partial JSON for tool inputs
        if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "input_json_delta") {
          if (streamEvent.delta.partial_json && action.isActive()) {
            const currentAction = action.state.currentAction;
            if (currentAction?.toolUseId) {
              const acc = toolInputAccumulators.get(currentAction.toolUseId);
              if (acc) {
                acc.inputChunks.push(streamEvent.delta.partial_json);
              }
            }
          }
        }

        // Handle content block stop
        if (streamEvent.type === "content_block_stop") {
          // Complete thinking message if it was a thinking block
          if (thinking.isThinking()) {
            await thinking.endThinking();
          }
          // Update and complete action message if it was a tool_use block
          if (action.isActive()) {
            const currentAction = action.state.currentAction;
            if (currentAction?.toolUseId) {
              const acc = toolInputAccumulators.get(currentAction.toolUseId);
              if (acc && acc.inputChunks.length > 0) {
                try {
                  const fullInput = acc.inputChunks.join("");
                  const parsedInput = JSON.parse(fullInput) as Record<string, unknown>;
                  const detailedDescription = getDetailedActionDescription(acc.toolName, parsedInput);

                  // Update the action with the detailed description
                  await action.updateAction(detailedDescription);
                } catch {
                  // JSON parse failed, keep generic description
                  log(`Failed to parse tool input for ${currentAction.toolUseId}`);
                }
              }
              // Clean up the accumulator
              toolInputAccumulators.delete(currentAction.toolUseId);
            }

            await action.completeAction();
            // Restart typing to show "processing" while waiting for Claude's follow-up
            await typing.startTyping("processing tool result");
          }
        }

      } else if (message.type === "assistant") {
        // Fallback for complete assistant messages when no streaming deltas were seen
        // All text within a query() goes to the same message (no splitting)
        if (!sawStreamedText) {
          // Only create/update message if there's actual text content
          const textBlocks = message.message.content.filter(
            (block): block is { type: "text"; text: string } => block.type === "text"
          );
          if (textBlocks.length > 0) {
            const msgId = await ensureResponseMessage();
            for (const block of textBlocks) {
              await client.update(msgId, block.text);
            }
          }
        }
        sawStreamedText = false; // Reset for next turn
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Query failed: ${message.subtype}`);
        }
        // Capture session ID from result for future resumption
        // session_id is present on success results (typed as SDKResultMessage)
        const resultMessage = message as SDKResultMessage;
        if (resultMessage.subtype === "success" && resultMessage.session_id) {
          capturedSessionId = resultMessage.session_id;
        }
        log(`Query completed. Cost: $${message.total_cost_usd?.toFixed(4) ?? "unknown"}`);
      }
    }

    // Stop the interrupt handler's monitoring loop
    interruptHandler.cleanup();

    // Clean up any active typing/thinking/action messages if interrupted mid-stream
    // These are safe to call even if already completed
    if (interruptHandler.isPaused()) {
      await typing.cleanup();
      await thinking.cleanup();
      await action.cleanup();
    }

    if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
      await client.commitCheckpoint(incoming.pubsubId);
      checkpointCommitted = true;
    }

    // Store session ID for resumption
    if (capturedSessionId) {
      // Always update worker-local fallback (for resumption within same worker lifetime)
      localSdkSessionId = capturedSessionId;

      // Also persist to server if possible (for cross-worker resumption)
      if (client.sessionKey) {
        await client.updateSdkSession(capturedSessionId);
        log(`Session ID stored: ${capturedSessionId}`);
      } else {
        log(`Session ID stored locally (no workspaceId): ${capturedSessionId}`);
      }
    }

    // Mark message as complete (whether interrupted or finished normally)
    // Only if we created a message (responseId is not null)
    if (responseId) {
      await client.complete(responseId);
      log(`Completed response for ${incoming.id}`);
    } else {
      // No response was created - cleanup typing indicator if still active
      await typing.cleanup();
      log(`No response message was created for ${incoming.id}`);
    }
  } catch (err) {
    // Cleanup any pending typing/thinking/action messages to avoid orphaned messages
    await typing.cleanup();
    await thinking.cleanup();
    await action.cleanup();
    // Stop the interrupt handler's monitoring loop
    interruptHandler.cleanup();

    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    const errorDetails = err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name, ...err }
      : err;
    console.error(`[Claude Code] Error:`, JSON.stringify(errorDetails, null, 2));
    console.error(`[Claude Code] Full error object:`, err);

    // Only send error to existing message if one was created
    if (responseId) {
      await client.error(responseId, err instanceof Error ? err.message : String(err));
    } else {
      // Create an error message if no response was started
      const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
      await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
    }
  }
}

void main();
