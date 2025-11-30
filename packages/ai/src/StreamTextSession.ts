/**
 * StreamTextSession - Class-based stream management for AI text generation.
 *
 * Refactored from the 430-line streamText function for better:
 * - Testability (each method can be unit tested)
 * - Maintainability (clear separation of concerns)
 * - Error handling (centralized error management)
 */

import type {
  StreamEvent,
  StreamTextOptions,
  StreamTextResult,
} from "./index.js";

/**
 * Manages a single AI text stream session with tool execution and callbacks.
 */
export class StreamTextSession {
  // Stream state
  private ended = false;
  private streamError: Error | null = null;
  private readonly eventQueue: StreamEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];

  // Accumulated state for promises
  private fullText = "";
  private readonly allToolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
  private readonly allToolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }> = [];
  private finalFinishReason: "stop" | "tool-calls" | "length" | "error" = "stop";
  private finalUsage: { promptTokens: number; completionTokens: number } | undefined;
  private finalTotalSteps = 0;

  // Per-step tracking for callbacks
  private currentStepText = "";
  private currentStepToolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
  private currentStepToolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }> = [];

  // Promise resolvers (arrays to handle multiple concurrent accesses)
  private resolveTextCallbacks: Array<(value: string) => void> = [];
  private resolveToolCallsCallbacks: Array<(value: Array<{ toolCallId: string; toolName: string; args: unknown }>) => void> = [];
  private resolveToolResultsCallbacks: Array<(value: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>) => void> = [];
  private resolveFinishReasonCallbacks: Array<(value: "stop" | "tool-calls" | "length" | "error") => void> = [];
  private resolveUsageCallbacks: Array<(value: { promptTokens: number; completionTokens: number } | undefined) => void> = [];
  private resolveTotalStepsCallbacks: Array<(value: number) => void> = [];

  // Iterator tracking to prevent multiple concurrent iterators
  private iteratorCreated = false;

  // Cleanup handlers
  private unsubscribers: Array<() => void> = [];

  constructor(
    public readonly streamId: string,
    private readonly options: StreamTextOptions,
    private readonly onCancel: () => void
  ) {}

  /**
   * Process an incoming stream event.
   */
  async processEvent(event: StreamEvent): Promise<void> {
    // Call onChunk callback
    if (this.options.onChunk) {
      try {
        await this.options.onChunk(event);
      } catch (e) {
        // User callback threw - log but continue stream
        if (typeof console !== 'undefined') {
          console.error("streamText onChunk callback error:", e);
        }
      }
    }

    // Update accumulated state
    switch (event.type) {
      case "text-delta":
        await this.handleTextDelta(event);
        break;

      case "tool-call":
        await this.handleToolCall(event);
        break;

      case "tool-result":
        await this.handleToolResult(event);
        break;

      case "step-finish":
        await this.handleStepFinish(event);
        break;

      case "finish":
        await this.handleFinish(event);
        break;

      case "error":
        await this.handleError(event);
        break;
    }

    // Dispatch to waiters or queue
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ done: false, value: event });
    } else {
      this.eventQueue.push(event);
    }
  }

  private async handleTextDelta(event: { type: "text-delta"; text: string }): Promise<void> {
    this.fullText += event.text;
    this.currentStepText += event.text;
  }

  private async handleToolCall(event: { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }): Promise<void> {
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
    this.allToolCalls.push(toolCall);
    this.currentStepToolCalls.push(toolCall);
  }

  private async handleToolResult(event: { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }): Promise<void> {
    const toolResult = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    };
    this.allToolResults.push(toolResult);
    this.currentStepToolResults.push(toolResult);
  }

  private async handleStepFinish(event: { type: "step-finish"; stepNumber: number; finishReason: "stop" | "tool-calls" | "length" | "error" }): Promise<void> {
    this.finalFinishReason = event.finishReason;

    // Call onStepFinish callback
    if (this.options.onStepFinish) {
      try {
        await this.options.onStepFinish({
          stepNumber: event.stepNumber,
          finishReason: event.finishReason,
          text: this.currentStepText,
          toolCalls: this.currentStepToolCalls,
          toolResults: this.currentStepToolResults,
        });
      } catch (e) {
        // User callback threw - log but continue stream
        if (typeof console !== 'undefined') {
          console.error("streamText onStepFinish callback error:", e);
        }
      }
    }

    // Reset step state
    this.currentStepText = "";
    this.currentStepToolCalls = [];
    this.currentStepToolResults = [];
  }

  private async handleFinish(event: { type: "finish"; totalSteps: number; usage?: { promptTokens: number; completionTokens: number } }): Promise<void> {
    this.finalTotalSteps = event.totalSteps;
    this.finalUsage = event.usage;

    // Call onFinish callback
    if (this.options.onFinish) {
      try {
        await this.options.onFinish({
          text: this.fullText,
          toolCalls: this.allToolCalls,
          toolResults: this.allToolResults,
          totalSteps: event.totalSteps,
          usage: event.usage,
          finishReason: this.finalFinishReason,
        });
      } catch (e) {
        // User callback threw - log but continue
        if (typeof console !== 'undefined') {
          console.error("streamText onFinish callback error:", e);
        }
      }
    }
  }

  private async handleError(event: { type: "error"; error: Error }): Promise<void> {
    this.streamError = event.error;

    // Call onError callback
    if (this.options.onError) {
      try {
        await this.options.onError(event.error);
      } catch (e) {
        // User error handler threw - log but continue
        if (typeof console !== 'undefined') {
          console.error("streamText onError callback error:", e);
        }
      }
    }
  }

  /**
   * Cleanup and resolve all promises.
   */
  cleanup(): void {
    this.ended = true;

    // Call unsubscribers
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Resolve all promises (handle multiple concurrent accesses)
    for (const resolve of this.resolveTextCallbacks) {
      resolve(this.fullText);
    }
    this.resolveTextCallbacks = [];

    for (const resolve of this.resolveToolCallsCallbacks) {
      resolve(this.allToolCalls);
    }
    this.resolveToolCallsCallbacks = [];

    for (const resolve of this.resolveToolResultsCallbacks) {
      resolve(this.allToolResults);
    }
    this.resolveToolResultsCallbacks = [];

    for (const resolve of this.resolveFinishReasonCallbacks) {
      resolve(this.finalFinishReason);
    }
    this.resolveFinishReasonCallbacks = [];

    for (const resolve of this.resolveUsageCallbacks) {
      resolve(this.finalUsage);
    }
    this.resolveUsageCallbacks = [];

    for (const resolve of this.resolveTotalStepsCallbacks) {
      resolve(this.finalTotalSteps);
    }
    this.resolveTotalStepsCallbacks = [];

    // Signal completion to any waiting iterators
    for (const waiter of this.waiters) {
      waiter({ done: true, value: undefined });
    }
    this.waiters.length = 0;
  }

  /**
   * Cancel the stream.
   */
  cancel(): void {
    this.cleanup();
    this.onCancel();
  }

  /**
   * Register an unsubscriber to be called on cleanup.
   */
  addUnsubscriber(unsub: () => void): void {
    this.unsubscribers.push(unsub);
  }

  /**
   * Create an async iterator for the stream.
   *
   * IMPORTANT: Only ONE iterator should be created per session.
   * Multiple concurrent iterators will compete for events and cause data loss.
   *
   * @throws Error if an iterator was already created
   */
  createIterator(): AsyncIterator<StreamEvent> {
    if (this.iteratorCreated) {
      throw new Error(
        "Multiple iterators created for the same StreamTextSession. " +
        "Only one consumer is allowed. Use result.text, result.toolCalls, etc. for concurrent access to final values."
      );
    }
    this.iteratorCreated = true;

    return {
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        if (this.streamError && this.eventQueue.length === 0) {
          return { done: true, value: undefined };
        }

        if (this.eventQueue.length > 0) {
          return { done: false, value: this.eventQueue.shift()! };
        }

        if (this.ended) {
          return { done: true, value: undefined };
        }

        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },

      return: async (): Promise<IteratorResult<StreamEvent>> => {
        this.cancel();
        return { done: true, value: undefined };
      },

      throw: async (e: Error): Promise<IteratorResult<StreamEvent>> => {
        this.streamError = e;
        this.cancel();
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Create a text-only stream iterator.
   */
  createTextStreamIterator(): AsyncIterator<string> {
    const fullStreamIterator = this.createIterator();
    return {
      next: async (): Promise<IteratorResult<string>> => {
        while (true) {
          const result = await fullStreamIterator.next();
          if (result.done) {
            return { done: true, value: undefined };
          }
          if (result.value.type === "text-delta") {
            return { done: false, value: result.value.text };
          }
          // Skip non-text events
        }
      },
      return: async (): Promise<IteratorResult<string>> => {
        await fullStreamIterator.return?.();
        return { done: true, value: undefined };
      },
      throw: async (e: Error): Promise<IteratorResult<string>> => {
        await fullStreamIterator.throw?.(e);
        return { done: true, value: undefined };
      },
    };
  }

  /**
   * Build the StreamTextResult object.
   */
  toResult(): StreamTextResult {
    const session = this; // Capture session reference for closures

    return {
      // AsyncIterable implementation
      [Symbol.asyncIterator]: () => session.createIterator(),

      // Full stream (same as AsyncIterable)
      get fullStream(): AsyncIterable<StreamEvent> {
        return {
          [Symbol.asyncIterator]: () => session.createIterator(),
        };
      },

      // Text-only stream
      get textStream(): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]: () => session.createTextStreamIterator(),
        };
      },

      // Promise for full text
      get text(): Promise<string> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.fullText);
          } else {
            session.resolveTextCallbacks.push(resolve);
          }
        });
      },

      // Promise for tool calls
      get toolCalls(): Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.allToolCalls);
          } else {
            session.resolveToolCallsCallbacks.push(resolve);
          }
        });
      },

      // Promise for tool results
      get toolResults(): Promise<Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.allToolResults);
          } else {
            session.resolveToolResultsCallbacks.push(resolve);
          }
        });
      },

      // Promise for finish reason
      get finishReason(): Promise<"stop" | "tool-calls" | "length" | "error"> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.finalFinishReason);
          } else {
            session.resolveFinishReasonCallbacks.push(resolve);
          }
        });
      },

      // Promise for usage
      get usage(): Promise<{ promptTokens: number; completionTokens: number } | undefined> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.finalUsage);
          } else {
            session.resolveUsageCallbacks.push(resolve);
          }
        });
      },

      // Promise for total steps
      get totalSteps(): Promise<number> {
        return new Promise((resolve) => {
          if (session.ended) {
            resolve(session.finalTotalSteps);
          } else {
            session.resolveTotalStepsCallbacks.push(resolve);
          }
        });
      },
    };
  }
}
