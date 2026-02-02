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

import { Agent, runAgent, type AgentState } from "@natstack/agent-runtime";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createMissedContextManager,
  createTrackerManager,
  createStandardMcpTools,
  executeStandardMcpTool,
} from "@natstack/agent-patterns";
import {
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  createLogger,
  formatArgsForLog,
  createPauseMethodDefinition,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  validateRestrictedMode,
  getCanonicalToolName,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  buildOpenAIContents,
  filterImageAttachments,
  validateAttachments,
  type ContextWindowUsage,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import type { Attachment } from "@natstack/pubsub";
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
  autonomyLevel?: number; // 0=restricted/read-only, 1=standard/workspace, 2=autonomous/full-access
  webSearchEnabled?: boolean;
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

/**
 * Create temporary Codex config directory with MCP server configuration.
 */
function createCodexConfig(mcpServerUrl: string, log: (msg: string) => void): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-"));
  const configPath = path.join(codexHome, "config.toml");

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
 * Clean up temporary Codex config.
 */
function cleanupCodexConfig(codexHome: string, log: (msg: string) => void): void {
  try {
    fs.rmSync(codexHome, { recursive: true, force: true });
    log(`Cleaned up Codex config at ${codexHome}`);
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// Codex Agent
// =============================================================================

class CodexResponderAgent extends Agent<CodexAgentState, ChatParticipantMetadata> {
  // Pattern helpers from @natstack/agent-patterns
  private queue!: ReturnType<typeof createMessageQueue>;
  private interrupt!: ReturnType<typeof createInterruptController>;
  private settingsMgr!: ReturnType<typeof createSettingsManager<CodexSettings>>;
  private missedContext!: ReturnType<typeof createMissedContextManager>;
  private trackers!: ReturnType<typeof createTrackerManager>;
  private logFn!: (msg: string) => void;

  // Channel configuration
  private workingDirectory?: string;
  private isRestrictedMode = false;

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
    return {
      name: "Codex",
      type: "codex" as const,
      reconnect: true,
      methods: {
        pause: createPauseMethodDefinition(async () => {
          this.interrupt.pause();
          this.interrupt.abortCurrent();
          this.logFn("Pause RPC received");
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
            this.logFn(`Set channel title to: ${title}`);
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
    // Create a simple logger wrapper for patterns that need (msg: string) => void
    this.logFn = createLogger("Codex Agent", this.ctx.agentId);

    // Initialize message queue with correct API
    this.queue = createMessageQueue({
      onProcess: (event) => this.handleUserMessage(event as IncomingNewMessage),
      onError: (err, event) => this.logFn(`Error processing message ${(event as IncomingNewMessage).id}: ${err}`),
    });

    // Initialize interrupt controller (no arguments, or options object)
    this.interrupt = createInterruptController();

    // Initialize missed context manager with correct API
    this.missedContext = createMissedContextManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: 8000,
    });

    // Initialize trackers once at agent level (use setReplyTo per message)
    this.trackers = createTrackerManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      senderInfo: {
        senderId: (this.ctx.client as AgenticClient<ChatParticipantMetadata>).clientId ?? "",
        senderName: "Codex",
        senderType: "codex",
      },
      log: (msg) => this.logFn(msg),
    });

    // Initialize settings with 3-way merge (correct API)
    this.settingsMgr = createSettingsManager<CodexSettings>({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      defaults: { reasoningEffort: 2, autonomyLevel: 1 },
      initConfig: {
        model: this.ctx.config["model"] as string | undefined,
        reasoningEffort: this.ctx.config["reasoningEffort"] as number | undefined,
        autonomyLevel: this.ctx.config["autonomyLevel"] as number | undefined,
        webSearchEnabled: this.ctx.config["webSearchEnabled"] as boolean | undefined,
      },
    });
    await this.settingsMgr.load();

    // Get channel config
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;
    const channelConfigWorkingDirectory = client.channelConfig?.workingDirectory;
    const channelConfigRestrictedMode = client.channelConfig?.restrictedMode;
    this.workingDirectory =
      (this.ctx.config["workingDirectory"] as string | undefined)?.trim() ||
      channelConfigWorkingDirectory?.trim() ||
      process.env["NATSTACK_WORKSPACE"];
    this.isRestrictedMode =
      (this.ctx.config["restrictedMode"] as boolean | undefined) ?? channelConfigRestrictedMode ?? false;

    if (this.workingDirectory) {
      this.logFn(`Working directory: ${this.workingDirectory}`);
    }
    if (this.isRestrictedMode) {
      this.logFn(`Restricted mode: enabled`);
    }

    // Validate restricted mode requirements
    if (this.isRestrictedMode) {
      await validateRestrictedMode(client, this.logFn);
    }

    // Initialize local SDK session fallback from persisted state or client
    if (client.sdkSessionId) {
      this.localSdkSessionId = client.sdkSessionId;
      this.logFn(`Initialized local SDK session from client: ${this.localSdkSessionId}`);
    } else if (this.state.sdkSessionId) {
      this.localSdkSessionId = this.state.sdkSessionId;
      this.logFn(`Initialized local SDK session from state: ${this.localSdkSessionId}`);
    }

    // Handle roster changes (for auto-sleep logic when no panels remain)
    client.onRoster((roster) => {
      const names = Object.values(roster.participants).map(
        (p) => `${p.metadata.name} (${p.metadata.type})`
      );
      this.logFn(`Roster updated: ${names.join(", ")}`);
    });

    // Handle reconnection for missed context
    client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    this.logFn("Codex agent woke up");
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
      this.queue.enqueue(msgEvent);
    }
  }

  async onSleep(): Promise<void> {
    // Stop queue and drain pending work
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();

    // NOTE: Settings are persisted by SettingsManager via pubsub session storage.
    // We don't need to store them in agent state.

    this.logFn("Codex agent going to sleep");
  }

  private async handleSettingsMenu(): Promise<{
    success: boolean;
    cancelled?: boolean;
    error?: string;
    settings?: CodexSettings;
  }> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const panel = Object.values(client.roster).find(
      (p) => p.metadata.type === "panel"
    );
    if (!panel) throw new Error("No panel found");

    const fields = CODEX_PARAMETERS.filter((p) => !p.channelLevel);
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
      this.logFn("Settings cancelled");
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      this.logFn(`Settings error: ${feedbackResult.message}`);
      return { success: false, error: feedbackResult.message };
    }

    const newSettings = feedbackResult.value as CodexSettings;
    await this.settingsMgr.update(newSettings);
    this.logFn(`Settings updated: ${JSON.stringify(this.settingsMgr.get())}`);

    // Settings are automatically persisted by SettingsManager via pubsub session storage

    return { success: true, settings: this.settingsMgr.get() };
  }

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    this.logFn(`Received message: ${incoming.content}`);
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;

    // Get abort signal for this operation
    const signal = this.interrupt.createAbortSignal();

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
        this.logFn(`Attachment validation failed: ${validation.error}`);
      }
      this.logFn(`Processing ${imageAttachments.length} image attachment(s)`);
    }

    // Build multimodal prompt content if images are present
    const promptContent =
      imageAttachments.length > 0 ? buildOpenAIContents(prompt, imageAttachments) : prompt;

    // Create tools from other pubsub participants
    const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
      namePrefix: "pubsub",
    });

    this.logFn(
      `Discovered ${toolDefs.length} tools from pubsub participants${this.isRestrictedMode ? " (restricted mode)" : ""}`
    );

    // Set replyTo for trackers (trackers created once at agent level)
    this.trackers.setReplyTo(incoming.id);

    // Start typing indicator
    await this.trackers.typing.startTyping("preparing response");

    // Defer creating response message until we have content
    let responseId: string | null = null;
    const ensureResponseMessage = async (): Promise<string> => {
      if (this.trackers.typing.isTyping()) {
        await this.trackers.typing.stopTyping();
      }
      if (!responseId) {
        const { messageId } = await client.send("", { replyTo: incoming.id });
        responseId = messageId;
        this.logFn(`Created response message: ${responseId}`);
      }
      return responseId;
    };

    // Build MCP tool definitions
    const mcpTools: ToolDefinition[] = this.buildMcpTools(toolDefs);

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
      const displayName = originalToDisplayName.get(name) ?? name;
      const argsRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      await this.trackers.action.startAction({
        type: displayName,
        description: getDetailedActionDescription(displayName, argsRecord),
        toolUseId,
      });

      try {
        // Handle standard tools (set_title, TodoWrite)
        const standardResult = await executeStandardMcpTool(name, argsRecord, {
          client,
          log: (msg) => this.logFn(msg),
        });
        if (standardResult.handled) {
          await this.trackers.action.completeAction();
          return standardResult.result;
        }

        const result = await executeTool(name, args);
        await this.trackers.action.completeAction();
        return result;
      } catch (err) {
        await this.trackers.action.completeAction();
        throw err;
      }
    };

    let mcpServer: McpHttpServer | null = null;
    let codexHome: string | null = null;

    try {
      // Start MCP HTTP server if we have tools
      if (mcpTools.length > 0) {
        mcpServer = await createMcpHttpServer(mcpTools, executeToolWithActions, this.logFn);
        const mcpServerUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
        codexHome = createCodexConfig(mcpServerUrl, this.logFn);
      }

      // Initialize Codex SDK
      const baseEnv: Record<string, string> = {};
      if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
      if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];
      if (process.env["OPENAI_API_KEY"]) baseEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
      if (process.env["CODEX_API_KEY"]) baseEnv["CODEX_API_KEY"] = process.env["CODEX_API_KEY"];
      if (codexHome) baseEnv["CODEX_HOME"] = codexHome;

      // Only set workspace env vars in unrestricted mode
      if (!this.isRestrictedMode) {
        const workspaceOverride = this.workingDirectory ?? process.env["NATSTACK_WORKSPACE"];
        if (workspaceOverride) {
          baseEnv["NATSTACK_WORKSPACE"] = workspaceOverride;
          baseEnv["PWD"] = workspaceOverride;
        }
      }

      const codex = new Codex({
        codexPathOverride: "codex",
        env: Object.keys(baseEnv).length > 0 ? baseEnv : undefined,
      });

      let thread: ReturnType<typeof codex.startThread> | ReturnType<typeof codex.resumeThread>;

      // Build thread options
      const settings = this.settingsMgr.get();
      const reasoningEffort = getReasoningEffort(settings.reasoningEffort);
      const sandboxMode = this.isRestrictedMode
        ? "read-only"
        : getSandboxModeFromAutonomy(settings.autonomyLevel);

      const threadOptions = {
        skipGitRepoCheck: true,
        ...(!this.isRestrictedMode && this.workingDirectory && { cwd: this.workingDirectory }),
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
        this.logFn(`Resuming Codex thread: ${resumeSessionId} (${source})`);
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } else {
        this.logFn("Starting new Codex thread");
        thread = codex.startThread(threadOptions);
      }

      // Build system prompt
      let promptWithSystem: string | typeof promptContent;
      if (typeof promptContent === "string") {
        promptWithSystem = this.isRestrictedMode
          ? `${createRestrictedModeSystemPrompt()}\n\n${promptContent}`
          : `${createRichTextChatSystemPrompt()}\n\n${promptContent}`;
      } else {
        const systemPrompt = this.isRestrictedMode
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
      let currentAgentMessageId: string | null = null;
      let checkpointCommitted = false;

      for await (const event of events) {
        // Check for abort
        if (signal.aborted) {
          this.logFn(`Execution aborted, stopping event processing`);
          break;
        }

        switch (event.type) {
          case "thread.started": {
            const threadEvent = event as unknown as Record<string, unknown>;
            if (threadEvent["thread_id"]) {
              const threadId = String(threadEvent["thread_id"]);
              // Always update local fallback (for resumption within same agent lifetime)
              this.localSdkSessionId = threadId;
              // Persist to state
              this.setState({ sdkSessionId: threadId });
              // Also persist to server if possible (for cross-agent resumption)
              if (client.sessionKey) {
                void client.updateSdkSession(threadId).catch((err) => {
                  this.logFn(`Failed to persist SDK session to server: ${err}`);
                });
              }
              this.logFn(`Thread ID stored: ${threadId}${client.sessionKey ? "" : " (local only)"}`);
            }
            break;
          }

          case "item.started":
          case "item.updated": {
            const item = event.item as { id?: string; type?: string; text?: string };

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

                if (!checkpointCommitted) {
                  if (incoming.pubsubId !== undefined) this.commitCheckpoint(incoming.pubsubId);
                  checkpointCommitted = true;
                }
              }
            }
            break;
          }

          case "item.completed": {
            const item =
              "item" in event
                ? (event.item as { id?: string; type?: string; text?: string })
                : null;

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

                if (!checkpointCommitted) {
                  if (incoming.pubsubId !== undefined) this.commitCheckpoint(incoming.pubsubId);
                  checkpointCommitted = true;
                }
              }
            }
            break;
          }

          case "turn.completed": {
            if (!checkpointCommitted) {
              if (incoming.pubsubId !== undefined) this.commitCheckpoint(incoming.pubsubId);
              checkpointCommitted = true;
            }

            if (responseId) {
              await client.complete(responseId);
              this.logFn(`Completed response for ${incoming.id}`);
            } else {
              await this.trackers.typing.cleanup();
              this.logFn(`No response message was created for ${incoming.id}`);
            }
            break;
          }

          case "turn.failed": {
            const errorMsg =
              "error" in event && event.error && typeof event.error === "object" && "message" in event.error
                ? String(event.error.message)
                : "Unknown error";
            if (responseId) {
              await client.error(responseId, errorMsg);
            } else {
              const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
              await client.error(errorMsgId, errorMsg);
            }
            this.logFn(`Turn failed: ${errorMsg}`);
            break;
          }

          default:
            this.logFn(`Unhandled event type: ${(event as { type: string }).type}`);
            break;
        }
      }
    } catch (err) {
      // Cleanup trackers (use cleanupAll for simplicity)
      await this.trackers.cleanupAll();

      console.error(`[Codex Agent] Error:`, err);

      if (responseId) {
        await client.error(responseId, err instanceof Error ? err.message : String(err));
      } else {
        const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
        await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mcpServer) {
        await mcpServer.close();
      }
      if (codexHome) {
        cleanupCodexConfig(codexHome, this.logFn);
      }
    }
  }

  private buildMcpTools(
    toolDefs: Array<{
      name: string;
      description?: string;
      parameters: unknown;
      originalMethodName?: string;
    }>
  ): ToolDefinition[] {
    const mcpTools: ToolDefinition[] = toolDefs.map((t) => {
      const displayName = this.isRestrictedMode
        ? getCanonicalToolName((t as { originalMethodName?: string }).originalMethodName ?? t.name)
        : t.name;

      return {
        name: displayName,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
        originalName: t.name,
      };
    });

    // Add standard tools (set_title, TodoWrite)
    const standardMcpTools = createStandardMcpTools();
    for (const tool of standardMcpTools) {
      mcpTools.push(tool);
    }

    return mcpTools;
  }
}

// =============================================================================
// Bootstrap
// =============================================================================

void runAgent(CodexResponderAgent);
