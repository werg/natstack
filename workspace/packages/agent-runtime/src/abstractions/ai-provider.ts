/**
 * AI Provider Abstraction
 *
 * Provides a unified interface for AI operations that works across:
 * - Electron: RPC-based calls to host AIHandler
 * - Durable Objects: Direct HTTP to Anthropic API
 *
 * Key features:
 * - Streaming with proper cancellation support
 * - Role-based model selection
 * - Consistent interface regardless of runtime
 */

/**
 * AI model role configuration.
 * Maps role names to model identifiers.
 */
export interface AIRoleRecord {
  /** Fast model for quick responses */
  fast?: string;
  /** Smart model for complex reasoning */
  smart?: string;
  /** Model for coding tasks */
  code?: string;
  /** Default model */
  default?: string;
  /** Custom roles can be added */
  [role: string]: string | undefined;
}

/**
 * Options for text streaming/generation.
 */
export interface StreamTextOptions {
  /** Model role to use (resolved to model ID via listRoles) */
  role?: string;

  /** Direct model ID (overrides role) */
  model?: string;

  /** System prompt */
  system?: string;

  /** Messages in conversation format */
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  }>;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Temperature (0-1) */
  temperature?: number;

  /** Stop sequences */
  stopSequences?: string[];

  /** Tool definitions (for tool use) */
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;

  /** Tool choice strategy */
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; name: string };
}

/**
 * Events yielded during streaming.
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; text: string }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; error: string };

/**
 * Result from completed stream.
 */
export interface StreamResult {
  /** Total tokens used */
  usage: {
    promptTokens: number;
    completionTokens: number;
  };

  /** Final concatenated text */
  text: string;

  /** Whether stream was cancelled */
  cancelled: boolean;

  /** Stop reason */
  stopReason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

  /** Tool uses in the response */
  toolUses?: Array<{
    id: string;
    name: string;
    input: unknown;
  }>;
}

/**
 * Result from non-streaming generation.
 */
export interface GenerateResult extends StreamResult {
  // Same as StreamResult, just returned all at once
}

/**
 * Handle for an in-flight stream.
 *
 * Provides:
 * - Async iteration for stream events
 * - Cancellation capability
 * - Promise for final result
 */
export interface StreamHandle {
  /**
   * Async iterator for stream events.
   * Yields StreamEvent objects as they arrive.
   */
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;

  /**
   * Cancel the stream.
   *
   * Best-effort cancellation:
   * - Electron: Sends cancel RPC to host
   * - DO: Aborts the fetch request
   *
   * The stream may still yield a few more events before stopping.
   */
  cancel(): void;

  /**
   * Promise that resolves when stream completes or is cancelled.
   * Contains the final aggregated result.
   */
  readonly done: Promise<StreamResult>;

  /**
   * Unique stream ID for tracking.
   */
  readonly streamId: string;
}

/**
 * Unified AI provider interface.
 *
 * Abstracts the differences between:
 * - Electron's RPC-based AI calls (routed through host process)
 * - DO's direct HTTP calls to Anthropic API
 *
 * @example
 * ```typescript
 * // List available models
 * const roles = await ai.listRoles();
 * console.log('Fast model:', roles.fast);
 *
 * // Streaming generation
 * const stream = ai.streamText({
 *   role: 'smart',
 *   system: 'You are a helpful assistant.',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   maxTokens: 1024,
 * });
 *
 * for await (const event of stream) {
 *   if (event.type === 'text') {
 *     process.stdout.write(event.text);
 *   }
 * }
 *
 * const result = await stream.done;
 * console.log('Total tokens:', result.usage.promptTokens + result.usage.completionTokens);
 *
 * // Cancellation
 * const stream2 = ai.streamText({ ... });
 * setTimeout(() => stream2.cancel(), 5000); // Cancel after 5s
 *
 * // Non-streaming generation
 * const result = await ai.generateText({
 *   role: 'fast',
 *   messages: [{ role: 'user', content: 'Quick question' }],
 * });
 * console.log(result.text);
 * ```
 */
export interface AiProvider {
  /**
   * List available AI model roles.
   *
   * @returns Map of role names to model IDs
   */
  listRoles(): Promise<AIRoleRecord>;

  /**
   * Stream text completion.
   *
   * Returns a StreamHandle that allows:
   * - Async iteration over stream events
   * - Cancellation via cancel()
   * - Awaiting final result via done
   *
   * @param options - Generation options
   * @returns Handle for the stream
   */
  streamText(options: StreamTextOptions): StreamHandle;

  /**
   * Generate text (non-streaming).
   *
   * Waits for the complete response before returning.
   * Use streamText for real-time output.
   *
   * @param options - Generation options
   * @returns Complete generation result
   */
  generateText(options: StreamTextOptions): Promise<GenerateResult>;
}
