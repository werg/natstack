import type {
  AIRoleRecord,
  Message,
  StreamEvent,
  StreamTextOptions,
  ToolDefinition,
  ToolExecutionResult,
} from "./types.js";
import { rpc } from "@natstack/runtime";
import { encodeBase64 } from "@natstack/runtime";

interface StreamTextBridgeOptions {
  model: string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
  tools?: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
}

type SerializableStreamEvent = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  stepNumber?: number;
  finishReason?: string;
  totalSteps?: number;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
};

function serializeMessages(messages: Message[]): StreamTextBridgeOptions["messages"] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        if (typeof msg.content === "string") return { role: "user", content: msg.content };
        return {
          role: "user",
          content: msg.content.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            const data = part.data instanceof Uint8Array ? encodeBase64(part.data) : part.data;
            return { type: "file", mimeType: part.mimeType, data };
          }),
        };
      case "assistant":
        if (typeof msg.content === "string") return { role: "assistant", content: msg.content };
        return {
          role: "assistant",
          content: msg.content.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, args: part.args };
          }),
        };
      case "tool":
        return {
          role: "tool",
          content: msg.content.map((part) => ({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
            isError: part.isError,
          })),
        };
    }
  });
}

function serializeTools(tools: Record<string, ToolDefinition> | undefined) {
  if (!tools) return undefined;
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function deserializeStreamEvent(chunk: SerializableStreamEvent): StreamEvent {
  switch (chunk.type) {
    case "text-delta":
      return { type: "text-delta", text: chunk.text ?? "" };
    case "reasoning-start":
      return { type: "reasoning-start" };
    case "reasoning-delta":
      return { type: "reasoning-delta", text: chunk.text ?? "" };
    case "reasoning-end":
      return { type: "reasoning-end" };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId ?? "",
        toolName: chunk.toolName ?? "",
        args: chunk.args,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: chunk.toolCallId ?? "",
        toolName: chunk.toolName ?? "",
        result: chunk.result,
        isError: chunk.isError,
      };
    case "step-finish":
      return {
        type: "step-finish",
        stepNumber: chunk.stepNumber ?? 0,
        finishReason: (chunk.finishReason ?? "stop") as "stop" | "tool-calls" | "length" | "error",
      };
    case "finish":
      return { type: "finish", totalSteps: chunk.totalSteps ?? 1, usage: chunk.usage };
    case "error":
      return { type: "error", error: new Error(chunk.error ?? "Unknown error") };
    default:
      return { type: "error", error: new Error(`Unknown event type: ${chunk.type}`) };
  }
}

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;
const registeredToolCallbacks = new Map<string, Map<string, ToolCallback>>();

export type AiClient = {
  listRoles(): Promise<AIRoleRecord>;
  streamText(options: StreamTextOptions): AsyncIterable<StreamEvent>;
  generateText(options: StreamTextOptions): Promise<string>;
  clearRoleCache(): void;
};

function createAiClient(): AiClient {
  const streamChunkListeners = new Set<(streamId: string, chunk: SerializableStreamEvent) => void>();
  const streamEndListeners = new Set<(streamId: string) => void>();

  rpc.onEvent("ai:stream-text-chunk", (_fromId, payload) => {
    const { streamId, chunk } = payload as { streamId: string; chunk: SerializableStreamEvent };
    for (const listener of streamChunkListeners) listener(streamId, chunk);
  });

  rpc.onEvent("ai:stream-text-end", (_fromId, payload) => {
    const { streamId } = payload as { streamId: string };
    for (const listener of streamEndListeners) listener(streamId);
  });

  rpc.expose({
    "ai.executeTool": async (
      streamId: unknown,
      toolName: unknown,
      toolArgs: unknown
    ): Promise<ToolExecutionResult> => {
      const sid = streamId as string;
      const name = toolName as string;
      const args = toolArgs as Record<string, unknown>;

      const streamCallbacks = registeredToolCallbacks.get(sid);
      const callback = streamCallbacks?.get(name);
      if (!callback) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }

      try {
        const result = await callback(args);

        // Pass through already-wrapped ToolExecutionResult results (supports optional `data`).
        if (
          result &&
          typeof result === "object" &&
          "content" in (result as Record<string, unknown>) &&
          Array.isArray((result as { content?: unknown }).content)
        ) {
          return result as ToolExecutionResult;
        }

        let resultText: string;
        if (typeof result === "string") {
          resultText = result;
        } else {
          try {
            resultText = JSON.stringify(result);
          } catch {
            resultText = String(result);
          }
        }
        return { content: [{ type: "text", text: resultText }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  });

  let roleRecordCache: AIRoleRecord | null = null;

  return {
    async listRoles(): Promise<AIRoleRecord> {
      if (roleRecordCache) return roleRecordCache;
      roleRecordCache = await rpc.call<AIRoleRecord>("main", "ai.listRoles");
      return roleRecordCache;
    },

    clearRoleCache(): void {
      roleRecordCache = null;
    },

    streamText(options: StreamTextOptions): AsyncIterable<StreamEvent> {
      const streamId = crypto.randomUUID();

      const toolCallbacks = new Map<string, ToolCallback>();
      if (options.tools) {
        for (const [name, tool] of Object.entries(options.tools)) {
          // Only register callbacks for tools that have an execute function
          if (tool.execute) {
            toolCallbacks.set(name, tool.execute);
          }
        }
      }

      let messages = options.messages;
      if (options.system) {
        messages = [{ role: "system", content: options.system }, ...messages];
      }

      const bridgeOptions: StreamTextBridgeOptions = {
        model: options.model,
        messages: serializeMessages(messages),
        tools: serializeTools(options.tools),
        maxSteps: options.maxSteps,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        thinking: options.thinking,
      };

      const iterable: AsyncIterable<StreamEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          let ended = false;
          let error: Error | null = null;
          const eventQueue: StreamEvent[] = [];
          let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;
          const abortSignal = options.abortSignal;
          let abortListener: (() => void) | null = null;

          const cleanup = () => {
            ended = true;
            streamChunkListeners.delete(chunkListener);
            streamEndListeners.delete(endListener);
            registeredToolCallbacks.delete(streamId);
            if (abortSignal && abortListener) {
              abortSignal.removeEventListener("abort", abortListener);
              abortListener = null;
            }
          };

          const chunkListener = (sid: string, chunk: SerializableStreamEvent) => {
            if (sid !== streamId || ended) return;
            const event = deserializeStreamEvent(chunk);
            if (resolveNext) {
              resolveNext({ done: false, value: event });
              resolveNext = null;
            } else {
              eventQueue.push(event);
            }
          };
          streamChunkListeners.add(chunkListener);

          const endListener = (sid: string) => {
            if (sid !== streamId || ended) return;
            cleanup();
            if (resolveNext) {
              resolveNext({ done: true, value: undefined });
              resolveNext = null;
            }
          };
          streamEndListeners.add(endListener);

          registeredToolCallbacks.set(streamId, toolCallbacks);

          const cancel = () => rpc.call("main", "ai.streamCancel", streamId).catch(() => {});

          if (abortSignal) {
            abortListener = () => {
              if (ended) return;
              cleanup();
              void cancel();
              if (resolveNext) {
                resolveNext({ done: true, value: undefined });
                resolveNext = null;
              }
            };
            abortSignal.addEventListener("abort", abortListener, { once: true });
            if (abortSignal.aborted) {
              abortListener();
              return {
                async next() {
                  return { done: true, value: undefined };
                },
                async return() {
                  return { done: true, value: undefined };
                },
                async throw() {
                  return { done: true, value: undefined };
                },
              };
            }
          }

          void rpc.call("main", "ai.streamTextStart", bridgeOptions, streamId).catch((err) => {
            error = err instanceof Error ? err : new Error(String(err));
            cleanup();
            const errorEvent: StreamEvent = { type: "error", error };
            if (resolveNext) {
              resolveNext({ done: false, value: errorEvent });
              resolveNext = null;
            } else {
              eventQueue.push(errorEvent);
            }
          });

          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              if (error) return { done: true, value: undefined };
              if (abortSignal?.aborted) {
                cleanup();
                void cancel();
                return { done: true, value: undefined };
              }
              if (eventQueue.length > 0) return { done: false, value: eventQueue.shift()! };
              if (ended) return { done: true, value: undefined };
              return new Promise((resolve) => (resolveNext = resolve));
            },

            async return(): Promise<IteratorResult<StreamEvent>> {
              cleanup();
              void cancel();
              return { done: true, value: undefined };
            },

            async throw(e: Error): Promise<IteratorResult<StreamEvent>> {
              error = e;
              cleanup();
              void cancel();
              return { done: true, value: undefined };
            },
          };
        },
      };

      if (options.onChunk || options.onFinish || options.onStepFinish || options.onError) {
        // Compatibility wrapper: consume events and call callbacks.
        const wrapped: AsyncIterable<StreamEvent> = {
          async *[Symbol.asyncIterator]() {
            let text = "";
            let totalSteps = 0;
            let usage: { promptTokens: number; completionTokens: number } | undefined;
            let finishReason: "stop" | "tool-calls" | "length" | "error" = "stop";
            const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
            const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }> = [];

            for await (const event of iterable) {
              if (options.onChunk) await options.onChunk(event);
              if (event.type === "text-delta") text += event.text;
              if (event.type === "tool-call") toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
              if (event.type === "tool-result") toolResults.push({ toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
              if (event.type === "step-finish") {
                totalSteps = Math.max(totalSteps, event.stepNumber + 1);
                finishReason = event.finishReason;
                if (options.onStepFinish) await options.onStepFinish({
                  stepNumber: event.stepNumber,
                  finishReason: event.finishReason,
                  text,
                  toolCalls,
                  toolResults,
                });
              }
              if (event.type === "finish") {
                usage = event.usage;
                totalSteps = event.totalSteps;
                if (options.onFinish) await options.onFinish({
                  text,
                  toolCalls,
                  toolResults,
                  totalSteps,
                  usage,
                  finishReason,
                });
              }
              if (event.type === "error") {
                if (options.onError) await options.onError(event.error);
              }
              yield event;
            }
          },
        };
        return wrapped;
      }

      return iterable;
    },

    async generateText(options: StreamTextOptions): Promise<string> {
      let result = "";
      for await (const event of this.streamText(options)) {
        if (event.type === "text-delta") result += event.text;
        if (event.type === "error") throw event.error;
      }
      return result;
    },
  };
}

export const ai = createAiClient();
