/**
 * PubSub Chat AI Responder Worker
 *
 * Demonstrates @natstack/pubsub for real-time messaging.
 * Listens for user messages on a channel and responds using AI streaming.
 */

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import { connect, type PubSubClient } from "@natstack/pubsub";
import { ai } from "@natstack/ai";

// Set worker title
void setTitle("Chat AI Responder");

// Configuration
const CHANNEL_NAME = "pubsub-chat-demo";

/**
 * Wire format: "message" - creates a new message
 */
interface NewMessage {
  id: string;
  content: string;
  replyTo?: string;
}

/**
 * Wire format: "update-message" - updates an existing message
 */
interface UpdateMessage {
  id: string;
  content?: string;
  /** Set to true to mark message as complete */
  complete?: boolean;
}

/**
 * Wire format: "error" - marks a message as errored
 */
interface ErrorMessage {
  id: string;
  error: string;
}

/** Metadata for participants in this channel (shared with panel) */
interface ChatParticipantMetadata {
  name: string;
  type: "panel" | "worker";
}

function log(message: string): void {
  console.log(`[Worker ${id}] ${message}`);
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  log("Starting chat responder...");

  // Connect to pubsub channel with reconnection and participant metadata
  const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
    channel: CHANNEL_NAME,
    reconnect: true,
    metadata: {
      name: "AI Responder",
      type: "worker",
    },
  });

  // Log roster changes
  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map(p => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);
  });

  await client.ready();
  log(`Connected to channel: ${CHANNEL_NAME}`);

  // Process incoming messages
  for await (const msg of client.messages()) {
    if (msg.type !== "message") continue;

    const payload = msg.payload as NewMessage;
    const sender = client.roster[msg.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && msg.senderId !== id) {
      await handleUserMessage(client, payload.id, payload.content);
    }
  }
}

async function handleUserMessage(
  client: PubSubClient<ChatParticipantMetadata>,
  userMessageId: string,
  userText: string
) {
  log(`Received message: ${userText}`);

  const responseId = `response-${userMessageId}`;

  // Create new message (will stream content via updates)
  await client.publish("message", {
    id: responseId,
    content: "",
    replyTo: userMessageId,
  } satisfies NewMessage, { persist: false });

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
        await client.publish("update-message", {
          id: responseId,
          content: event.text,
        } satisfies UpdateMessage, { persist: false });
      }
    }

    // Mark message as complete (persisted for history)
    await client.publish("update-message", {
      id: responseId,
      complete: true,
    } satisfies UpdateMessage);

    log(`Completed response for ${userMessageId}`);

  } catch (error) {
    console.error(`[Worker] AI error:`, error);
    // Send error
    await client.publish("error", {
      id: responseId,
      error: error instanceof Error ? error.message : String(error),
    } satisfies ErrorMessage);
  }
}

// Start the worker
void main();
