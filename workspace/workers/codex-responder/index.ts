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
  createPauseToolDefinition,
  type AgenticClient,
  type ChatParticipantMetadata,
} from "@natstack/agentic-messaging";
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

/**
 * Tool definition for MCP server
 */
interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
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

    mcpServer.tool(
      toolDef.name,
      toolDef.description ?? `Tool: ${toolDef.name}`,
      inputSchema,
      async (args: Record<string, unknown>) => {
        log(`Tool call: ${toolDef.name} args=${formatArgsForLog(args)}`);
        try {
          const result = await executeTool(toolDef.name, args);
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
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: channelName,
    reconnect: true,
    metadata: {
      name: "Codex",
      type: "codex",
      handle,
    },
    tools: {
      pause: createPauseToolDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
    },
  });

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  await client.ready();
  log(`Connected to channel: ${channelName}`);

  // Process incoming events using unified API
  for await (const event of client.events()) {
    if (event.type !== "message") continue;

    // Skip replay messages - don't respond to historical messages
    if (event.kind === "replay") continue;

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      await handleUserMessage(client, event.id, event.content, workingDirectory);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  userMessageId: string,
  userText: string,
  workingDirectory: string | undefined
) {
  log(`Received message: ${userText}`);

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants`);

  // Start a new message (empty, will stream content via updates)
  const responseId = await client.send("", { replyTo: userMessageId });

  // Convert tool definitions for MCP server
  const mcpTools: ToolDefinition[] = toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
  }));

  let mcpServer: McpHttpServer | null = null;
  let codexHome: string | null = null;

  try {
    // Start MCP HTTP server if we have tools
    if (mcpTools.length > 0) {
      mcpServer = await createMcpHttpServer(mcpTools, executeTool);
      const mcpServerUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;
      codexHome = createCodexConfig(mcpServerUrl);
    }

    // Set up RPC pause handler - monitors for pause tool calls
    const interruptHandler = createInterruptHandler({
      client,
      messageId: userMessageId,
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

    const thread = codex.startThread({
      skipGitRepoCheck: true,
      ...(workingDirectory && { cwd: workingDirectory }),
    });

    // Run with streaming
    const { events } = await thread.runStreamed(userText);

    // Track text length per item to compute deltas correctly
    const itemTextLengths = new Map<string, number>();

    for await (const event of events) {
      // Break if pause RPC was received
      if (interruptHandler.isPaused()) {
        log(`Execution paused, stopping event processing`);
        break;
      }
      switch (event.type) {
        case "item.updated": {
          // Handle text content from agent messages (streaming)
          // AgentMessageItem has: { id, type: "agent_message", text: string }
          const item = event.item as { id?: string; type?: string; text?: string };
          if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              await client.update(responseId, delta);
              itemTextLengths.set(item.id, item.text.length);
            }
          }
          break;
        }

        case "item.completed": {
          // Extract final text from completed item if we haven't streamed it yet
          const item = "item" in event ? (event.item as { id?: string; type?: string; text?: string }) : null;
          if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              await client.update(responseId, delta);
              itemTextLengths.set(item.id, item.text.length);
            }
          }
          break;
        }

        case "turn.completed":
          // Mark message as complete
          await client.complete(responseId);
          log(`Completed response for ${userMessageId}`);
          break;

        case "turn.failed": {
          const errorMsg = "error" in event && event.error && typeof event.error === "object" && "message" in event.error
            ? String(event.error.message)
            : "Unknown error";
          await client.error(responseId, errorMsg);
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
    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Codex Worker] Error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
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
