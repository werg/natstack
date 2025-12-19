/**
 * Agentic Chat AI Responder Worker
 *
 * Demonstrates @natstack/agentic-messaging for real-time messaging.
 * Listens for user messages on a channel and responds using AI streaming.
 */

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  type AgenticClient,
  type AgenticParticipantMetadata,
} from "@natstack/agentic-messaging";
import { ai } from "@natstack/ai";

// Set worker title
void setTitle("Chat AI Responder");

/** Metadata for participants in this channel (shared with panel) */
interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

function log(message: string): void {
  console.log(`[Worker ${id}] ${message}`);
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get channel from environment (passed by broker via process.env)
  const channelName = process.env.CHANNEL;

  log("Starting chat responder...");

  // Connect to agentic messaging channel with reconnection and participant metadata
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: channelName,
    reconnect: true,
    metadata: {
      name: "AI Responder",
      type: "ai-responder",
    },
  });

  // Log roster changes
  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map(p => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  await client.ready();
  log(`Connected to channel: ${channelName}`);

  // Process incoming messages using typed API
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

  // Start a new message (empty, will stream content via updates)
  const responseId = await client.send("", { replyTo: userMessageId, persist: false });

  try {
    // Stream AI response using fast model
    const stream = ai.streamText({
      model: "fast",
      system: "You are a helpful, concise assistant. Keep responses brief and friendly.",
      messages: [{ role: "user", content: userText }],
      maxOutputTokens: 500,
    });

    for await (const event of stream) {
      if (event.type === "text-delta") {
        // Send content delta (ephemeral - not persisted)
        await client.update(responseId, event.text, { persist: false });
      }
    }

    // Mark message as complete (persisted for history)
    await client.complete(responseId);

    log(`Completed response for ${userMessageId}`);

  } catch (err) {
    console.error(`[Worker] AI error:`, err);
    // Send error
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

// Start the worker
void main();
