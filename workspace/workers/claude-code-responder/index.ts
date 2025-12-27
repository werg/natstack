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
  jsonSchemaToZodRawShape,
  parseAgentConfig,
  createLogger,
  formatArgsForLog,
  createInterruptHandler,
  createPauseToolDefinition,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  formatMissedContext,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import { query, tool, createSdkMcpServer, type Query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

void setTitle("Claude Code Responder");

const log = createLogger("Claude Code", id);

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
  const handle = typeof agentConfig.handle === "string" ? agentConfig.handle : "claude";

  // Get workspace ID from environment
  const workspaceId = process.env["NATSTACK_WORKSPACE_ID"];

  log("Starting Claude Code responder...");
  if (workingDirectory) {
    log(`Working directory: ${workingDirectory}`);
  }
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "Claude Code",
    type: "claude-code",
    workspaceId,
    reconnect: true,
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

  log(`Connected to channel: ${channelName}`);
  if (client.sessionKey) {
    log(`Session: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}, SDK: ${client.sdkSessionId ?? "none"}`);
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

  // Process incoming events using unified API
  for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
    if (event.type !== "message") continue;

    // Skip replay messages - don't respond to historical messages
    if (event.kind === "replay") continue;

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      let prompt = event.content;
      if (pendingMissedContext && pendingMissedContext.count > 0) {
        prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
        lastMissedPubsubId = pendingMissedContext.lastPubsubId;
        pendingMissedContext = null;
      }
      await handleUserMessage(client, event, prompt, workingDirectory);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  workingDirectory: string | undefined
) {
  log(`Received message: ${incoming.content}`);

  // Create tools from other pubsub participants
  const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
    namePrefix: "pubsub",
  });

  log(`Discovered ${toolDefs.length} tools from pubsub participants`);

  // Start a new message (empty, will stream content via updates)
  const { messageId: responseId } = await client.send("", { replyTo: incoming.id });

  try {
    // Keep reference to the query for interrupt handling via RPC pause mechanism
    let queryInstance: Query | null = null;

    // Set up RPC pause handler - monitors for pause tool calls
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: async (reason) => {
        log(`Pause RPC received: ${reason}`);
        // Break out of the query loop via isPaused() check
        // The pause tool returns successfully (not an error)
      }
    });

    // Start monitoring for pause events in background
    void interruptHandler.monitor();

    // Convert pubsub tools to Claude Agent SDK MCP tools
    const mcpTools = toolDefs.map((toolDef) =>
      tool(
        toolDef.name,
        toolDef.description ?? "",
        jsonSchemaToZodRawShape(toolDef.parameters),
        async (args: unknown) => {
          log(`Tool call: ${toolDef.name} args=${formatArgsForLog(args)}`);
          const result = await executeTool(toolDef.name, args);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        }
      )
    );

    // Create MCP server with only pubsub tools (NOT pause - that's RPC only)
    const pubsubServer = createSdkMcpServer({
      name: "pubsub",
      version: "1.0.0",
      tools: mcpTools,
    });

    // Determine allowed tools
    const allowedTools = mcpTools.map((t) => `mcp__pubsub__${t.name}`);

    // Get session state for resumption
    const queryOptions: Parameters<typeof query>[0]["options"] = {
      mcpServers: { pubsub: pubsubServer },
      ...(allowedTools.length > 0 && { allowedTools }),
      // Disable built-in tools - we only want pubsub tools
      disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Task"],
      // Set working directory if provided via config
      ...(workingDirectory && { cwd: workingDirectory }),
      // Enable streaming of partial messages for token-by-token delivery
      includePartialMessages: true,
      // Resume from previous session if available
      ...(client.sdkSessionId && { resume: client.sdkSessionId }),
    };

    // Query Claude using the Agent SDK
    queryInstance = query({
      prompt,
      options: queryOptions,
    });

    let capturedSessionId: string | undefined;
    let checkpointCommitted = false;
    let sawStreamedText = false;

    for await (const message of queryInstance) {
      // Check if pause was requested and break early
      if (interruptHandler.isPaused()) {
        log("Execution paused, breaking out of query loop");
        break;
      }

      if (message.type === "stream_event") {
        // Handle streaming message events (token-by-token with includePartialMessages: true)
        const streamEvent = message.event as { type: string; delta?: { type: string; text?: string } };

        // Only handle text deltas from content blocks
        if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
          if (streamEvent.delta.text) {
            // Send each text delta immediately (real streaming)
            await client.update(responseId, streamEvent.delta.text);
            sawStreamedText = true;

            if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
              await client.commitCheckpoint(incoming.pubsubId);
              checkpointCommitted = true;
            }
          }
        }
      } else if (message.type === "assistant") {
        // Fallback for complete assistant messages when no streaming deltas were seen.
        if (!sawStreamedText) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              await client.update(responseId, block.text);
            }
          }
        }
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

    if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
      await client.commitCheckpoint(incoming.pubsubId);
      checkpointCommitted = true;
    }

    // Store session ID for resumption
    if (capturedSessionId && client.sessionKey) {
      await client.updateSdkSession(capturedSessionId);
      log(`Session ID stored: ${capturedSessionId}`);
    } else if (capturedSessionId) {
      log("Skipping session update (workspaceId not set)");
    }

    // Mark message as complete (whether interrupted or finished normally)
    await client.complete(responseId);
    log(`Completed response for ${incoming.id}`);
  } catch (err) {
    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Claude Code] Error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

void main();
