/**
 * Codex Responder Worker
 *
 * An unsafe worker that uses OpenAI's Codex SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Codex
 * through an in-process HTTP MCP server.
 *
 * Architecture:
 * 1. Worker connects to pubsub and discovers tools
 * 2. Creates an in-process HTTP MCP server on a random local port
 * 3. Writes dynamic config.toml pointing to the HTTP server URL
 * 4. Initializes Codex SDK with custom CODEX_HOME
 * 5. Codex connects to our MCP server via HTTP
 * 6. Tool calls flow: Codex -> HTTP MCP server -> pubsub
 */

import { pubsubConfig, id, getStateArgs, unloadSelf } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  createLogger,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  formatMissedContext,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  validateRestrictedMode,
  getCanonicalToolName,
  prettifyToolName,
  createThinkingTracker,
  createTypingTracker,
  createActionTracker,
  createContextTracker,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
  // TODO list utilities
  getCachedTodoListCode,
  type TodoItem,
  type InlineUiData,
  type ContextWindowUsage,
  // Image processing utilities
  buildOpenAIContents,
  filterImageAttachments,
  validateAttachments,
  type Attachment,
  type AgenticClient,
  type Participant,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
  // Message queue utilities
  MessageQueue,
  createQueuePositionText,
  type QueuedMessageBase,
  // Tool approval utilities
  needsApprovalForTool,
  showPermissionPrompt,
  APPROVAL_LEVELS,
} from "@natstack/agentic-messaging";
import { CODEX_PARAMETERS } from "@natstack/agentic-messaging/config";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const log = createLogger("Codex Worker", id);

/**
 * StateArgs passed at spawn time via createChild().
 * Defined in package.json stateArgs schema.
 */
interface CodexStateArgs {
  channel: string;
  handle?: string;
  model?: string;
  reasoningEffort?: number; // 0=minimal, 1=low, 2=medium, 3=high
  autonomyLevel?: number; // 0=restricted/read-only, 1=standard/workspace, 2=autonomous/full-access
  webSearchEnabled?: boolean;
  // Channel config values passed via stateArgs to avoid timing issues
  // (workers may connect before chat panel sets channelConfig)
  workingDirectory?: string;
  restrictedMode?: boolean;
  contextId: string; // Context ID for channel creation (required, passed from chat-launcher)
}

/** Worker-local settings interface (runtime-adjustable) */
interface CodexWorkerSettings {
  model?: string;
  reasoningEffort?: number; // 0=minimal, 1=low, 2=medium, 3=high
  autonomyLevel?: number; // 0=restricted/read-only, 1=standard/workspace, 2=autonomous/full-access
  webSearchEnabled?: boolean;
  /** Whether we've shown at least one approval prompt (for first-time grant UI) */
  hasShownApprovalPrompt?: boolean;
  [key: string]: string | number | boolean | undefined; // Index signature for Record<string, unknown> compatibility
}

// =============================================================================
// Message Queue - Producer-Consumer Pattern for Message Interleaving
// =============================================================================

/** A queued message waiting to be processed (extends shared base) */
interface CodexQueuedMessage extends QueuedMessageBase {
  event: IncomingNewMessage;
  prompt: string;
  attachments?: Attachment[];
  typingTracker: ReturnType<typeof createTypingTracker> | null;
}

/** Current processing state shared between observer and processor */
interface CodexProcessingState {
  currentMessage: CodexQueuedMessage | null;
}

/** Map reasoning effort slider value to SDK string */
function getReasoningEffort(level: number | undefined): "minimal" | "low" | "medium" | "high" | undefined {
  switch (level) {
    case 0: return "minimal";
    case 1: return "low";
    case 2: return "medium";
    case 3: return "high";
    default: return undefined;
  }
}

/**
 * Derive sandbox mode from autonomy level.
 * autonomyLevel 0 (Restricted) → read-only
 * autonomyLevel 1 (Standard) → workspace-write
 * autonomyLevel 2 (Autonomous) → danger-full-access
 */
function getSandboxModeFromAutonomy(autonomyLevel: number | undefined): "read-only" | "workspace-write" | "danger-full-access" {
  switch (autonomyLevel) {
    case 0: return "read-only";
    case 2: return "danger-full-access";
    case 1:
    default: return "workspace-write"; // Default to standard/workspace
  }
}

/** Current settings state - initialized from agent config and persisted settings */
let currentSettings: CodexWorkerSettings = {};

/**
 * Worker-local fallback for SDK session ID.
 * Used when client.sessionKey is unavailable (workspaceId not set),
 * allowing session resumption within the same worker lifetime.
 */
let localSdkSessionId: string | undefined;

/**
 * Tool definition for MCP server
 */
interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /** Original tool name for execution (may differ from display name in restricted mode) */
  originalName?: string;
}

/**
 * Result of creating the MCP HTTP server
 */
interface McpHttpServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Create an in-process HTTP MCP server that exposes pubsub tools to Codex.
 */
async function createMcpHttpServer(
  tools: ToolDefinition[],
  executeTool: (name: string, args: unknown) => Promise<unknown>
): Promise<McpHttpServer> {
  // Create MCP server
  const mcpServer = new McpServer({
    name: "pubsub-tools",
    version: "1.0.0",
  });

  // Register tools using the shared JSON Schema to Zod converter
  for (const toolDef of tools) {
    const inputSchema = jsonSchemaToZodRawShape(toolDef.parameters);
    // Use originalName for execution (may be different from display name in restricted mode)
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
  const httpServer = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost`);
    log(`MCP HTTP: ${req.method} ${url.pathname}`);

    // Only handle /mcp endpoint
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

    // Get or create session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Check if this is an initialization request
      if (!sessionId && isInitializeRequest(body)) {
        // Create new session with callback to store it immediately
        // This avoids race conditions where the client sends the initialized
        // notification before we've stored the session
        let transport: StreamableHTTPServerTransport;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            sessions.set(newSessionId, transport);
            log(`MCP session created: ${newSessionId}`);
          },
        } as any);

        // Set up onclose handler before connecting
        transport.onclose = () => {
          // Get session ID from response header or iterate sessions
          const sid = [...sessions.entries()].find(([, t]) => t === transport)?.[0];
          if (sid) {
            sessions.delete(sid);
            log(`MCP session closed: ${sid}`);
          }
        };

        // Connect transport to MCP server
        await mcpServer.connect(transport);

        // Handle the request
        await transport.handleRequest(req, res, body);
      } else if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, body);
      } else {
        res.writeHead(400);
        res.end("Invalid or missing session");
      }
    } else if (req.method === "GET" && sessionId && sessions.has(sessionId)) {
      // SSE stream for server-initiated messages
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE" && sessionId && sessions.has(sessionId)) {
      // Session termination
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
      log(`MCP session terminated: ${sessionId}`);
    } else {
      res.writeHead(405);
      res.end("Method not allowed");
    }
  });

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
      // Close all sessions
      for (const transport of sessions.values()) {
        await transport.close();
      }
      sessions.clear();
      // Close HTTP server
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve()));
      });
      log(`MCP HTTP server closed`);
    },
  };
}

/**
 * Get the NatStack config directory (without Electron app module).
 * Platform-specific paths:
 * - Linux: ~/.config/natstack
 * - macOS: ~/Library/Application Support/natstack
 * - Windows: %APPDATA%/natstack
 */
function getNatStackConfigDir(): string {
  const home = os.homedir();

  switch (process.platform) {
    case "win32": {
      const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
      return path.join(appData, "natstack");
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "natstack");
    default: {
      const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? path.join(home, ".config");
      return path.join(xdgConfig, "natstack");
    }
  }
}

/**
 * Get or create a persistent Codex home directory for a session.
 * Sessions are stored in <natstack-config>/codex-sessions/<sessionKey>/
 * This allows session recovery across worker/app restarts.
 *
 * @param sessionKey - Unique session identifier (from pubsub client.sessionKey)
 */
function getCodexHomeForSession(sessionKey: string): string {
  // Sanitize session key for filesystem use
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const codexSessionsDir = path.join(getNatStackConfigDir(), "codex-sessions");
  const codexHome = path.join(codexSessionsDir, safeKey);

  // Create directory if it doesn't exist
  fs.mkdirSync(codexHome, { recursive: true });

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
 * Create a temporary Codex home directory (fallback when no session key available).
 * This is cleaned up when the worker unloads.
 */
function createTempCodexHome(): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
  log(`Created temp Codex home at ${codexHome}`);

  // Copy auth.json from default Codex home
  const defaultCodexHome = path.join(os.homedir(), ".codex");
  const defaultAuthPath = path.join(defaultCodexHome, "auth.json");
  const targetAuthPath = path.join(codexHome, "auth.json");

  if (fs.existsSync(defaultAuthPath)) {
    try {
      fs.copyFileSync(defaultAuthPath, targetAuthPath);
      log(`Copied auth.json from ${defaultCodexHome}`);
    } catch (err) {
      log(`Warning: Failed to copy auth.json: ${err}`);
    }
  } else {
    log(`Warning: No auth.json found at ${defaultAuthPath} - run 'codex login' to authenticate`);
  }

  return codexHome;
}

/**
 * Update Codex config.toml with MCP server URL.
 * Called each time we start an MCP server (which may be on a different port).
 */
function updateCodexConfig(codexHome: string, mcpServerUrl: string): void {
  const configPath = path.join(codexHome, "config.toml");

  // Write config.toml with HTTP MCP server configuration
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
 * Clean up Codex home directory (only called when worker unloads)
 */
/**
 * Clean up a temporary Codex home directory.
 * Only call this for temp directories, not persistent session directories.
 */
function cleanupTempCodexHome(codexHome: string): void {
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
    log(`Cleaned up temp Codex home at ${codexHome}`);
  } catch {
    // Ignore cleanup errors
  }
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get stateArgs passed at spawn time
  const stateArgs = getStateArgs<CodexStateArgs>();
  const channelName = stateArgs.channel;
  const handle = stateArgs.handle ?? "codex";

  if (!channelName) {
    console.error("No channel specified in stateArgs");
    return;
  }

  log("Starting Codex responder...");
  log(`Handle: @${handle}`);

  // Create Codex home directory for session storage
  // Use contextId for persistent storage (allows session recovery across restarts)
  // Fall back to temp directory if no contextId available
  const codexHome = stateArgs.contextId
    ? getCodexHomeForSession(stateArgs.contextId)
    : createTempCodexHome();
  const isPersistentCodexHome = !!stateArgs.contextId;
  log(`Codex home: ${codexHome} (${isPersistentCodexHome ? "persistent" : "temporary"})`);

  // Connect to agentic messaging channel
  // Pass contextId from stateArgs for channel creation (more reliable than runtime contextId)
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    contextId: stateArgs.contextId, // Pass contextId for channel creation
    handle,
    name: "Codex",
    type: "codex",
    extraMetadata: {
      panelId: id, // Runtime panel ID - allows chat to link participant to child panel
    },
    reconnect: true,
    methods: {
      pause: createPauseMethodDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
      settings: {
        description: "Configure Codex settings",
        parameters: z.object({}),
        menu: true,
        execute: async () => {
          // Find the chat panel participant
          const panel = Object.values(client.roster).find(
            (p) => p.metadata.type === "panel"
          );
          if (!panel) throw new Error("No panel found");

          // Build fields (filter out channel-level params which are set at init only)
          const fields = CODEX_PARAMETERS.filter((p) => !p.channelLevel);

          // Call feedback_form on the panel
          const handle = client.callMethod(panel.id, "feedback_form", {
            title: "Codex Settings",
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
          const newSettings = feedbackResult.value as CodexWorkerSettings;
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
        execute: async ({ title }) => {
          await client.setChannelTitle(title);
          log(`Set channel title to: ${title}`);
          return { success: true, title };
        },
      },
    },
  });

  // Track pending unload timeout - allows cancellation if panel rejoins or recent activity
  let unloadTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastActivityTime = Date.now(); // Timestamp of last activity
  const UNLOAD_DELAY_MS = 10_000; // 10 seconds grace period for panel recovery
  const ACTIVITY_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes - don't unload if activity recently

  // Function to update activity timestamp (called from event loop)
  const updateActivity = () => {
    lastActivityTime = Date.now();
  };

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);

    // Check if there are any panels (users) left in the channel
    // If only agent workers remain (no panels), unload this worker to free resources
    const participants = Object.values(roster.participants) as Participant<ChatParticipantMetadata>[];
    const hasPanels = participants.some((p) => p.metadata.type === "panel");
    const participantCount = participants.length;

    // If no panels and more than just ourselves, it means only workers remain
    // If only we remain or no panels, schedule unload after delay
    if (!hasPanels && participantCount <= 1) {
      // Only schedule if not already pending
      if (!unloadTimeoutId) {
        log(`No panels in channel, scheduling unload in ${UNLOAD_DELAY_MS / 1000}s...`);
        unloadTimeoutId = setTimeout(() => {
          // Check if there was recent activity
          const timeSinceActivity = Date.now() - lastActivityTime;
          if (timeSinceActivity < ACTIVITY_GRACE_PERIOD_MS) {
            log(`Recent activity (${Math.round(timeSinceActivity / 1000)}s ago), deferring unload...`);
            unloadTimeoutId = null; // Reset so it can be rescheduled
            return;
          }
          log(`Unload timeout reached, unloading worker to conserve resources...`);
          // Only clean up temp Codex home - persistent sessions should survive for recovery
          if (!isPersistentCodexHome) {
            cleanupTempCodexHome(codexHome);
          }
          // Gracefully close and unload
          void client.close().then(() => {
            void unloadSelf();
          });
        }, UNLOAD_DELAY_MS);
      }
    } else if (hasPanels && unloadTimeoutId) {
      // Panel rejoined - cancel pending unload
      log(`Panel rejoined, canceling scheduled unload`);
      clearTimeout(unloadTimeoutId);
      unloadTimeoutId = null;
    }
  });

  log(`Connected to channel: ${channelName}`);

  // Create context tracker for monitoring token usage across the session
  const contextTracker = createContextTracker({
    model: currentSettings.model,
    log,
    onUpdate: async (usage: ContextWindowUsage) => {
      // Merge contextUsage into current metadata and update
      const currentMetadata = client.clientId
        ? client.roster[client.clientId]?.metadata
        : undefined;
      const metadata: ChatParticipantMetadata = {
        name: "Codex",
        type: "codex",
        handle,
        panelId: id,
        ...currentMetadata,
        contextUsage: usage,
      };
      try {
        await client.updateMetadata(metadata);
      } catch (err) {
        log(`Failed to update context usage metadata: ${err}`);
      }
    },
  });

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
  const initConfigSettings: CodexWorkerSettings = {};
  if (stateArgs.model) initConfigSettings.model = stateArgs.model;
  if (stateArgs.reasoningEffort !== undefined) initConfigSettings.reasoningEffort = stateArgs.reasoningEffort;
  if (stateArgs.autonomyLevel !== undefined) initConfigSettings.autonomyLevel = stateArgs.autonomyLevel;
  if (stateArgs.webSearchEnabled !== undefined) initConfigSettings.webSearchEnabled = stateArgs.webSearchEnabled;
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
      const savedSettings = await client.getSettings<CodexWorkerSettings>();
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

  // Missed context management
  let lastMissedPubsubId = 0;
  const buildMissedContext = () => {
    const missed = client.missedMessages.filter((event) => event.pubsubId > lastMissedPubsubId);
    if (missed.length === 0) return null;
    return formatMissedContext(missed, { maxChars: 8000 });
  };

  let pendingMissedContext = buildMissedContext();

  client.onReconnect(() => {
    pendingMissedContext = buildMissedContext();
  });

  // --- Message Queue Pattern ---
  // Uses producer-consumer pattern for proper queue position tracking:
  // - Observer (producer): Non-blocking loop that immediately acknowledges messages
  // - Processor (consumer): Sequential processing loop
  // This allows new messages to be observed and acknowledged while processing others.

  const messageQueue = new MessageQueue<CodexQueuedMessage>();
  const processingState: CodexProcessingState = { currentMessage: null };

  // Track whether we've validated restricted mode (happens on first message)
  let restrictedModeValidated = !restrictedMode; // Skip if not in restricted mode

  /**
   * Observer (Producer) - Non-blocking message observation and queuing.
   * Listens for events, creates typing indicators with queue position, and enqueues messages.
   */
  const observeMessages = async (): Promise<void> => {
    for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
      if (event.type !== "message") continue;

      // Skip replay messages - don't respond to historical messages
      if ("kind" in event && event.kind === "replay") continue;

      // Track activity for auto-unload prevention
      updateActivity();

      // Skip typing indicators - these are just presence notifications
      const contentType = (event as { contentType?: string }).contentType;
      if (contentType === CONTENT_TYPE_TYPING) continue;

      const sender = client.roster[event.senderId];
      if (sender?.metadata.type !== "panel" || event.senderId === id) continue;

      // Calculate queue position for typing context
      const typingContext = createQueuePositionText({
        queueLength: messageQueue.pending.length,
        isProcessing: processingState.currentMessage !== null,
      });

      // Create typing indicator immediately
      const typing = createTypingTracker({
        client,
        log,
        replyTo: event.id,
        senderInfo: {
          senderId: client.clientId ?? "",
          senderName: "Codex",
          senderType: "codex",
        },
      });
      await typing.startTyping(typingContext);

      // Enqueue the message
      messageQueue.enqueue({
        event: event as IncomingNewMessage,
        prompt: event.content,
        attachments: (event as { attachments?: Attachment[] }).attachments,
        enqueuedAt: Date.now(),
        typingTracker: typing,
      });

      log(`Message queued: ${event.content.slice(0, 50)}... (position ${messageQueue.length})`);
    }
  };

  /**
   * Processor (Consumer) - Sequential message processing from queue.
   * Updates queue position indicators for waiting messages and processes them one at a time.
   */
  const processMessages = async (): Promise<void> => {
    for await (const queuedMessage of messageQueue) {
      processingState.currentMessage = queuedMessage;
      messageQueue.dequeue();

      log(`Processing message: ${queuedMessage.event.content.slice(0, 50)}...`);

      // Validate restricted mode on first message (when panel should be connected)
      if (!restrictedModeValidated) {
        await validateRestrictedMode(client, log);
        restrictedModeValidated = true;
      }

      // Update queue position indicators for remaining messages
      for (let i = 0; i < messageQueue.pending.length; i++) {
        const msg = messageQueue.pending[i];
        if (msg.typingTracker) {
          const positionText = createQueuePositionText({
            queueLength: i,
            isProcessing: true,
          });
          await msg.typingTracker.startTyping(positionText);
        }
      }

      try {
        // Apply missed context if available
        let prompt = queuedMessage.prompt;
        if (pendingMissedContext && pendingMissedContext.count > 0) {
          prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
          lastMissedPubsubId = pendingMissedContext.lastPubsubId;
          pendingMissedContext = null;
        }

        await handleUserMessage(
          client,
          queuedMessage.event,
          prompt,
          workingDirectory,
          restrictedMode ?? false,
          queuedMessage.attachments,
          contextTracker,
          codexHome,
          queuedMessage.typingTracker ?? undefined
        );
      } catch (err) {
        // Clean up typing indicator if handleUserMessage threw before its internal cleanup
        await queuedMessage.typingTracker?.cleanup();
        throw err;
      } finally {
        processingState.currentMessage = null;
      }
    }
  };

  // Start observer in background
  void observeMessages().catch((err) => {
    log(`Observer failed: ${err instanceof Error ? err.message : String(err)}`);
    messageQueue.close();
    throw err;
  });

  // Start processor (blocks until queue closes)
  await processMessages();
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  workingDirectory: string | undefined,
  isRestrictedMode: boolean,
  attachments?: Attachment[],
  contextTracker?: ReturnType<typeof createContextTracker>,
  codexHome?: string,
  existingTypingTracker?: ReturnType<typeof createTypingTracker>
) {
  log(`Received message: ${incoming.content}`);

  // Process image attachments if present
  const imageAttachments = filterImageAttachments(attachments);
  if (imageAttachments.length > 0) {
    // Validate attachments
    const validation = validateAttachments(imageAttachments);
    if (!validation.valid) {
      log(`Attachment validation failed: ${validation.error}`);
      // Still proceed but warn - don't block the message
    }
    log(`Processing ${imageAttachments.length} image attachment(s)`);
  }

  // Build multimodal prompt content if images are present
  // The Codex SDK accepts OpenAI-style content arrays for multimodal input
  const promptContent = imageAttachments.length > 0
    ? buildOpenAIContents(prompt, imageAttachments)
    : prompt;

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants${isRestrictedMode ? " (restricted mode)" : ""}`);

  // Use existing typing tracker from queue if available, or create a new one
  const typing = existingTypingTracker ?? createTypingTracker({
    client,
    log,
    replyTo: incoming.id,
    senderInfo: {
      senderId: client.clientId ?? "",
      senderName: "Codex",
      senderType: "codex",
    },
  });

  // Update typing indicator while setting up (will already be showing queue position from observer)
  await typing.startTyping("preparing response");

  // Defer creating the response message until we have text content
  // This avoids creating empty messages that pollute the chat
  let responseId: string | null = null;
  const ensureResponseMessage = async (): Promise<string> => {
    // Stop typing indicator when we start real content
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

  // Create thinking tracker for managing reasoning message state
  // Defined before try block so cleanup can be called in catch
  const thinking = createThinkingTracker({ client, log });

  // Create action tracker for showing tool usage to users
  const action = createActionTracker({ client, log, replyTo: incoming.id });

  // Convert tool definitions for MCP server
  // In restricted mode, use canonical names (Read, Write, Edit, etc.) for LLM familiarity
  const mcpTools: ToolDefinition[] = toolDefs.map((t) => {
    // In restricted mode, use canonical name if available
    // t.originalMethodName is provided by createToolsForAgentSDK
    const displayName = isRestrictedMode
      ? getCanonicalToolName((t as { originalMethodName?: string }).originalMethodName ?? t.name)
      : t.name;

    return {
      name: displayName,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      // Store original name for execution lookup
      originalName: t.name,
    };
  });

  // Add set_title tool directly (not from pubsub discovery since we filter out self-methods)
  mcpTools.push({
    name: "set_title",
    description: `Set the channel/conversation title displayed to users.

Call this tool:
- Early in the conversation when the topic becomes clear
- When the topic shifts significantly to a new subject
- To provide a concise summary (1-5 words) of what this conversation is about

Examples: "Debug React Hooks", "Refactor Auth Module", "Setup CI Pipeline"`,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          maxLength: 200,
          description: "Brief title for this conversation (1-5 words)",
        },
      },
      required: ["title"],
    },
    originalName: "__set_title__", // Special marker for direct execution
  });

  // Add TodoWrite tool for task tracking
  mcpTools.push({
    name: "TodoWrite",
    description: `Create and manage a structured task list for tracking progress.

Use this tool when working on complex, multi-step tasks to:
- Track progress on implementation tasks
- Show the user what you're working on
- Demonstrate thoroughness

Each todo item has:
- content: Imperative form (e.g., "Run tests")
- activeForm: Present continuous form shown during execution (e.g., "Running tests")
- status: "pending", "in_progress", or "completed"

Only have ONE task as in_progress at a time. Mark tasks complete immediately after finishing.`,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task description in imperative form" },
              activeForm: { type: "string", description: "Task description in present continuous form" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "activeForm", "status"],
          },
        },
      },
      required: ["todos"],
    },
    originalName: "__todo_write__", // Special marker for direct execution
  });

  let mcpServer: McpHttpServer | null = null;

  // Set up RPC pause handler - monitors for pause tool calls
  // Defined before try block so cleanup can be called in finally
  const interruptHandler = createInterruptHandler({
    client,
    messageId: incoming.id,
    onPause: (reason) => {
      log(`Pause RPC received: ${reason}`);
    }
  });

  // Create a map from originalName -> displayName for action tracking
  const originalToDisplayName = new Map<string, string>();
  for (const tool of mcpTools) {
    if (tool.originalName) {
      originalToDisplayName.set(tool.originalName, tool.name);
    }
  }

  // Wrap executeTool with action tracking and approval prompts
  const executeToolWithActions = async (name: string, args: unknown): Promise<unknown> => {
    const toolUseId = randomUUID();
    // Get display name for better action descriptions (use canonical name if available)
    const displayName = originalToDisplayName.get(name) ?? name;
    const argsRecord = args && typeof args === "object" ? args as Record<string, unknown> : {};

    // Check if approval needed based on autonomy level
    const autonomyLevel = currentSettings.autonomyLevel ?? APPROVAL_LEVELS.AUTO_SAFE;

    // Skip approval for internal tools (set_title, TodoWrite)
    const isInternalTool = name === "__set_title__" || name === "__todo_write__";

    if (!isInternalTool && needsApprovalForTool(displayName, autonomyLevel)) {
      // Find the chat panel participant to show approval prompt
      const panel = Object.values(client.roster).find(
        (p) => p.metadata.type === "panel"
      );

      if (!panel) {
        log(`No panel available for approval prompt, denying tool: ${displayName}`);
        throw new Error(`Permission denied: No panel available to approve ${displayName}`);
      }

      const { allow, alwaysAllow } = await showPermissionPrompt(
        client,
        panel.id,
        displayName,
        argsRecord,
        {
          isFirstTimeGrant: !currentSettings.hasShownApprovalPrompt,
          floorLevel: autonomyLevel,
        }
      );

      // Mark that we've shown at least one approval prompt
      if (!currentSettings.hasShownApprovalPrompt) {
        currentSettings.hasShownApprovalPrompt = true;
        // Persist the setting if session is available
        if (client.sessionKey) {
          try {
            await client.updateSettings(currentSettings);
          } catch (err) {
            log(`Failed to persist hasShownApprovalPrompt: ${err}`);
          }
        }
      }

      if (!allow) {
        log(`Permission denied for tool: ${displayName}`);
        throw new Error(`Permission denied: User denied access to ${displayName}`);
      }

      // If user selected "Always Allow", upgrade to full auto
      if (alwaysAllow) {
        log(`User granted "Always Allow" - upgrading to full auto`);
        currentSettings.autonomyLevel = APPROVAL_LEVELS.FULL_AUTO;
        if (client.sessionKey) {
          try {
            await client.updateSettings(currentSettings);
          } catch (err) {
            log(`Failed to persist autonomyLevel upgrade: ${err}`);
          }
        }
      }
    }

    await action.startAction({
      type: displayName,
      description: getDetailedActionDescription(displayName, argsRecord),
      toolUseId,
    });

    try {
      // Handle set_title specially (not from pubsub)
      if (name === "__set_title__") {
        const { title } = argsRecord as { title: string };
        await client.setChannelTitle(title);
        log(`Set channel title to: ${title}`);
        await action.completeAction();
        return { success: true, title };
      }

      // Handle TodoWrite - send inline_ui message
      // Each call sends a new message, creating a history of task progress
      if (name === "__todo_write__") {
        const { todos } = argsRecord as { todos: TodoItem[] };
        if (todos && todos.length > 0) {
          try {
            const inlineData: InlineUiData = {
              id: "agent-todos",
              code: getCachedTodoListCode(),
              props: { todos },
            };

            await client.send(JSON.stringify(inlineData), {
              contentType: CONTENT_TYPE_INLINE_UI,
              persist: true,
            });

            const completedCount = todos.filter(t => t.status === "completed").length;
            log(`Sent TODO list: ${todos.length} items, ${completedCount} completed`);
          } catch (err) {
            log(`Failed to send TODO list: ${err}`);
          }
        }
        await action.completeAction();
        return { success: true };
      }

      const result = await executeTool(name, args);
      await action.completeAction();
      return result;
    } catch (err) {
      await action.completeAction();
      throw err;
    }
  };

  // Start monitoring for pause events in background
  void interruptHandler.monitor();

  try {
    // Start MCP HTTP server if we have tools
    if (mcpTools.length > 0 && codexHome) {
      mcpServer = await createMcpHttpServer(mcpTools, executeToolWithActions);
      const mcpServerUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
      // Update config.toml with new MCP server URL (port may change per message)
      updateCodexConfig(codexHome, mcpServerUrl);
    }

    // Initialize Codex SDK with custom config location
    // Only pass through necessary env vars to avoid leaking sensitive data
    // Filter out undefined values to avoid passing them to the subprocess
    const baseEnv: Record<string, string> = {};
    if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
    if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];
    if (process.env["OPENAI_API_KEY"]) baseEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
    if (process.env["CODEX_API_KEY"]) baseEnv["CODEX_API_KEY"] = process.env["CODEX_API_KEY"];
    if (codexHome) baseEnv["CODEX_HOME"] = codexHome;
    // Only set workspace env vars in unrestricted mode (native filesystem)
    // In restricted mode, file tools come from pubsub and don't use native filesystem
    if (!isRestrictedMode) {
      const workspaceOverride = workingDirectory ?? process.env["NATSTACK_WORKSPACE"];
      if (workspaceOverride) {
        baseEnv["NATSTACK_WORKSPACE"] = workspaceOverride;
        baseEnv["PWD"] = workspaceOverride;
      }
    }

    // Use globally installed codex from PATH
    // The SDK's vendored binary detection doesn't work in bundled environments,
    // so we explicitly point to the global installation
    const codex = new Codex({
      codexPathOverride: "codex", // Use PATH lookup
      env: Object.keys(baseEnv).length > 0 ? baseEnv : undefined,
    });

    let thread: ReturnType<typeof codex.startThread> | ReturnType<typeof codex.resumeThread>;

    // Build thread options with user settings
    const reasoningEffort = getReasoningEffort(currentSettings.reasoningEffort);
    // Derive sandbox mode from autonomy level
    // In restricted mode, force sandbox to read-only (Codex uses MCP exclusively for tools)
    const sandboxMode = isRestrictedMode
      ? "read-only"
      : getSandboxModeFromAutonomy(currentSettings.autonomyLevel);
    const threadOptions = {
      skipGitRepoCheck: true,
      // Only set cwd in unrestricted mode (native filesystem)
      ...(!isRestrictedMode && workingDirectory && { cwd: workingDirectory }),
      ...(currentSettings.model && { model: currentSettings.model }),
      ...(reasoningEffort && { modelReasoningEffort: reasoningEffort }),
      sandboxMode,
      networkAccessEnabled: true, // Always enable network access
      ...(currentSettings.webSearchEnabled !== undefined && { webSearchEnabled: currentSettings.webSearchEnabled }),
    };

    // Resume from previous session if available
    // Priority: persisted session ID > worker-local fallback
    const resumeSessionId = client.sdkSessionId || localSdkSessionId;
    if (resumeSessionId) {
      log(`Resuming Codex thread: ${resumeSessionId}${client.sdkSessionId ? " (persisted)" : " (local fallback)"}`);
      thread = codex.resumeThread(resumeSessionId, threadOptions);
    } else {
      log("Starting new Codex thread");
      thread = codex.startThread(threadOptions);
    }

    // Run with streaming
    // Use restricted mode system prompt when sandbox is unavailable
    // For multimodal content, we need to handle it differently
    let promptWithSystem: string | typeof promptContent;
    if (typeof promptContent === "string") {
      promptWithSystem = isRestrictedMode
        ? `${createRestrictedModeSystemPrompt()}\n\n${promptContent}`
        : `${createRichTextChatSystemPrompt()}\n\n${promptContent}`;
    } else {
      // Multimodal content - prepend system prompt as text block
      const systemPrompt = isRestrictedMode
        ? createRestrictedModeSystemPrompt()
        : createRichTextChatSystemPrompt();
      promptWithSystem = [
        { type: "text" as const, text: systemPrompt + "\n\n" },
        ...promptContent,
      ];
    }
    const { events } = await thread.runStreamed(promptWithSystem as string);

    // Track text length per item to compute deltas correctly
    const itemTextLengths = new Map<string, number>();
    // Track current agent_message item ID for turn boundary detection
    let currentAgentMessageId: string | null = null;

    let checkpointCommitted = false;

    for await (const event of events) {
      // Log all events for debugging
      log(`Event: ${event.type}${event.type === "error" ? ` - ${JSON.stringify((event as { error?: unknown }).error ?? "unknown")}` : ""}`);

      // Break if pause RPC was received
      if (interruptHandler.isPaused()) {
        log(`Execution paused, stopping event processing`);
        break;
      }
      switch (event.type) {
        case "thread.started": {
          // Capture thread ID from first turn event
          const threadEvent = event as unknown as Record<string, unknown>;
          if (threadEvent.thread_id) {
            const threadId = String(threadEvent.thread_id);
            // Always update worker-local fallback (for resumption within same worker lifetime)
            localSdkSessionId = threadId;

            // Also persist to server if possible (for cross-worker resumption)
            if (client.sessionKey) {
              await client.updateSdkSession(threadId);
              log(`Thread ID stored: ${threadId}`);
            } else {
              log(`Thread ID stored locally (no workspaceId): ${threadId}`);
            }
          }
          break;
        }

        case "item.started":
        case "item.updated": {
          // Handle different item types
          // Codex has many item types: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error
          const item = event.item as {
            id?: string;
            type?: string;
            text?: string;
            command?: string;
            aggregated_output?: string;
            status?: string;
            changes?: Array<{ path: string; kind: string }>;
            server?: string;
            tool?: string;
            arguments?: unknown;
          };
          log(`  Item ${event.type}: type=${item?.type}, id=${item?.id}`);

          // Handle reasoning items (thinking content)
          if (item && item.type === "reasoning" && typeof item.text === "string" && item.id) {
            // Stop typing indicator when we start actual content
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            // Check if this is a new reasoning item
            if (!thinking.isThinkingItem(item.id)) {
              // Complete previous text message if we're transitioning from text to reasoning
              if (thinking.state.currentContentType === "text" && responseId) {
                await client.complete(responseId);
              }
              // Start new reasoning message with item ID
              await thinking.startThinking(item.id);
            }

            // Stream reasoning content
            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              await thinking.updateThinking(delta);
              itemTextLengths.set(item.id, item.text.length);
            }
          }

          // Handle agent_message items (text content)
          if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
            // Complete reasoning message if we're transitioning from reasoning to text
            if (thinking.isThinking()) {
              await thinking.endThinking();
            }

            // Check if this is a new agent_message item (turn boundary)
            if (currentAgentMessageId !== null && currentAgentMessageId !== item.id && responseId) {
              // New agent message item = new turn, complete previous and create new
              await client.complete(responseId);
              responseId = null; // Will be created on next ensureResponseMessage
            }
            currentAgentMessageId = item.id;
            thinking.setTextMode();

            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              const msgId = await ensureResponseMessage();
              await client.update(msgId, delta);
              itemTextLengths.set(item.id, item.text.length);

              if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
                await client.commitCheckpoint(incoming.pubsubId);
                checkpointCommitted = true;
              }
            }
          }

          // Handle command_execution items (show commands being run)
          if (item && item.type === "command_execution" && item.id && item.command) {
            // Stop typing indicator when we have actual content
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            // Format command nicely - truncate long commands
            const cmd = item.command.trim();
            const shortCmd = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
            await action.startAction({
              type: "Bash",
              description: `Running: ${shortCmd}`,
              toolUseId: item.id,
            });
          }

          // Handle file_change items (show files being edited)
          if (item && item.type === "file_change" && item.id && item.changes) {
            // Stop typing indicator when we have actual content
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            // Format file changes nicely - show first file or count
            const changes = item.changes;
            let description: string;
            if (changes.length === 1) {
              const filename = changes[0].path.split("/").pop() ?? changes[0].path;
              description = `Editing ${filename}`;
            } else {
              description = `Editing ${changes.length} files`;
            }
            await action.startAction({
              type: "Edit",
              description,
              toolUseId: item.id,
            });
          }

          // Handle mcp_tool_call items (show MCP tool calls - our pubsub tools)
          if (item && item.type === "mcp_tool_call" && item.id && item.tool) {
            // Stop typing indicator when we have actual content
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            // Prettify the tool name and get a detailed description
            const prettifiedName = prettifyToolName(item.tool);
            const args = typeof item.arguments === "object" && item.arguments !== null
              ? item.arguments as Record<string, unknown>
              : {};
            const description = getDetailedActionDescription(item.tool, args);
            await action.startAction({
              type: prettifiedName,
              description,
              toolUseId: item.id,
            });
          }

          // Handle web_search items
          if (item && item.type === "web_search" && item.id) {
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            const query = (item as { query?: string }).query ?? "searching...";
            const shortQuery = query.length > 50 ? query.slice(0, 50) + "..." : query;
            await action.startAction({
              type: "WebSearch",
              description: `Searching: ${shortQuery}`,
              toolUseId: item.id,
            });
          }

          // Handle error items - log them but don't show action indicator
          if (item && item.type === "error" && item.id) {
            const errorMsg = (item as { message?: string }).message ?? "Unknown error";
            log(`  Codex error item: ${errorMsg}`);
          }
          break;
        }

        case "item.completed": {
          // Extract final content from completed item
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
          log(`  Item completed: type=${item?.type}, id=${item?.id}`);

          // Handle completed reasoning items
          if (item && item.type === "reasoning" && item.id && thinking.isThinkingItem(item.id)) {
            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (typeof item.text === "string" && item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              await thinking.updateThinking(delta);
              itemTextLengths.set(item.id, item.text.length);
            }
            // Complete the reasoning message
            await thinking.endThinking();
          }

          // Handle completed agent_message items
          if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
            // Stop typing indicator when we have actual content
            if (typing.isTyping()) {
              await typing.stopTyping();
            }
            // Check if this is a new agent_message item (turn boundary)
            if (currentAgentMessageId !== null && currentAgentMessageId !== item.id && responseId) {
              // New agent message item = new turn, complete previous and create new
              await client.complete(responseId);
              responseId = null;
            }
            currentAgentMessageId = item.id;
            thinking.setTextMode();

            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              const msgId = await ensureResponseMessage();
              await client.update(msgId, delta);
              itemTextLengths.set(item.id, item.text.length);

              if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
                await client.commitCheckpoint(incoming.pubsubId);
                checkpointCommitted = true;
              }
            }
          }

          // Handle completed command_execution items - complete the action
          if (item && item.type === "command_execution" && item.id) {
            await action.completeAction();
          }

          // Handle completed file_change items - complete the action
          if (item && item.type === "file_change" && item.id) {
            await action.completeAction();
          }

          // Handle completed mcp_tool_call items - complete the action
          if (item && item.type === "mcp_tool_call" && item.id) {
            await action.completeAction();
          }

          // Handle completed web_search items - complete the action
          if (item && item.type === "web_search" && item.id) {
            await action.completeAction();
          }

          // Handle completed todo_list items - send inline UI
          if (item && item.type === "todo_list" && item.id) {
            const todoItems = item.items;
            if (todoItems && todoItems.length > 0) {
              try {
                // Convert Codex todo format to our format
                const todos: TodoItem[] = todoItems.map((t, i) => ({
                  id: `codex-todo-${i}`,
                  content: t.text,
                  activeForm: t.text,
                  status: t.completed ? "completed" : "pending",
                }));
                const inlineData: InlineUiData = {
                  id: "agent-todos",
                  code: getCachedTodoListCode(),
                  props: { todos },
                };
                await client.send(JSON.stringify(inlineData), {
                  contentType: CONTENT_TYPE_INLINE_UI,
                  persist: true,
                });
                log(`Sent TODO list: ${todos.length} items`);
              } catch (err) {
                log(`Failed to send TODO list: ${err}`);
              }
            }
          }
          break;
        }

        case "turn.completed": {
          if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
            await client.commitCheckpoint(incoming.pubsubId);
            checkpointCommitted = true;
          }

          // Record token usage for context window tracking
          const turnCompletedEvent = event as { type: "turn.completed"; usage?: { input_tokens?: number; output_tokens?: number } };
          if (turnCompletedEvent.usage && contextTracker) {
            await contextTracker.recordUsage({
              inputTokens: turnCompletedEvent.usage.input_tokens ?? 0,
              outputTokens: turnCompletedEvent.usage.output_tokens ?? 0,
            });
          }

          // Mark message as complete (only if we created one)
          if (responseId) {
            await client.complete(responseId);
            log(`Completed response for ${incoming.id}`);
          } else {
            // No response was created - cleanup typing indicator if still active
            await typing.cleanup();
            log(`No response message was created for ${incoming.id}`);
          }

          // Mark end of turn for context tracking
          if (contextTracker) {
            await contextTracker.endTurn();
          }
          break;
        }

        case "turn.failed": {
          const errorMsg = "error" in event && event.error && typeof event.error === "object" && "message" in event.error
            ? String(event.error.message)
            : "Unknown error";
          // Create a message for the error if none exists
          if (responseId) {
            await client.error(responseId, errorMsg);
          } else {
            const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
            await client.error(errorMsgId, errorMsg);
          }
          log(`Turn failed: ${errorMsg}`);
          break;
        }

        case "error": {
          // Handle ThreadErrorEvent - fatal stream error
          const errorEvent = event as { type: "error"; error?: { message?: string } };
          const errorMsg = errorEvent.error?.message ?? "Unknown stream error";
          log(`Stream error: ${errorMsg}`);
          // Create a message for the error if none exists
          if (responseId) {
            await client.error(responseId, errorMsg);
          } else {
            const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
            await client.error(errorMsgId, errorMsg);
          }
          break;
        }

        default:
          // Log unhandled event types for debugging
          log(`Unhandled event type: ${(event as { type: string }).type}`);
          break;
      }
    }
  } catch (err) {
    // Cleanup any pending thinking, typing, or action indicators to avoid orphaned messages
    await thinking.cleanup();
    await typing.cleanup();
    await action.cleanup();
    // Flush any pending context usage updates
    if (contextTracker) {
      await contextTracker.cleanup();
    }

    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Codex Worker] Error:`, err);

    // Create a message for the error if none exists
    if (responseId) {
      await client.error(responseId, err instanceof Error ? err.message : String(err));
    } else {
      const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
      await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
    }
  } finally {
    // Cleanup per-message resources (but NOT codexHome - it persists across messages)
    interruptHandler.cleanup();
    if (mcpServer) {
      await mcpServer.close();
    }
    // Note: codexHome is NOT cleaned up here - it persists for session continuity
    // It will be cleaned up when the worker unloads
  }
}

void main().catch((err) => {
  console.error("[Codex Worker] Fatal error:", err);
  process.exit(1);
});
