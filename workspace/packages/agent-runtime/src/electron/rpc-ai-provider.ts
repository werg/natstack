/**
 * RPC AI Provider (Electron)
 *
 * Wraps the @natstack/ai client to implement AiProvider interface.
 * All operations are RPC-based, communicating with the host AIHandler.
 */

import type { AiClient } from "@natstack/ai";
import type {
  AiProvider,
  AIRoleRecord,
  StreamTextOptions,
  StreamEvent,
  StreamResult,
  GenerateResult,
  StreamHandle,
} from "../abstractions/ai-provider.js";
import type {
  StreamEvent as AiStreamEvent,
  AIRoleRecord as AiRoleRecord,
  Message,
} from "@natstack/types";

/**
 * Convert our StreamTextOptions to @natstack/ai StreamTextOptions format.
 */
function convertToAiOptions(ai: AiClient, options: StreamTextOptions): Parameters<typeof ai.streamText>[0] {
  // Convert messages to @natstack/ai Message format
  const messages: Message[] = [];

  // Add system message if provided
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }

  // Add conversation messages
  for (const msg of options.messages) {
    if (msg.role === "user") {
      messages.push({
        role: "user",
        content: typeof msg.content === "string" ? msg.content : msg.content,
      } as Message);
    } else if (msg.role === "assistant") {
      messages.push({
        role: "assistant",
        content: typeof msg.content === "string" ? msg.content : msg.content,
      } as Message);
    }
  }

  // Determine model - use role or direct model ID
  const model = options.model ?? options.role ?? "smart";

  // Convert tools to @natstack/ai format
  const tools = options.tools
    ? Object.fromEntries(
        options.tools.map((t) => [
          t.name,
          {
            description: t.description,
            parameters: t.inputSchema,
          },
        ])
      )
    : undefined;

  return {
    model,
    messages,
    tools,
    maxOutputTokens: options.maxTokens,
    temperature: options.temperature,
  };
}

/**
 * Convert @natstack/ai StreamEvent to our StreamEvent format.
 */
function convertStreamEvent(event: AiStreamEvent): StreamEvent {
  switch (event.type) {
    case "text-delta":
      return { type: "text", text: event.text };

    case "reasoning-delta":
      return { type: "thinking", text: event.text };

    case "tool-call":
      return {
        type: "tool_use",
        id: event.toolCallId,
        name: event.toolName,
        input: event.args,
      };

    case "finish":
      return {
        type: "usage",
        promptTokens: event.usage?.promptTokens ?? 0,
        completionTokens: event.usage?.completionTokens ?? 0,
      };

    case "error":
      return { type: "error", error: event.error.message };

    default:
      // For other events, we don't have a direct mapping
      return { type: "done" };
  }
}

/**
 * Convert @natstack/ai AIRoleRecord to our AIRoleRecord format.
 */
function convertRoleRecord(record: AiRoleRecord): AIRoleRecord {
  const result: AIRoleRecord = {};
  for (const [role, info] of Object.entries(record)) {
    result[role] = info.modelId;
  }
  return result;
}

/**
 * Create an RPC-based AI provider from an @natstack/ai client.
 *
 * @param ai The AI client instance (created via createAiClient)
 * @returns AiProvider implementation
 */
export function createRpcAiProvider(ai: AiClient): AiProvider {
  return {
    async listRoles(): Promise<AIRoleRecord> {
      const roles = await ai.listRoles();
      return convertRoleRecord(roles);
    },

    streamText(options: StreamTextOptions): StreamHandle {
      const streamId = crypto.randomUUID();
      const aiOptions = convertToAiOptions(ai, options);
      const iterable = ai.streamText(aiOptions);

      // Track accumulated results
      let text = "";
      let cancelled = false;
      let usage = { promptTokens: 0, completionTokens: 0 };
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      let stopReason: StreamResult["stopReason"];

      // Create a deferred promise for the done result
      let resolveResult!: (result: StreamResult) => void;
      let rejectResult!: (error: Error) => void;
      const donePromise = new Promise<StreamResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      // Create the async iterator
      async function* createIterator(): AsyncGenerator<StreamEvent> {
        try {
          for await (const event of iterable) {
            if (cancelled) {
              yield { type: "cancelled" };
              break;
            }

            // Accumulate text
            if (event.type === "text-delta") {
              text += event.text;
            }

            // Accumulate tool uses
            if (event.type === "tool-call") {
              toolUses.push({
                id: event.toolCallId,
                name: event.toolName,
                input: event.args,
              });
            }

            // Capture usage and finish reason
            if (event.type === "step-finish") {
              stopReason = event.finishReason === "stop"
                ? "end_turn"
                : event.finishReason === "tool-calls"
                ? "tool_use"
                : event.finishReason === "length"
                ? "max_tokens"
                : "end_turn";
            }

            if (event.type === "finish") {
              usage = event.usage ?? usage;
            }

            // Convert and yield
            const converted = convertStreamEvent(event);
            if (converted.type !== "done") {
              yield converted;
            }
          }

          yield { type: "done" };

          // Resolve the done promise
          resolveResult({
            text,
            usage,
            cancelled,
            stopReason,
            toolUses: toolUses.length > 0 ? toolUses : undefined,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          yield { type: "error", error: error.message };
          rejectResult(error);
        }
      }

      const iterator = createIterator();

      return {
        [Symbol.asyncIterator]() {
          return iterator;
        },

        cancel() {
          cancelled = true;
        },

        get done() {
          return donePromise;
        },

        get streamId() {
          return streamId;
        },
      };
    },

    async generateText(options: StreamTextOptions): Promise<GenerateResult> {
      const aiOptions = convertToAiOptions(ai, options);
      const text = await ai.generateText(aiOptions);

      return {
        text,
        usage: { promptTokens: 0, completionTokens: 0 },
        cancelled: false,
      };
    },
  };
}
