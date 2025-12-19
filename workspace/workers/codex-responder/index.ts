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
  type AgenticClient,
  type AgenticParticipantMetadata,
} from "@natstack/agentic-messaging";
import { Codex } from "@openai/codex-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

void setTitle("Codex Responder");

const CHANNEL_NAME = "agentic-chat-demo";

interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "worker" | "claude-code" | "codex";
}

function log(message: string): void {
  console.log(`[Codex Worker ${id}] ${message}`);
}

/**
 * Tool definition for MCP server
 */
interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Convert JSON Schema to Zod schema.
 * Simplified conversion that handles common JSON Schema patterns.
 */
function convertJsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema["type"] as string | undefined;

  switch (type) {
    case "string": {
      const enumValues = schema["enum"] as string[] | undefined;
      if (enumValues && enumValues.length > 0) {
        return z.enum(enumValues as [string, ...string[]]);
      }
      return z.string();
    }
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = schema["items"] as Record<string, unknown> | undefined;
      if (items) {
        return z.array(convertJsonSchemaToZod(items));
      }
      return z.array(z.unknown());
    }
    case "object": {
      const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
      const required = (schema["required"] as string[]) || [];

      if (!properties) {
        return z.record(z.string(), z.unknown());
      }
      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const zodType = convertJsonSchemaToZod(propSchema);
        shape[key] = required.includes(key) ? zodType : zodType.optional();
      }
      return z.object(shape);
    }
    case "null":
      return z.null();
    default:
      // Handle union types
      if (schema["anyOf"] || schema["oneOf"]) {
        const variants = (schema["anyOf"] || schema["oneOf"]) as Record<string, unknown>[];
        if (variants.length === 0) {
          return z.unknown();
        } else if (variants.length === 1) {
          return convertJsonSchemaToZod(variants[0]!);
        } else {
          const zodVariants = variants.map(convertJsonSchemaToZod) as [z.ZodType, z.ZodType, ...z.ZodType[]];
          return z.union(zodVariants);
        }
      }
      return z.unknown();
  }
}

/**
 * Convert JSON Schema to a shape object for tool registration.
 */
function jsonSchemaToShape(schema: Record<string, unknown>): z.ZodRawShape {
  const type = schema["type"] as string | undefined;

  if (type === "object") {
    const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
    const required = (schema["required"] as string[]) || [];

    if (!properties) {
      return {};
    }

    const shape: z.ZodRawShape = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const zodType = convertJsonSchemaToZod(propSchema);
      shape[key] = required.includes(key) ? zodType : zodType.optional();
    }
    return shape;
  }

  // Non-object schemas get wrapped
  return { input: convertJsonSchemaToZod(schema) };
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

  // Register tools
  for (const toolDef of tools) {
    const inputSchema = jsonSchemaToShape(toolDef.parameters);

    mcpServer.tool(
      toolDef.name,
      toolDef.description ?? `Tool: ${toolDef.name}`,
      inputSchema,
      async (args: Record<string, unknown>) => {
        log(`Tool call: ${toolDef.name}`);
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

  log("Starting Codex responder...");

  // Connect to agentic messaging channel
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: CHANNEL_NAME,
    reconnect: true,
    metadata: {
      name: "Codex",
      type: "codex",
    },
  });

  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map((p) => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  await client.ready();
  log(`Connected to channel: ${CHANNEL_NAME}`);

  // Process incoming messages
  for await (const msg of client.messages()) {
    if (msg.type !== "message") continue;

    const sender = client.roster[msg.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && msg.senderId !== id) {
      await handleUserMessage(client, msg.id, msg.content);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  userMessageId: string,
  userText: string
) {
  log(`Received message: ${userText}`);

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants`);

  // Start a new message (empty, will stream content via updates)
  const responseId = await client.send("", { replyTo: userMessageId, persist: false });

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

    // Initialize Codex SDK with custom config location
    // Only pass through necessary env vars to avoid leaking sensitive data
    // Filter out undefined values to avoid passing them to the subprocess
    const baseEnv: Record<string, string> = {};
    if (process.env["PATH"]) baseEnv["PATH"] = process.env["PATH"];
    if (process.env["HOME"]) baseEnv["HOME"] = process.env["HOME"];
    if (process.env["OPENAI_API_KEY"]) baseEnv["OPENAI_API_KEY"] = process.env["OPENAI_API_KEY"];
    if (process.env["CODEX_API_KEY"]) baseEnv["CODEX_API_KEY"] = process.env["CODEX_API_KEY"];
    if (codexHome) baseEnv["CODEX_HOME"] = codexHome;

    // Use globally installed codex from PATH
    // The SDK's vendored binary detection doesn't work in bundled environments,
    // so we explicitly point to the global installation
    const codex = new Codex({
      codexPathOverride: "codex", // Use PATH lookup
      env: Object.keys(baseEnv).length > 0 ? baseEnv : undefined,
    });

    const thread = codex.startThread({
      skipGitRepoCheck: true,
    });

    // Run with streaming
    const { events } = await thread.runStreamed(userText);

    // Track text length per item to compute deltas correctly
    const itemTextLengths = new Map<string, number>();

    for await (const event of events) {
      switch (event.type) {
        case "item.updated": {
          // Handle text content from agent messages (streaming)
          // AgentMessageItem has: { id, type: "agent_message", text: string }
          const item = event.item as { id?: string; type?: string; text?: string };
          if (item && item.type === "agent_message" && typeof item.text === "string" && item.id) {
            const prevLength = itemTextLengths.get(item.id) ?? 0;
            if (item.text.length > prevLength) {
              const delta = item.text.slice(prevLength);
              await client.update(responseId, delta, { persist: false });
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
              await client.update(responseId, delta, { persist: false });
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
    console.error(`[Codex Worker] Error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  } finally {
    // Cleanup
    if (mcpServer) {
      await mcpServer.close();
    }
    if (codexHome) {
      cleanupCodexConfig(codexHome);
    }
  }
}

void main();
