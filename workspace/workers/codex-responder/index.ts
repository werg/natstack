/**
 * Codex Responder Worker
 *
 * An unsafe worker that uses OpenAI's Codex/GPT SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to the model.
 */

import { pubsubConfig, setTitle, id } from "@natstack/runtime";
import {
  connect,
  createToolsForAgentSDK,
  type AgenticClient,
  type AgenticParticipantMetadata,
} from "@natstack/agentic-messaging";

// OpenAI SDK - available because this is an unsafe worker
import OpenAI from "openai";

void setTitle("Codex Responder");

const CHANNEL_NAME = "agentic-chat-demo";

interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "worker" | "codex";
}

function log(message: string): void {
  console.log(`[Codex Worker ${id}] ${message}`);
}

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  log("Starting Codex responder...");

  // Initialize OpenAI client
  const openai = new OpenAI();

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
      await handleUserMessage(openai, client, msg.id, msg.content);
    }
  }
}

async function handleUserMessage(
  openai: OpenAI,
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
    // Convert tool definitions to OpenAI format
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = toolDefs.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters as Record<string, unknown>,
      },
    }));

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `You are Codex, a helpful AI coding assistant with access to tools provided by other participants in this chat.
Use the available tools when appropriate to help the user accomplish their tasks.
Be concise and helpful.`,
      },
      { role: "user", content: userText },
    ];

    let continueLoop = true;
    let accumulatedContent = "";

    while (continueLoop) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      });

      let currentContent = "";
      const toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];

      for await (const chunk of response) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          currentContent += delta.content;
          accumulatedContent += delta.content;
          // Stream content update
          await client.update(responseId, delta.content, { persist: false });
        }

        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.index !== undefined) {
              if (!toolCalls[toolCall.index]) {
                toolCalls[toolCall.index] = {
                  id: toolCall.id ?? "",
                  name: toolCall.function?.name ?? "",
                  arguments: "",
                };
              }
              if (toolCall.id) {
                toolCalls[toolCall.index].id = toolCall.id;
              }
              if (toolCall.function?.name) {
                toolCalls[toolCall.index].name = toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                toolCalls[toolCall.index].arguments += toolCall.function.arguments;
              }
            }
          }
        }
      }

      // If there are tool calls, execute them
      if (toolCalls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: "assistant",
          content: currentContent || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute each tool call and add results
        for (const toolCall of toolCalls) {
          log(`Tool call: ${toolCall.name}`);
          try {
            const args = JSON.parse(toolCall.arguments);
            const result = await executeTool(toolCall.name, args);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
        // Continue the loop to get the next response
      } else {
        // No more tool calls, we're done
        continueLoop = false;
      }
    }

    // Mark message as complete
    await client.complete(responseId);
    log(`Completed response for ${userMessageId}`);
  } catch (err) {
    console.error(`[Codex Worker] Error:`, err);
    await client.error(responseId, err instanceof Error ? err.message : String(err));
  }
}

void main();
