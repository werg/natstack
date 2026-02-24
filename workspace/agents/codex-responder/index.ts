/**
 * Codex Responder Agent
 *
 * An agent that uses OpenAI's Codex SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Codex
 * through an in-process HTTP MCP server.
 *
 * Architecture:
 * 1. Agent connects to pubsub and discovers tools
 * 2. Creates an in-process HTTP MCP server on a random local port
 * 3. Writes dynamic config.toml pointing to the HTTP server URL
 * 4. Initializes Codex SDK with custom CODEX_HOME
 * 5. Codex connects to our MCP server via HTTP
 * 6. Tool calls flow: Codex -> HTTP MCP server -> pubsub
 */

import { Agent, runAgent, type AgentState } from "@workspace/agent-runtime";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createMissedContextManager,
  createTrackerManager,
  createContextTracker,
  createStandardMcpTools,
  executeStandardMcpTool,
  findPanelParticipant,
  discoverPubsubTools,
  toCodexMcpTools,
  createCanUseToolGate,
  type MessageQueue,
} from "@workspace/agent-patterns";
import {
  createRichTextChatSystemPrompt,
} from "@workspace/agent-patterns/prompts";
import {
  jsonSchemaToZodRawShape,
  formatArgsForLog,
  createPauseMethodDefinition,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
  filterImageAttachments,
  validateAttachments,
  // Tool approval utilities
  showPermissionPrompt,
  // TODO list utilities
  getCachedTodoListCode,
  // Queue position utilities
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
  drainForInterleave,
  createTypingTracker,
  // Interrupt handler for per-message pause events
  createInterruptHandler,
  type TodoItem,
  type InlineUiData,
  type ContextWindowUsage,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@workspace/agentic-messaging";
import { prettifyToolName } from "@workspace/agentic-messaging/utils";
import type { Attachment } from "@workspace/pubsub";
import { CODEX_PARAMETERS, findNewestInFamily, getRecommendedDefault } from "@workspace/agentic-messaging/config";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import * as fs from "node:fs";
import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

/** State persisted across agent wake/sleep cycles */
interface CodexAgentState extends AgentState {
  // SDK session ID for resumption
  sdkSessionId?: string;
  // NOTE: Settings are NOT stored in agent state.
  // SettingsManager handles persistence via pubsub session storage.
}

/** Runtime-adjustable settings */
interface CodexSettings {
  model?: string;
  reasoningEffort?: number; // 0=minimal, 1=low, 2=medium, 3=high
  autonomyLevel?: number; // 0=read-only, 1=workspace-write, 2=full-access
  webSearchEnabled?: boolean;
  /** Whether we've shown at least one approval prompt (for first-time grant UI) */
  hasShownApprovalPrompt?: boolean;
  [key: string]: string | number | boolean | undefined;
}

/** Tool definition for MCP server */
interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  originalName?: string;
}

/** Result of creating the MCP HTTP server */
interface McpHttpServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

// =============================================================================
// Helpers
// =============================================================================

/** Map reasoning effort slider value to SDK string */
function getReasoningEffort(
  level: number | undefined
): "minimal" | "low" | "medium" | "high" | undefined {
  switch (level) {
    case 0:
      return "minimal";
    case 1:
      return "low";
    case 2:
      return "medium";
    case 3:
      return "high";
    default:
      return undefined;
  }
}

/**
 * Derive sandbox mode from autonomy level.
 * autonomyLevel 0 (Restricted) -> read-only
 * autonomyLevel 1 (Standard) -> workspace-write
 * autonomyLevel 2 (Autonomous) -> danger-full-access
 */
function getSandboxModeFromAutonomy(
  autonomyLevel: number | undefined
): "read-only" | "workspace-write" | "danger-full-access" {
  switch (autonomyLevel) {
    case 0:
      return "read-only";
    case 2:
      return "danger-full-access";
    case 1:
    default:
      return "workspace-write";
  }
}

/**
 * Set up Codex home directory inside the context folder.
 * Creates {contextFolderPath}/.codex/ and copies auth.json from default Codex home if available.
 *
 * @param contextFolderPath - The per-context working directory
 * @param log - Logger function
 */
async function setupCodexHome(contextFolderPath: string, log: (msg: string) => void): Promise<string> {
  const codexHome = path.join(contextFolderPath, ".codex");
  await mkdir(codexHome, { recursive: true });

  // Copy auth.json from default Codex home if not already present
  const defaultCodexHome = path.join(os.homedir(), ".codex");
  const defaultAuthPath = path.join(defaultCodexHome, "auth.json");
  const targetAuthPath = path.join(codexHome, "auth.json");

  if (!fs.existsSync(targetAuthPath) && fs.existsSync(defaultAuthPath)) {
    try {
      fs.copyFileSync(defaultAuthPath, targetAuthPath);
      log(`Copied auth.json from ${defaultCodexHome}`);
    } catch (err) {
      log(`Warning: Failed to copy auth.json: ${err}`);
    }
  } else if (!fs.existsSync(defaultAuthPath)) {
    log(`Warning: No auth.json found at ${defaultAuthPath} - run 'codex login' to authenticate`);
  }

  return codexHome;
}

/**
 * Update Codex config.toml with MCP server URL.
 * Writes to {codexHome}/config.toml (where codexHome = {contextFolderPath}/.codex/).
 * Called each time we start an MCP server (which may be on a different port).
 */
function updateCodexConfig(codexHome: string, mcpServerUrl: string, log: (msg: string) => void): void {
  const configPath = path.join(codexHome, "config.toml");

  const config = `
# Auto-generated Codex config for pubsub tool bridge
[mcp_servers.pubsub]
url = "${mcpServerUrl}"
startup_timeout_sec = 30
tool_timeout_sec = 120
`;

  fs.writeFileSync(configPath, config);
  log(`Updated Codex config at ${configPath}`);
}

/**
 * Create an in-process HTTP MCP server that exposes pubsub tools to Codex.
 */
async function createMcpHttpServer(
  tools: ToolDefinition[],
  executeTool: (name: string, args: unknown) => Promise<unknown>,
  log: (msg: string) => void
): Promise<McpHttpServer> {
  const mcpServer = new McpServer({
    name: "pubsub-tools",
    version: "1.0.0",
  });

  // Register tools using the shared JSON Schema to Zod converter
  for (const toolDef of tools) {
    const inputSchema = jsonSchemaToZodRawShape(toolDef.parameters);
    const executionName = toolDef.originalName ?? toolDef.name;

    mcpServer.tool(
      toolDef.name,
      toolDef.description ?? `Tool: ${toolDef.name}`,
      inputSchema,
      async (args: Record<string, unknown>) => {
        log(`Tool call: ${toolDef.name} args=${formatArgsForLog(args)}`);
        try {
          const result = await executeTool(executionName, args);
          return {
            content: [
              {
                type: "text" as const,
                text: typeof result === "string" ? result : JSON.stringify(result),
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  // Track sessions for stateful operation
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // Create HTTP server
  const httpServer = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Parse request body for POST requests
      let body: unknown = undefined;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const rawBody = Buffer.concat(chunks).toString();
        if (rawBody) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            res.writeHead(400);
            res.end("Invalid JSON");
            return;
          }
        }
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        if (isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, body);

          const newSessionId = res.getHeader("mcp-session-id") as string | undefined;
          if (newSessionId) {
            sessions.set(newSessionId, transport);
            log(`MCP session created: ${newSessionId}`);

            transport.onclose = () => {
              sessions.delete(newSessionId);
              log(`MCP session closed: ${newSessionId}`);
            };
          }
        } else if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res, body);
        } else {
          res.writeHead(400);
          res.end("Invalid or missing session");
        }
      } else if (req.method === "GET" && sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
      } else if (req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
        log(`MCP session terminated: ${sessionId}`);
      } else {
        res.writeHead(405);
        res.end("Method not allowed");
      }
    }
  );

  // Find an available port
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
    httpServer.on("error", reject);
  });

  log(`MCP HTTP server listening on port ${port}`);

  return {
    server: httpServer,
    port,
    close: async () => {
      for (const transport of sessions.values()) {
        await transport.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });
      log(`MCP HTTP server closed`);
    },
  };
}


// =============================================================================
// Codex SDK Input Helpers
// =============================================================================

type CodexUserInput = { type: "text"; text: string } | { type: "local_image"; path: string };

/**
 * Convert text + image attachments into Codex SDK UserInput[] format.
 * Writes image data to temp files because the Codex CLI expects file paths.
 */
async function buildCodexInput(
  text: string,
  imageAttachments: Attachment[],
): Promise<CodexUserInput[]> {
  const parts: CodexUserInput[] = [];

  if (imageAttachments.length > 0) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-images-"));
    for (let i = 0; i < imageAttachments.length; i++) {
      const a = imageAttachments[i]!;
      const ext = a.mimeType?.split("/")[1] ?? "png";
      const filePath = path.join(tempDir, `image-${i}.${ext}`);
      await writeFile(filePath, a.data);
      parts.push({ type: "local_image", path: filePath });
    }
  }

  parts.push({ type: "text", text });
  return parts;
}

// =============================================================================
// Codex Agent
// =============================================================================

/** Queued message with per-message typing tracker */
interface QueuedMessageInfo {
  event: IncomingNewMessage;
  typingTracker: ReturnType<typeof createTypingTracker>;
}

class CodexResponderAgent extends Agent<CodexAgentState, ChatParticipantMetadata> {
  // Pattern helpers from @workspace/agent-patterns
  private queue!: MessageQueue<IncomingNewMessage>;
  private interrupt!: ReturnType<typeof createInterruptController>;
  private settingsMgr!: ReturnType<typeof createSettingsManager<CodexSettings>>;
  private missedContext!: ReturnType<typeof createMissedContextManager>;
  private trackers!: ReturnType<typeof createTrackerManager>;
  private contextTracker!: ReturnType<typeof createContextTracker>;

  // Per-message typing trackers for queue position display
  private queuedMessages = new Map<string, QueuedMessageInfo>();

  /**
   * Codex home directory ({contextFolderPath}/.codex/).
   * Created once in onWake and reused across messages.
   */
  private codexHome!: string;

  /**
   * Context folder path used as cwd for Codex.
   * Set from initInfo.contextFolderPath in onWake (fail fast if missing).
   */
  private contextFolderPath!: string;

  /**
   * Worker-local fallback for SDK session ID.
   * Used when client.sessionKey is unavailable (workspaceId not set),
   * allowing session resumption within the same agent lifetime.
   */
  private localSdkSessionId?: string;

  state: CodexAgentState = {};

  getConnectOptions() {
    // Note: handle is set by the runtime from initInfo, we just set name/type
    // Closures capture `this` - ctx will be populated when methods execute
    const contextId = this.ctx.config["contextId"] as string | undefined;

    if (!contextId) {
      this.log.warn("contextId not provided - session persistence may fail");
    }

    return {
      name: "Codex",
      type: "codex" as const,
      reconnect: true,
      // Resume from last checkpoint to avoid replaying already-seen events
      replaySinceId: this.lastCheckpoint,
      // Add metadata for session tracking
      ...(contextId && { contextId }),
      extraMetadata: {
        agentTypeId: this.agentId,
      },
      methods: {
        pause: createPauseMethodDefinition(async () => {
          this.interrupt.pause();
          this.interrupt.abortCurrent();
          this.log.info("Pause RPC received");
        }),
        settings: {
          description: "Configure Codex settings",
          parameters: z.object({}),
          menu: true,
          execute: async () => this.handleSettingsMenu(),
        },
        set_title: {
          description: `Set the channel/conversation title displayed to users.

Call this tool:
- Early in the conversation when the topic becomes clear
- When the topic shifts significantly to a new subject
- To provide a concise summary (1-5 words) of what this conversation is about

Examples: "Debug React Hooks", "Refactor Auth Module", "Setup CI Pipeline"`,
          parameters: z.object({
            title: z.string().max(200).describe("Brief title for this conversation (1-5 words)"),
          }),
          execute: async ({ title }: { title: string }) => {
            await this.client.setChannelTitle(title);
            this.log.info(`Set channel title to: ${title}`);
            return { success: true, title };
          },
        },
      },
    };
  }

  getEventsOptions(): { targetedOnly: boolean; respondWhenSolo: boolean } {
    return { targetedOnly: true, respondWhenSolo: true };
  }

  async onWake(): Promise<void> {
    // Initialize message queue with correct API
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;
    this.queue = createMessageQueue<IncomingNewMessage>({
      onProcess: (event) => this.handleUserMessage(event),
      onError: (err, event) => this.log.error(`Error processing message ${event.id}`, err),
      onDequeue: async (event) => {
        // Update queue positions for all waiting messages
        const msgEvent = event;

        // Remove the dequeued message from our tracking map
        this.queuedMessages.delete(msgEvent.id);

        // Update remaining messages' positions (0 = next in line)
        let position = 0;
        for (const [_id, info] of this.queuedMessages) {
          const positionText = createQueuePositionText({
            queueLength: position,
            isProcessing: true,
          });
          await info.typingTracker.startTyping(positionText);
          position++;
        }
      },
      // Heartbeat to prevent inactivity timeout during long operations
      onHeartbeat: async () => {
        try {
          await client.publish("agent-heartbeat", { agentId: this.agentId }, { persist: false });
        } catch (err) {
          this.log.warn(`Heartbeat failed: ${err}`);
        }
      },
    });

    // Initialize interrupt controller (no arguments, or options object)
    this.interrupt = createInterruptController();

    // Initialize missed context manager
    // sinceId skips events already in the AI thread history (prevents regurgitation on reconnect)
    // excludeSenderTypes filters out the agent's own responses (already in thread history)
    this.missedContext = createMissedContextManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: 8000,
      sinceId: this.lastCheckpoint,
      excludeSenderTypes: ["codex"],
    });

    // Initialize trackers once at agent level (use setReplyTo per message)
    this.trackers = createTrackerManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      senderInfo: {
        senderId: (this.ctx.client as AgenticClient<ChatParticipantMetadata>).clientId ?? "",
        senderName: "Codex",
        senderType: "codex",
      },
      log: (msg) => this.log.debug(msg),
    });

    // Get model options from CODEX_PARAMETERS and find the newest codex model
    const modelParam = CODEX_PARAMETERS.find((p) => p.key === "model");
    const modelOptions = modelParam?.options ?? [];
    const defaultModel = findNewestInFamily(modelOptions, "codex") ?? getRecommendedDefault(modelOptions) ?? "gpt-5.3-codex";

    // Initialize settings with 3-way merge (correct API)
    this.settingsMgr = createSettingsManager<CodexSettings>({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      defaults: { model: defaultModel, reasoningEffort: 2, autonomyLevel: 1 },
      initConfig: {
        model: this.ctx.config["model"] as string | undefined,
        reasoningEffort: this.ctx.config["reasoningEffort"] as number | undefined,
        autonomyLevel: this.ctx.config["autonomyLevel"] as number | undefined,
        webSearchEnabled: this.ctx.config["webSearchEnabled"] as boolean | undefined,
      },
    });
    await this.settingsMgr.load();

    // Fail fast if contextFolderPath is not available
    const contextFolderPath = this.initInfo.contextFolderPath;
    if (!contextFolderPath) {
      throw new Error("contextFolderPath is required but was not provided in initInfo");
    }
    this.contextFolderPath = contextFolderPath;
    this.log.info(`Context folder path: ${this.contextFolderPath}`);

    // Initialize local SDK session fallback from persisted state or client
    if (client.sdkSessionId) {
      this.localSdkSessionId = client.sdkSessionId;
      this.log.info(`Initialized local SDK session from client: ${this.localSdkSessionId}`);
    } else if (this.state.sdkSessionId) {
      this.localSdkSessionId = this.state.sdkSessionId;
      this.log.info(`Initialized local SDK session from state: ${this.localSdkSessionId}`);
    }

    // Handle roster changes (for auto-sleep logic when no panels remain)
    client.onRoster((roster) => {
      const names = Object.values(roster.participants).map(
        (p) => `${p.metadata.name} (${p.metadata.type})`
      );
      this.log.info(`Roster updated: ${names.join(", ")}`);
    });

    // Handle reconnection for missed context
    client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker for token usage monitoring
    const currentSettings = this.settingsMgr.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.model,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        // Update participant metadata with context usage
        const currentMetadata = client.clientId
          ? client.roster[client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          name: "Codex",
          type: "codex",
          handle: this.handle,
          agentTypeId: this.agentId,
          ...currentMetadata,
          contextUsage: usage,
        };

        try {
          await client.updateMetadata(metadata);
        } catch (err) {
          this.log.info(`Failed to update context usage metadata: ${err}`);
        }
      },
    });

    // Create Codex home directory inside context folder
    this.codexHome = await setupCodexHome(this.contextFolderPath, this.log.info);
    this.log.info(`Codex home: ${this.codexHome}`);

    this.log.info("Codex agent woke up");
  }

  async onEvent(event: { type: string }): Promise<void> {
    if (event.type !== "message") return;

    const msgEvent = event as IncomingNewMessage;

    // Skip replay messages
    if ("kind" in msgEvent && msgEvent.kind === "replay") return;

    // Skip typing indicators
    const contentType = (msgEvent as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) return;

    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;
    const sender = client.roster[msgEvent.senderId];

    // Only respond to messages from panels
    if (sender?.metadata.type === "panel" && msgEvent.senderId !== client.clientId) {
      // Create per-message typing tracker for queue position display
      const typingTracker = createTypingTracker({
        client,
        replyTo: msgEvent.id,
        senderInfo: {
          senderId: client.clientId ?? "",
          senderName: "Codex",
          senderType: "codex",
        },
        log: (msg) => this.log.debug(msg),
      });

      // Show queue position in typing indicator
      const positionText = createQueuePositionText({
        queueLength: this.queuedMessages.size,
        isProcessing: this.queue.isProcessing(),
      });
      await typingTracker.startTyping(positionText);

      // Store the queued message with its typing tracker
      this.queuedMessages.set(msgEvent.id, { event: msgEvent, typingTracker });

      // Enqueue - cleanup if queue is stopped
      const enqueued = this.queue.enqueue(msgEvent);
      if (!enqueued) {
        await typingTracker.cleanup();
        this.queuedMessages.delete(msgEvent.id);
      }
    }
  }

  async onSleep(): Promise<void> {
    // Stop queue and drain pending work
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();

    await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));

    // NOTE: Settings are persisted by SettingsManager via pubsub session storage.
    // We don't need to store them in agent state.

    this.log.info("Codex agent going to sleep");
  }

  private async handleSettingsMenu(): Promise<{
    success: boolean;
    cancelled?: boolean;
    error?: string;
    settings?: CodexSettings;
  }> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const panel = findPanelParticipant(client);
    if (!panel) throw new Error("No panel found");

    // Get model options and determine recommended default dynamically
    const modelParam = CODEX_PARAMETERS.find((p) => p.key === "model");
    const modelOptions = modelParam?.options ?? [];
    const recommendedModel = findNewestInFamily(modelOptions, "codex") ?? getRecommendedDefault(modelOptions);

    const fields = CODEX_PARAMETERS.filter((p) => !p.channelLevel).map((f) => {
      if (f.key === "model" && recommendedModel) {
        return { ...f, default: recommendedModel };
      }
      return f;
    });
    const handle = client.callMethod(panel.id, "feedback_form", {
      title: "Codex Settings",
      fields,
      values: this.settingsMgr.get(),
    });

    const result = await handle.result;
    const feedbackResult = result.content as {
      type: string;
      value?: unknown;
      message?: string;
    };

    if (feedbackResult.type === "cancel") {
      this.log.info("Settings cancelled");
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      this.log.info(`Settings error: ${feedbackResult.message}`);
      return { success: false, error: feedbackResult.message };
    }

    const newSettings = feedbackResult.value as CodexSettings;
    await this.settingsMgr.update(newSettings);
    this.log.info(`Settings updated: ${JSON.stringify(this.settingsMgr.get())}`);

    // Settings are automatically persisted by SettingsManager via pubsub session storage

    return { success: true, settings: this.settingsMgr.get() };
  }

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    this.log.info(`Received message: ${incoming.content}`);
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;

    // Stop the per-message queue position typing indicator (it's no longer in queue)
    const queuedInfo = this.queuedMessages.get(incoming.id);
    if (queuedInfo) {
      await queuedInfo.typingTracker.cleanup();
      this.queuedMessages.delete(incoming.id);
    }

    // Create per-message interrupt handler for UI pause events
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: async (reason) => {
        this.log.info(`Pause received: ${reason}`);
        // Pause the queue and abort current operation
        this.queue.pause();
        this.interrupt.abortCurrent();
      },
    });

    // Start monitoring for pause RPCs in background
    void interruptHandler.monitor();

    // Build prompt with missed context (use consume() which gets and clears)
    let prompt = incoming.content;
    const missedCtx = this.missedContext.consume();
    if (missedCtx) {
      prompt = `<missed_context>\n${missedCtx}\n</missed_context>\n\n${prompt}`;
    }

    // Process image attachments
    const attachments = (incoming as { attachments?: Attachment[] }).attachments;
    const imageAttachments = filterImageAttachments(attachments);
    if (imageAttachments.length > 0) {
      const validation = validateAttachments(imageAttachments);
      if (!validation.valid) {
        this.log.info(`Attachment validation failed: ${validation.error}`);
      }
      this.log.info(`Processing ${imageAttachments.length} image attachment(s)`);
    }

    // Build multimodal prompt content if images are present
    const promptContent =
      imageAttachments.length > 0 ? await buildCodexInput(prompt, imageAttachments) : prompt;

    // Reply anchoring: tracks which message responses are anchored to.
    // Updated on interleave to point to the last interleaved user message.
    let replyToId = incoming.id;

    // Set replyTo for trackers (trackers created once at agent level)
    this.trackers.setReplyTo(replyToId);

    // Start typing indicator
    await this.trackers.typing.startTyping("preparing response");

    // Defer creating response message until we have content
    let responseId: string | null = null;
    const ensureResponseMessage = async (): Promise<string> => {
      if (this.trackers.typing.isTyping()) {
        await this.trackers.typing.stopTyping();
      }
      if (!responseId) {
        const { messageId } = await client.send("", { replyTo: replyToId });
        responseId = messageId;
        this.log.info(`Created response message: ${responseId}`);
      }
      return responseId;
    };

    // Discover tools via registry with unrestricted allowlist
    const registry = await discoverPubsubTools(client, {
      allowlist: ["feedback_form", "feedback_custom", "eval"],
      namePrefix: "pubsub",
      timeoutMs: 1500,
    });
    this.log.info(
      `Discovered ${registry.tools.length} tools from pubsub participants`
    );
    if (registry.tools.length > 0) {
      const toolNames = registry.tools.map((t) => `${t.providerId}:${t.methodName}`);
      this.log.info(`Pubsub tools: ${toolNames.join(", ")}`);
    }

    // Build MCP tool definitions via adapter
    const standardMcpTools = createStandardMcpTools();
    const { definitions: mcpTools, originalToDisplay, execute: registryExecute } = toCodexMcpTools(
      registry,
      client,
      standardMcpTools,
    );

    // Create approval gate using the same pattern as other agents
    const approvalGate = createCanUseToolGate({
      byCanonical: registry.byCanonical,
      getApprovalLevel: () => this.settingsMgr.get().autonomyLevel ?? 0,
      hasShownApprovalPrompt: !!this.settingsMgr.get().hasShownApprovalPrompt,
      showPermissionPrompt: async (_tool, input) => {
        const panel = findPanelParticipant(client);
        if (!panel) return { allow: false };
        const currentSettings = this.settingsMgr.get();
        return showPermissionPrompt(
          client,
          panel.id,
          _tool.canonicalName,
          input as Record<string, unknown>,
          {
            isFirstTimeGrant: !currentSettings.hasShownApprovalPrompt,
            floorLevel: currentSettings.autonomyLevel ?? 0,
          }
        );
      },
      onAlwaysAllow: () => {
        void this.settingsMgr.update({ autonomyLevel: 2 });
      },
      onFirstPrompt: () => {
        void this.settingsMgr.update({ hasShownApprovalPrompt: true });
      },
    });

    // Wrap execute with action tracking and approval prompts
    const executeToolWithActions = async (name: string, args: unknown): Promise<unknown> => {
      const toolUseId = randomUUID();
      const displayName = originalToDisplay.get(name) ?? name;
      const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // Check approval via gate (skips internal tools like set_title, TodoWrite)
      const isInternalTool = name === "__set_title__" || name === "__todo_write__";

      if (!isInternalTool) {
        const { allow } = await approvalGate.canUseTool(displayName, argsRecord);
        if (!allow) {
          this.log.info(`Permission denied for tool: ${displayName}`);
          throw new Error(`Permission denied: User denied access to ${displayName}`);
        }
      }

      await this.trackers.action.startAction({
        type: displayName,
        description: getDetailedActionDescription(displayName, argsRecord),
        toolUseId,
      });

      try {
        // Handle standard tools (set_title, TodoWrite)
        const standardResult = await executeStandardMcpTool(name, argsRecord, {
          client,
          log: (msg) => this.log.debug(msg),
        });
        if (standardResult.handled) {
          await this.trackers.action.completeAction();
          return standardResult.result;
        }

        const result = await registryExecute(name, args);
        await this.trackers.action.completeAction();
        return result;
      } catch (err) {
        await this.trackers.action.completeAction();
        throw err;
      }
    };

    let mcpServer: McpHttpServer | null = null;

    try {
      // Start MCP HTTP server if we have tools
      if (mcpTools.length > 0) {
        mcpServer = await createMcpHttpServer(mcpTools, executeToolWithActions, this.log.info);
        const mcpServerUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
        updateCodexConfig(this.codexHome, mcpServerUrl, this.log.info);
      }

      // Initialize Codex SDK
      const baseEnv: Record<string, string> = {};
      if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
      if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];
      if (process.env["OPENAI_API_KEY"]) baseEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
      if (process.env["CODEX_API_KEY"]) baseEnv["CODEX_API_KEY"] = process.env["CODEX_API_KEY"];
      baseEnv["CODEX_HOME"] = this.codexHome;

      const codex = new Codex({
        codexPathOverride: "codex",
        env: Object.keys(baseEnv).length > 0 ? baseEnv : undefined,
      });

      let thread: ReturnType<typeof codex.startThread> | ReturnType<typeof codex.resumeThread>;

      // Build thread options
      const settings = this.settingsMgr.get();
      const reasoningEffort = getReasoningEffort(settings.reasoningEffort);
      const sandboxMode = getSandboxModeFromAutonomy(settings.autonomyLevel);

      const threadOptions = {
        skipGitRepoCheck: true,
        cwd: this.contextFolderPath,
        ...(settings.model && { model: settings.model }),
        ...(reasoningEffort && { modelReasoningEffort: reasoningEffort }),
        sandboxMode,
        networkAccessEnabled: true,
        ...(settings.webSearchEnabled !== undefined && {
          webSearchEnabled: settings.webSearchEnabled,
        }),
      };

      // Resume from previous session if available
      // Priority: persisted state > client session > local fallback
      const resumeSessionId = this.state.sdkSessionId || client.sdkSessionId || this.localSdkSessionId;
      if (resumeSessionId) {
        const source = this.state.sdkSessionId ? "state" : client.sdkSessionId ? "client" : "local fallback";
        this.log.info(`Resuming Codex thread: ${resumeSessionId} (${source})`);
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } else {
        this.log.info("Starting new Codex thread");
        thread = codex.startThread(threadOptions);
      }

      // Build system prompt — only prepend for new threads, not resumes
      // (resumed threads already have the system prompt in conversation history)
      let promptWithSystem: string | typeof promptContent;
      if (typeof promptContent === "string") {
        promptWithSystem = `${createRichTextChatSystemPrompt()}\n\n${promptContent}`;
      } else {
        const systemPrompt = createRichTextChatSystemPrompt();
        promptWithSystem = [
          { type: "text" as const, text: systemPrompt + "\n\n" },
          ...(promptContent as CodexUserInput[]),
        ];
      }

      // Only prepend system prompt for new threads. Resumed threads already have
      // the system prompt in conversation history — the Codex CLI persists full
      // session state in ~/.codex/sessions/<threadId>/ and restores it on resume.
      // Prepending again would duplicate it and waste context.
      const initialPrompt = resumeSessionId ? promptContent : promptWithSystem;
      let interleavePrompt: string | CodexUserInput[] | null = null;
      let { events } = await thread.runStreamed(initialPrompt);

      // Track text length per item to compute deltas correctly
      const itemTextLengths = new Map<string, number>();
      let currentAgentMessageId: string | null = null;
      // Session ID for resume — captured from thread.started events
      let sessionId: string | undefined = this.localSdkSessionId;

      outer: while (true) {
        // Fresh abort signal each iteration (MUST be inside outer loop —
        // after abortCurrent(), the previous signal is permanently aborted)
        const signal = this.interrupt.createAbortSignal();

        if (interleavePrompt) {
          // Complete current response before starting new stream
          if (responseId) {
            await client.complete(responseId);
            responseId = null;
          }
          // Update reply anchoring for trackers
          this.trackers.setReplyTo(replyToId);
          // Resume with new prompt — no system prompt (already in conversation history)
          thread = codex.resumeThread(sessionId!, threadOptions);
          ({ events } = await thread.runStreamed(interleavePrompt!));
          // Reset per-stream state
          itemTextLengths.clear();
          currentAgentMessageId = null;
          interleavePrompt = null;
        }

        for await (const event of events) {
          // Check for abort or pause
          if (signal.aborted || interruptHandler.isPaused()) {
            this.log.info(`Execution ${interruptHandler.isPaused() ? "paused" : "aborted"}, stopping event processing`);
            break;
          }

          switch (event.type) {
            case "thread.started": {
              const threadEvent = event as unknown as Record<string, unknown>;
              if (threadEvent["thread_id"]) {
                const threadId = String(threadEvent["thread_id"]);
                sessionId = threadId;
                // Always update local fallback (for resumption within same agent lifetime)
                this.localSdkSessionId = threadId;
                // Persist to state
                this.setState({ sdkSessionId: threadId });
                // Also persist to server if possible (for cross-agent resumption)
                if (client.sessionKey) {
                  void client.updateSdkSession(threadId).catch((err) => {
                    this.log.info(`Failed to persist SDK session to server: ${err}`);
                  });
                }
                this.log.info(`Thread ID stored: ${threadId}${client.sessionKey ? "" : " (local only)"}`);
              }
              break;
            }

            case "item.started":
            case "item.updated": {
              // Codex has many item types: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error
              const item = event.item as {
                id?: string;
                type?: string;
                text?: string;
                command?: string;
                changes?: Array<{ path: string; kind: string }>;
                tool?: string;
                arguments?: unknown;
                query?: string;
              };

              // Handle reasoning items (thinking content)
              if (item && item.type === "reasoning" && typeof item.text === "string" && item.id) {
                if (this.trackers.typing.isTyping()) {
                  await this.trackers.typing.stopTyping();
                }
                if (!this.trackers.thinking.isThinkingItem(item.id)) {
                  if (this.trackers.thinking.state.currentContentType === "text" && responseId) {
                    await client.complete(responseId);
                  }
                  await this.trackers.thinking.startThinking(item.id);
                }

                const prevLength = itemTextLengths.get(item.id) ?? 0;
                if (item.text.length > prevLength) {
                  const delta = item.text.slice(prevLength);
                  await this.trackers.thinking.updateThinking(delta);
                  itemTextLengths.set(item.id, item.text.length);
                }
              }

              // Handle agent_message items (text content)
              if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
                if (this.trackers.thinking.isThinking()) {
                  await this.trackers.thinking.endThinking();
                }

                if (currentAgentMessageId !== null && currentAgentMessageId !== item.id && responseId) {
                  await client.complete(responseId);
                  responseId = null;
                }
                currentAgentMessageId = item.id;
                this.trackers.thinking.setTextMode();

                const prevLength = itemTextLengths.get(item.id) ?? 0;
                if (item.text.length > prevLength) {
                  const delta = item.text.slice(prevLength);
                  const msgId = await ensureResponseMessage();
                  await client.update(msgId, delta);
                  itemTextLengths.set(item.id, item.text.length);
                }
              }

              // Handle command_execution items (show commands being run)
              if (item && item.type === "command_execution" && item.id && item.command) {
                if (this.trackers.typing.isTyping()) {
                  await this.trackers.typing.stopTyping();
                }
                await this.trackers.action.startAction({
                  type: "Bash",
                  description: getDetailedActionDescription("Bash", { command: item.command }),
                  toolUseId: item.id,
                });
              }

              // Handle file_change items (show files being edited)
              if (item && item.type === "file_change" && item.id && item.changes) {
                if (this.trackers.typing.isTyping()) {
                  await this.trackers.typing.stopTyping();
                }
                // file_change has a changes array — build a contextual description
                const changes = item.changes;
                const description =
                  changes.length === 1
                    ? getDetailedActionDescription("Edit", { file_path: changes[0]?.path })
                    : `Editing ${changes.length} files`;
                await this.trackers.action.startAction({
                  type: "Edit",
                  description,
                  toolUseId: item.id,
                });
              }

              // Handle mcp_tool_call items (show MCP tool calls - our pubsub tools)
              if (item && item.type === "mcp_tool_call" && item.id && item.tool) {
                if (this.trackers.typing.isTyping()) {
                  await this.trackers.typing.stopTyping();
                }
                const prettyName = prettifyToolName(item.tool);
                const args = item.arguments && typeof item.arguments === "object" ? item.arguments as Record<string, unknown> : {};
                await this.trackers.action.startAction({
                  type: prettyName,
                  description: getDetailedActionDescription(prettyName, args),
                  toolUseId: item.id,
                });
              }

              // Handle web_search items
              if (item && item.type === "web_search" && item.id) {
                if (this.trackers.typing.isTyping()) {
                  await this.trackers.typing.stopTyping();
                }
                await this.trackers.action.startAction({
                  type: "WebSearch",
                  description: getDetailedActionDescription("WebSearch", { query: item.query }),
                  toolUseId: item.id,
                });
              }
              break;
            }

            case "item.completed": {
              // Codex item types: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error
              const item = "item" in event ? (event.item as {
                id?: string;
                type?: string;
                text?: string;
                // command_execution fields
                command?: string;
                aggregated_output?: string;
                status?: string;
                exit_code?: number;
                // file_change fields
                changes?: Array<{ path: string; kind: string }>;
                // mcp_tool_call fields
                server?: string;
                tool?: string;
                arguments?: unknown;
                result?: unknown;
                // web_search fields
                query?: string;
                // todo_list fields
                items?: Array<{ text: string; completed: boolean }>;
                // error fields
                message?: string;
                error?: { message?: string };
              }) : null;

              if (item && item.type === "reasoning" && item.id && this.trackers.thinking.isThinkingItem(item.id)) {
                const prevLength = itemTextLengths.get(item.id) ?? 0;
                if (typeof item.text === "string" && item.text.length > prevLength) {
                  const delta = item.text.slice(prevLength);
                  await this.trackers.thinking.updateThinking(delta);
                  itemTextLengths.set(item.id, item.text.length);
                }
                await this.trackers.thinking.endThinking();
              }

              if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
                if (currentAgentMessageId !== null && currentAgentMessageId !== item.id && responseId) {
                  await client.complete(responseId);
                  responseId = null;
                }
                currentAgentMessageId = item.id;
                this.trackers.thinking.setTextMode();

                const prevLength = itemTextLengths.get(item.id) ?? 0;
                if (item.text.length > prevLength) {
                  const delta = item.text.slice(prevLength);
                  const msgId = await ensureResponseMessage();
                  await client.update(msgId, delta);
                  itemTextLengths.set(item.id, item.text.length);
                }
              }

              // Handle completed command_execution items - complete the action
              if (item && item.type === "command_execution" && item.id) {
                await this.trackers.action.completeAction();
              }

              // Handle completed file_change items - complete the action
              if (item && item.type === "file_change" && item.id) {
                await this.trackers.action.completeAction();
              }

              // Handle completed mcp_tool_call items - complete the action
              if (item && item.type === "mcp_tool_call" && item.id) {
                await this.trackers.action.completeAction();
              }

              // Handle completed web_search items - complete the action
              if (item && item.type === "web_search" && item.id) {
                await this.trackers.action.completeAction();
              }

              // Handle completed todo_list items - send inline UI
              if (item && item.type === "todo_list" && item.id) {
                const todoItems = item.items;
                if (todoItems && todoItems.length > 0) {
                  try {
                    // Convert Codex todo format to our format
                    const todos: TodoItem[] = todoItems.map((t) => ({
                      content: t.text,
                      activeForm: t.text,
                      status: t.completed ? "completed" as const : "pending" as const,
                    }));

                    const inlineUiData: InlineUiData = {
                      id: "agent-todos",
                      code: getCachedTodoListCode() ?? "",
                      props: { todos },
                    };

                    // Send as inline UI message
                    await client.send(JSON.stringify(inlineUiData), {
                      contentType: CONTENT_TYPE_INLINE_UI,
                      persist: true,
                    });
                    this.log.info(`Sent todo list with ${todos.length} items`);
                  } catch (err) {
                    this.log.info(`Failed to send todo list: ${err}`);
                  }
                }
              }

              // Check for interleave on completed tool items
              const isToolItem = item && (
                item.type === "command_execution" ||
                item.type === "file_change" ||
                item.type === "mcp_tool_call" ||
                item.type === "web_search"
              );
              if (isToolItem && !interruptHandler.isPaused() && this.queue.getPendingCount() > 0 && sessionId) {
                const { pending, lastMessageId } = await drainForInterleave(
                  this.queue.takePending(),
                  this.queuedMessages,
                );
                if (pending.length === 0) {
                  this.log.warn("Pending drained between check and take, skipping interleave");
                } else {
                  this.interrupt.abortCurrent(); // synchronous, cannot fail
                  // Update replyTo to last interleaved message
                  replyToId = lastMessageId!;
                  // Collect images from ALL pending messages
                  const allInterleaveImages: Attachment[] = [];
                  for (const p of pending) {
                    allInterleaveImages.push(...filterImageAttachments((p as { attachments?: Attachment[] }).attachments));
                  }
                  const combinedText = pending.map((p) => String(p.content)).join("\n\n");
                  interleavePrompt = allInterleaveImages.length > 0
                    ? await buildCodexInput(combinedText, allInterleaveImages)
                    : combinedText;
                  this.log.info(`Interleaved ${pending.length} user message(s) at item.completed`);
                }
              }
              break; // exits SWITCH (not for-await)
            }

            case "turn.completed": {
              // Record token usage for context window tracking
              const turnCompletedEvent = event as { type: "turn.completed"; usage?: { input_tokens?: number; output_tokens?: number } };
              if (turnCompletedEvent.usage) {
                await this.contextTracker.recordUsage({
                  inputTokens: turnCompletedEvent.usage.input_tokens ?? 0,
                  outputTokens: turnCompletedEvent.usage.output_tokens ?? 0,
                });
              }

              if (responseId) {
                await client.complete(responseId);
                this.log.info(`Completed response for ${replyToId}`);
              } else {
                await this.trackers.typing.cleanup();
                this.log.info(`No response message was created for ${replyToId}`);
              }

              // Mark end of turn for context tracking
              await this.contextTracker.endTurn();
              break outer; // normal completion, exit both loops
            }

            case "turn.failed": {
              const errorMsg =
                "error" in event && event.error && typeof event.error === "object" && "message" in event.error
                  ? String(event.error.message)
                  : "Unknown error";
              if (responseId) {
                await client.error(responseId, errorMsg);
              } else {
                const { messageId: errorMsgId } = await client.send("", { replyTo: replyToId });
                await client.error(errorMsgId, errorMsg);
              }
              this.log.info(`Turn failed: ${errorMsg}`);
              break;
            }

            case "error": {
              // Handle ThreadErrorEvent - fatal stream error
              const errorEvent = event as { type: "error"; error?: { message?: string } };
              const errorMsg = errorEvent.error?.message ?? "Unknown stream error";
              this.log.info(`Stream error: ${errorMsg}`);
              // Create a message for the error if none exists
              if (responseId) {
                await client.error(responseId, errorMsg);
              } else {
                const { messageId: errorMsgId } = await client.send("", { replyTo: replyToId });
                await client.error(errorMsgId, errorMsg);
              }
              break;
            }

            default:
              this.log.info(`Unhandled event type: ${(event as { type: string }).type}`);
              break;
          }

          // After switch: check interleave flag to break for-await
          if (interleavePrompt) break;
        }

        // If no interleave pending, exit outer loop (pause/abort/normal)
        if (!interleavePrompt) break;
      }
    } catch (err) {
      // Cleanup trackers (use cleanupAll for simplicity)
      await this.trackers.cleanupAll();

      console.error(`[Codex Agent] Error:`, err);

      if (responseId) {
        await client.error(responseId, err instanceof Error ? err.message : String(err));
      } else {
        const { messageId: errorMsgId } = await client.send("", { replyTo: replyToId });
        await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
      }
    } finally {
      // Cleanup interrupt handler
      interruptHandler.cleanup();

      // Resume queue and interrupt state for next message (in case we were paused)
      this.queue.resume();
      this.interrupt.resume();

      if (mcpServer) {
        await mcpServer.close();
      }
      // Note: We don't cleanup codexHome because it's persistent across messages
    }
  }

}

// =============================================================================
// Bootstrap
// =============================================================================

void runAgent(CodexResponderAgent);
