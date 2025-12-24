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
  type AgenticClient,
  type ChatParticipantMetadata,
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

  log("Starting chat responder...");
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel with reconnection and participant metadata
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: channelName,
    reconnect: true,
    metadata: {
      name: "AI Responder",
      type: "ai-responder",
      handle,
    },
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
      await handleUserMessage(client, event.id, event.content);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  userMessageId: string,
  userText: string
) {
  log(`Received message: ${userText}`);

  // Start a new message (empty, will stream content via updates)
  const responseId = await client.send("", { replyTo: userMessageId });

  // Set up interrupt handler to monitor for pause requests
  const interruptHandler = createInterruptHandler({
    client,
    messageId: userMessageId,
    onPause: (reason) => {
      log(`Pause RPC received: ${reason}`);
    }
  });

  // Start monitoring for pause events in background
  void interruptHandler.monitor();

  try {

    // Stream AI response using fast model
    const stream = ai.streamText({
      model: "fast",
      system: "You are a helpful, concise assistant. Keep responses brief and friendly.",
      messages: [{ role: "user", content: userText }],
      maxOutputTokens: 500,
    });

    for await (const event of stream) {
      // Check if pause was requested
      if (interruptHandler.isPaused()) {
        log("Execution paused, stopping stream");
        break;
      }

      if (event.type === "text-delta") {
        // Send content delta (persisted for replay)
        await client.update(responseId, event.text);
      }
    }

    // Mark message as complete
    await client.complete(responseId);

    log(`Completed response for ${userMessageId}`);

  } catch (err) {
    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Worker] AI error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

// Start the worker
void main();
