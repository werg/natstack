/**
 * Agentic Chat AI Responder Worker
 *
 * Demonstrates @natstack/agentic-messaging for real-time messaging.
 * Listens for user messages on a channel and responds using AI streaming.
 */

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  createLogger,
  parseAgentConfig,
  createInterruptHandler,
  createPauseToolDefinition,
  formatMissedContext,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import { ai } from "@natstack/ai";

// Set worker title
void setTitle("Chat AI Responder");

const log = createLogger("Worker", id);

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get channel from environment (passed by broker via process.env)
  const channelName = process.env.CHANNEL;

  // Parse agent config from environment (passed by broker as JSON)
  const agentConfig = parseAgentConfig();

  // Get handle from config (set by broker from invite), fallback to default
  const handle = typeof agentConfig.handle === "string" ? agentConfig.handle : "ai";

  // Get workspace ID from environment
  const workspaceId = process.env["NATSTACK_WORKSPACE_ID"];

  log("Starting chat responder...");
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel with reconnection and participant metadata
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "AI Responder",
    type: "ai-responder",
    workspaceId,
    reconnect: true,
    tools: {
      pause: createPauseToolDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
    },
  });

  // Log roster changes
  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map(p => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  log(`Connected to channel: ${channelName}`);
  if (client.sessionKey) {
    log(`Session: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}`);
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

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      let prompt = event.content;
      if (pendingMissedContext && pendingMissedContext.count > 0) {
        prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
        lastMissedPubsubId = pendingMissedContext.lastPubsubId;
        pendingMissedContext = null;
      }
      await handleUserMessage(client, event, prompt);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string
) {
  log(`Received message: ${incoming.content}`);

  // Start a new message (empty, will stream content via updates)
  const { messageId: responseId } = await client.send("", { replyTo: incoming.id });

  // Set up interrupt handler to monitor for pause requests
  const interruptHandler = createInterruptHandler({
    client,
    messageId: incoming.id,
    onPause: (reason) => {
      log(`Pause RPC received: ${reason}`);
    }
  });

  // Start monitoring for pause events in background
  void interruptHandler.monitor();

  try {
    // Build conversation history from previous messages (limit to last 20 messages for token efficiency)
    let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      conversationHistory = await client.getHistory(20);
      if (conversationHistory.length > 0) {
        log(`Loaded ${conversationHistory.length} previous messages from history`);
      }
    } catch (err) {
      // Continue without history if load fails
      console.error("Failed to load conversation history:", err);
    }

    // Add current user message to history
    const messages = [
      ...conversationHistory,
      { role: "user" as const, content: prompt }
    ];

    // Stream AI response using fast model
    const stream = ai.streamText({
      model: "fast",
      system: "You are a helpful, concise assistant. Keep responses brief and friendly.",
      messages,
      maxOutputTokens: 500,
    });

    // Store user message in history
    try {
      await client.storeMessage("user", incoming.content);
    } catch (err) {
      console.error("Failed to store user message:", err);
    }

    // Accumulate assistant response for storage
    let assistantResponse = "";
    let checkpointCommitted = false;

    for await (const event of stream) {
      // Check if pause was requested
      if (interruptHandler.isPaused()) {
        log("Execution paused, stopping stream");
        break;
      }

      if (event.type === "text-delta") {
        // Accumulate response
        assistantResponse += event.text;
        // Send content delta (persisted for replay)
        await client.update(responseId, event.text);

        if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
          await client.commitCheckpoint(incoming.pubsubId);
          checkpointCommitted = true;
        }
      }
    }

    // Store complete assistant response in history
    if (assistantResponse) {
      try {
        await client.storeMessage("assistant", assistantResponse);
      } catch (err) {
        console.error("Failed to store assistant message:", err);
      }
    }

    if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
      await client.commitCheckpoint(incoming.pubsubId);
    }

    // Mark message as complete
    await client.complete(responseId);

    log(`Completed response for ${incoming.id}`);

  } catch (err) {
    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Worker] AI error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

// Start the worker
void main();
