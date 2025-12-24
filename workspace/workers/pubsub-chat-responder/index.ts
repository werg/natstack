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
  SessionManager,
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

  // Get workspace ID from environment
  const workspaceId = process.env["NATSTACK_WORKSPACE_ID"] || "default";

  log("Starting chat responder...");
  log(`Handle: @${handle}`);

  // Initialize session manager for conversation resumption with manual history
  const sessionManager = new SessionManager({
    workspaceId,
    channelName,
    agentHandle: handle,
    sdkType: "manual",
  });

  try {
    await sessionManager.initialize();
    const sessionState = await sessionManager.getOrCreateSession();
    log(`Session initialized: ${sessionState.sessionKey}`);
  } catch (err) {
    console.error("Failed to initialize session manager:", err);
    // Continue anyway - session management is optional
  }

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
      await handleUserMessage(client, event.id, event.content, sessionManager);
    }
  }

  // Clean up session manager on shutdown
  try {
    await sessionManager.close();
  } catch (err) {
    console.error("Failed to close session manager:", err);
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  userMessageId: string,
  userText: string,
  sessionManager: SessionManager
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
    // Build conversation history from previous messages (limit to last 20 messages for token efficiency)
    let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      conversationHistory = await sessionManager.getConversationHistory(20);
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
      { role: "user" as const, content: userText }
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
      await sessionManager.storeMessage(userMessageId, 0, "user", userText);
    } catch (err) {
      console.error("Failed to store user message:", err);
    }

    // Accumulate assistant response for storage
    let assistantResponse = "";

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
      }
    }

    // Store complete assistant response in history
    if (assistantResponse) {
      try {
        await sessionManager.storeMessage(responseId, 0, "assistant", assistantResponse);
        // Commit message to session
        await sessionManager.commitMessage(0);
      } catch (err) {
        console.error("Failed to store assistant message:", err);
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
