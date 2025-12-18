/**
 * Claude Code Responder Worker
 *
 * An unsafe worker that uses the Claude Agent SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Claude.
 */

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  type AgenticClient,
  type AgenticParticipantMetadata,
} from "@natstack/agentic-messaging";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

void setTitle("Claude Code Responder");

const CHANNEL_NAME = "agentic-chat-demo";

interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "worker" | "claude-code" | "codex";
}

function log(message: string): void {
  console.log(`[Claude Code ${id}] ${message}`);
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  log("Starting Claude Code responder...");

  // Connect to agentic messaging channel
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: CHANNEL_NAME,
    reconnect: true,
    metadata: {
      name: "Claude Code",
      type: "claude-code",
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

  try {
    // Convert pubsub tools to Claude Agent SDK MCP tools
    const mcpTools = toolDefs.map((toolDef) =>
      tool(
        toolDef.name,
        toolDef.description ?? "",
        toolDef.parameters as z.ZodRawShape,
        async (args: unknown) => {
          log(`Tool call: ${toolDef.name}`);
          const result = await executeTool(toolDef.name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
      )
    );

    // Create MCP server with pubsub tools
    const pubsubServer = mcpTools.length > 0
      ? createSdkMcpServer({
          name: "pubsub",
          version: "1.0.0",
          tools: mcpTools,
        })
      : undefined;

    // Determine allowed tools
    const allowedTools = mcpTools.map((t) => `mcp__pubsub__${t.name}`);

    // Query Claude using the Agent SDK
    for await (const message of query({
      prompt: userText,
      options: {
        ...(pubsubServer && { mcpServers: { pubsub: pubsubServer } }),
        ...(allowedTools.length > 0 && { allowedTools }),
        // Disable built-in tools - we only want pubsub tools
        disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
      },
    })) {
      if (message.type === "assistant") {
        // Extract text content from assistant message
        for (const block of message.message.content) {
          if (block.type === "text") {
            // Stream content delta
            await client.update(responseId, block.text, { persist: false });
          }
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Query failed: ${message.subtype}`);
        }
        log(`Query completed. Cost: $${message.total_cost_usd?.toFixed(4) ?? "unknown"}`);
      }
    }

    // Mark message as complete
    await client.complete(responseId);
    log(`Completed response for ${userMessageId}`);
  } catch (err) {
    console.error(`[Claude Code] Error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

void main();
