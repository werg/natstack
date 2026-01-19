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

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  parseAgentConfig,
  createLogger,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  formatMissedContext,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  validateRestrictedMode,
  getCanonicalToolName,
  createThinkingTracker,
  createTypingTracker,
  createActionTracker,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  // Image processing utilities
  buildOpenAIContents,
  filterImageAttachments,
  validateAttachments,
  type Attachment,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
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

void setTitle("Codex Responder");

const log = createLogger("Codex Worker", id);

/** Worker-local settings interface */
interface CodexWorkerSettings {
  model?: string;
  reasoningEffort?: number; // 0=minimal, 1=low, 2=medium, 3=high
  sandboxMode?: number; // 0=read-only, 1=workspace-write, 2=danger-full-access
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  // Restricted mode - use pubsub tools only (no built-in sandbox tools)
  restrictedMode?: boolean;
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

/** Map sandbox mode slider value to SDK string */
function getSandboxMode(level: number | undefined): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  switch (level) {
    case 0: return "read-only";
    case 1: return "workspace-write";
    case 2: return "danger-full-access";
    default: return undefined;
  }
}

/** Current settings state - initialized from agent config and persisted settings */
let currentSettings: CodexWorkerSettings = {};

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
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`);

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
      if (isInitializeRequest(body)) {
        // Create new session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        // Connect transport to MCP server
        await mcpServer.connect(transport);

        // Handle the request
        await transport.handleRequest(req, res, body);

        // Store session after handling (session ID is set by transport)
        const newSessionId = res.getHeader("mcp-session-id") as string | undefined;
        if (newSessionId) {
          sessions.set(newSessionId, transport);
          log(`MCP session created: ${newSessionId}`);

          // Clean up on close
          transport.onclose = () => {
            sessions.delete(newSessionId);
            log(`MCP session closed: ${newSessionId}`);
          };
        }
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
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      log(`MCP HTTP server closed`);
    },
  };
}

/**
 * Create temporary Codex config directory with MCP server configuration
 */
function createCodexConfig(mcpServerUrl: string): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
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
  log(`Created Codex config at ${configPath}`);

  return codexHome;
}

/**
 * Clean up temporary Codex config
 */
function cleanupCodexConfig(codexHome: string): void {
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
    log(`Cleaned up Codex config at ${codexHome}`);
  } catch {
    // Ignore cleanup errors
  }
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get channel from environment (passed by broker via process.env)
  const channelName = process.env.CHANNEL;

  // Parse agent config from environment (passed by broker as JSON)
  const agentConfig = parseAgentConfig();
  const configuredWorkingDirectory =
    typeof agentConfig.workingDirectory === "string" ? agentConfig.workingDirectory.trim() : "";
  const workingDirectory = configuredWorkingDirectory || process.env["NATSTACK_WORKSPACE"];

  // Get handle from config (set by broker from invite), fallback to default
  const handle = typeof agentConfig.handle === "string" ? agentConfig.handle : "codex";

  log("Starting Codex responder...");
  if (workingDirectory) {
    log(`Working directory: ${workingDirectory}`);
  }
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel
  // contextId is obtained automatically from the server's ready message
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "Codex",
    type: "codex",
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

          // Build fields (filter out workingDirectory which is set at init only)
          const fields = CODEX_PARAMETERS.filter((p) => p.key !== "workingDirectory");

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
    },
  });

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  log(`Connected to channel: ${channelName}`);

  // Initialize settings with proper precedence:
  // 1. Apply initialization config (from pre-connection UI)
  const initConfigSettings: CodexWorkerSettings = {};
  if (typeof agentConfig.model === "string") initConfigSettings.model = agentConfig.model;
  if (typeof agentConfig.reasoningEffort === "number") initConfigSettings.reasoningEffort = agentConfig.reasoningEffort;
  if (typeof agentConfig.sandboxMode === "number") initConfigSettings.sandboxMode = agentConfig.sandboxMode;
  if (typeof agentConfig.networkAccessEnabled === "boolean") initConfigSettings.networkAccessEnabled = agentConfig.networkAccessEnabled;
  if (typeof agentConfig.webSearchEnabled === "boolean") initConfigSettings.webSearchEnabled = agentConfig.webSearchEnabled;
  if (typeof agentConfig.restrictedMode === "boolean") initConfigSettings.restrictedMode = agentConfig.restrictedMode;
  Object.assign(currentSettings, initConfigSettings);
  if (Object.keys(initConfigSettings).length > 0) {
    log(`Applied init config: ${JSON.stringify(initConfigSettings)}`);
  }

  // 2. Apply persisted settings (runtime changes from previous sessions)
  if (client.sessionKey) {
    log(`Session: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}, SDK: ${client.sdkSessionId ?? "none"}`);

    try {
      const savedSettings = await client.getSettings<CodexWorkerSettings>();
      if (savedSettings) {
        Object.assign(currentSettings, savedSettings);
        log(`Applied persisted settings: ${JSON.stringify(savedSettings)}`);
      }
    } catch (err) {
      log(`Failed to load settings: ${err}`);
    }
  }

  if (Object.keys(currentSettings).length > 0) {
    log(`Final settings: ${JSON.stringify(currentSettings)}`);
  }

  // Validate required methods in restricted mode
  if (currentSettings.restrictedMode) {
    await validateRestrictedMode(client, log);
  }

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

  // Process incoming events using unified API
  for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
    if (event.type !== "message") continue;

    // Skip replay messages - don't respond to historical messages
    if (event.kind === "replay") continue;

    // Skip typing indicators - these are just presence notifications
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) continue;

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      let prompt = event.content;
      if (pendingMissedContext && pendingMissedContext.count > 0) {
        prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
        lastMissedPubsubId = pendingMissedContext.lastPubsubId;
        pendingMissedContext = null;
      }
      // Extract attachments from the event
      const attachments = (event as { attachments?: Attachment[] }).attachments;
      await handleUserMessage(client, event, prompt, workingDirectory, attachments);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  workingDirectory: string | undefined,
  attachments?: Attachment[]
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

  // Determine if we're in restricted mode
  const isRestrictedMode = currentSettings.restrictedMode === true;

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants${isRestrictedMode ? " (restricted mode)" : ""}`);

  // Create typing tracker for ephemeral "preparing response" indicator
  const typing = createTypingTracker({
    client,
    log,
    replyTo: incoming.id,
    senderInfo: {
      senderId: client.clientId ?? "",
      senderName: "Codex",
      senderType: "codex",
    },
  });

  // Start typing indicator while setting up
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

  let mcpServer: McpHttpServer | null = null;
  let codexHome: string | null = null;

  // Create a map from originalName -> displayName for action tracking
  const originalToDisplayName = new Map<string, string>();
  for (const tool of mcpTools) {
    if (tool.originalName) {
      originalToDisplayName.set(tool.originalName, tool.name);
    }
  }

  // Wrap executeTool with action tracking
  const executeToolWithActions = async (name: string, args: unknown): Promise<unknown> => {
    const toolUseId = randomUUID();
    // Get display name for better action descriptions (use canonical name if available)
    const displayName = originalToDisplayName.get(name) ?? name;
    const argsRecord = args && typeof args === "object" ? args as Record<string, unknown> : {};

    await action.startAction({
      type: displayName,
      description: getDetailedActionDescription(displayName, argsRecord),
      toolUseId,
    });

    try {
      const result = await executeTool(name, args);
      await action.completeAction();
      return result;
    } catch (err) {
      await action.completeAction();
      throw err;
    }
  };

  try {
    // Start MCP HTTP server if we have tools
    if (mcpTools.length > 0) {
      mcpServer = await createMcpHttpServer(mcpTools, executeToolWithActions);
      const mcpServerUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
      codexHome = createCodexConfig(mcpServerUrl);
    }

    // Set up RPC pause handler - monitors for pause tool calls
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: (reason) => {
        log(`Pause RPC received: ${reason}`);
      }
    });

    // Start monitoring for pause events in background
    void interruptHandler.monitor();

    // Initialize Codex SDK with custom config location
    // Only pass through necessary env vars to avoid leaking sensitive data
    // Filter out undefined values to avoid passing them to the subprocess
    const baseEnv: Record<string, string> = {};
    if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
    if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];
    if (process.env["OPENAI_API_KEY"]) baseEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
    if (process.env["CODEX_API_KEY"]) baseEnv["CODEX_API_KEY"] = process.env["CODEX_API_KEY"];
    if (codexHome) baseEnv["CODEX_HOME"] = codexHome;
    const workspaceOverride = workingDirectory ?? process.env["NATSTACK_WORKSPACE"];
    if (workspaceOverride) {
      baseEnv["NATSTACK_WORKSPACE"] = workspaceOverride;
      baseEnv["PWD"] = workspaceOverride;
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
    // In restricted mode, force sandbox to read-only (Codex uses MCP exclusively for tools)
    const sandboxMode = isRestrictedMode
      ? "read-only"
      : getSandboxMode(currentSettings.sandboxMode);
    const threadOptions = {
      skipGitRepoCheck: true,
      ...(workingDirectory && { cwd: workingDirectory }),
      ...(currentSettings.model && { model: currentSettings.model }),
      ...(reasoningEffort && { modelReasoningEffort: reasoningEffort }),
      ...(sandboxMode && { sandboxMode }),
      ...(currentSettings.networkAccessEnabled !== undefined && { networkAccessEnabled: currentSettings.networkAccessEnabled }),
      ...(currentSettings.webSearchEnabled !== undefined && { webSearchEnabled: currentSettings.webSearchEnabled }),
    };

    if (client.sdkSessionId) {
      // Resume from previous thread if available
      log(`Resuming Codex thread: ${client.sdkSessionId}`);
      thread = codex.resumeThread(client.sdkSessionId, threadOptions);
    } else {
      // Start new thread
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
            if (client.sessionKey) {
              await client.updateSdkSession(threadId);
              log(`Thread ID stored: ${threadId}`);
            }
          }
          break;
        }

        case "item.started":
        case "item.updated": {
          // Handle different item types
          const item = event.item as { id?: string; type?: string; text?: string };

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
          break;
        }

        case "item.completed": {
          // Extract final text from completed item if we haven't streamed it yet
          const item = "item" in event ? (event.item as { id?: string; type?: string; text?: string }) : null;

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
          break;
        }

        case "turn.completed":
          if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
            await client.commitCheckpoint(incoming.pubsubId);
            checkpointCommitted = true;
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
          break;

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
    // Cleanup resources
    if (mcpServer) {
      await mcpServer.close();
    }
    if (codexHome) {
      cleanupCodexConfig(codexHome);
    }
  }
}

void main();
