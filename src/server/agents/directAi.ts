/**
 * Direct AI Client — wraps AIHandler for in-process agent streaming.
 *
 * Agents get an `AiClient` interface backed by direct AIHandler calls
 * with no serialization boundary.
 */

import type { AIRoleRecord, StreamEvent, StreamTextOptions as TypesStreamTextOptions } from "@natstack/types";
import type { AIHandler, StreamTarget } from "../../shared/ai/aiHandler.js";
import type { ToolExecutionResult } from "../../shared/ai/claudeCodeToolProxy.js";
import type { AiClient } from "@natstack/ai";

/**
 * Create an in-process AiClient that streams directly through AIHandler.
 *
 * AIHandler.startTargetStream() works with a StreamTarget abstraction.
 * We implement StreamTarget as an in-memory async queue — zero serialization.
 */
export function createDirectAiClient(
  aiHandler: AIHandler,
  agentId: string,
): AiClient {
  let roleRecordCache: AIRoleRecord | null = null;

  return {
    async listRoles(): Promise<AIRoleRecord> {
      if (roleRecordCache) return roleRecordCache;
      roleRecordCache = aiHandler.getAvailableRoles();
      return roleRecordCache;
    },

    clearRoleCache(): void {
      roleRecordCache = null;
    },

    streamText(options: TypesStreamTextOptions): AsyncIterable<StreamEvent> {
      const streamId = crypto.randomUUID();

      // Collect tool execute callbacks from options.tools
      const toolCallbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
      if (options.tools) {
        for (const [name, tool] of Object.entries(options.tools)) {
          if (tool.execute) {
            toolCallbacks.set(name, tool.execute);
          }
        }
      }

      // Build the bridge options matching what AIHandler expects
      const bridgeOptions = {
        model: options.model,
        messages: options.messages,
        tools: options.tools
          ? Object.entries(options.tools).map(([name, tool]) => ({
              name,
              description: tool.description,
              parameters: tool.parameters,
            }))
          : undefined,
        maxSteps: options.maxSteps,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        thinking: options.thinking,
      };

      // Prepend system message if provided
      if (options.system) {
        bridgeOptions.messages = [
          { role: "system" as const, content: options.system },
          ...bridgeOptions.messages,
        ];
      }

      return {
        [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
          let ended = false;
          const eventQueue: StreamEvent[] = [];
          let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;
          const abortSignal = options.abortSignal;

          const push = (event: StreamEvent) => {
            if (ended) return;
            if (resolveNext) {
              resolveNext({ done: false, value: event });
              resolveNext = null;
            } else {
              eventQueue.push(event);
            }
          };

          const finish = () => {
            ended = true;
            if (resolveNext) {
              resolveNext({ done: true, value: undefined });
              resolveNext = null;
            }
          };

          // Create StreamTarget that pushes directly to our queue
          const target: StreamTarget = {
            targetId: `agent:${agentId}:${streamId}`,
            isAvailable: () => !ended && !(abortSignal?.aborted),
            sendChunk: (event) => {
              // Convert StreamTextEvent to StreamEvent
              switch (event.type) {
                case "text-delta":
                  push({ type: "text-delta", text: event.text ?? "" });
                  break;
                case "reasoning-start":
                  push({ type: "reasoning-start" });
                  break;
                case "reasoning-delta":
                  push({ type: "reasoning-delta", text: event.text ?? "" });
                  break;
                case "reasoning-end":
                  push({ type: "reasoning-end" });
                  break;
                case "tool-call":
                  push({
                    type: "tool-call",
                    toolCallId: event.toolCallId ?? "",
                    toolName: event.toolName ?? "",
                    args: event.args,
                  });
                  break;
                case "tool-result":
                  push({
                    type: "tool-result",
                    toolCallId: event.toolCallId ?? "",
                    toolName: event.toolName ?? "",
                    result: event.result,
                    isError: event.isError,
                  });
                  break;
                case "step-finish":
                  push({
                    type: "step-finish",
                    stepNumber: event.stepNumber ?? 0,
                    finishReason: (event.finishReason ?? "stop") as "stop" | "tool-calls" | "length" | "error",
                  });
                  break;
                case "finish":
                  push({ type: "finish", totalSteps: event.totalSteps ?? 1, usage: event.usage });
                  break;
                case "error":
                  push({ type: "error", error: new Error(event.error ?? "Unknown error") });
                  break;
              }
            },
            sendEnd: () => finish(),
            executeTool: async (toolName, args): Promise<ToolExecutionResult> => {
              const callback = toolCallbacks.get(toolName);
              if (!callback) {
                return { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true };
              }
              try {
                const result = await callback(args);
                if (result && typeof result === "object" && "content" in result && Array.isArray((result as { content?: unknown }).content)) {
                  return result as ToolExecutionResult;
                }
                const text = typeof result === "string" ? result : JSON.stringify(result);
                return { content: [{ type: "text", text }] };
              } catch (err) {
                return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
              }
            },
          };

          // Start streaming — AIHandler runs async, pushes events to our target
          aiHandler.startTargetStream(target, bridgeOptions as any, streamId);

          // Handle abort
          if (abortSignal) {
            const onAbort = () => {
              if (!ended) finish();
            };
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }

          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              if (abortSignal?.aborted) {
                ended = true;
                return { done: true, value: undefined };
              }
              if (eventQueue.length > 0) return { done: false, value: eventQueue.shift()! };
              if (ended) return { done: true, value: undefined };
              return new Promise((resolve) => { resolveNext = resolve; });
            },
            async return(): Promise<IteratorResult<StreamEvent>> {
              ended = true;
              return { done: true, value: undefined };
            },
            async throw(): Promise<IteratorResult<StreamEvent>> {
              ended = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    async generateText(options: TypesStreamTextOptions): Promise<string> {
      let result = "";
      for await (const event of this.streamText(options)) {
        if (event.type === "text-delta") result += event.text;
        if (event.type === "error") throw event.error;
      }
      return result;
    },
  };
}
