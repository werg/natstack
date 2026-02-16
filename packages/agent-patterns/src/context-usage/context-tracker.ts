/**
 * Context Tracker Pattern
 *
 * Provides tracking of token/context window usage across agent sessions.
 * Used to report context consumption via participant metadata updates.
 */

import type {
  ContextWindowUsage,
  NormalizedUsage,
  TokenUsage,
} from "@workspace/agentic-messaging";

// ============================================================================
// Model Context Limits
// ============================================================================

/**
 * Known context window limits for common models.
 * Used to calculate usage percentage when maxContextTokens is not provided.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Claude models (Anthropic)
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  "claude-3.5-sonnet": 200000,
  "claude-3.5-haiku": 200000,
  "claude-sonnet-4": 200000,
  "claude-opus-4": 200000,
  // OpenAI models
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-4": 8192,
  "o1": 128000,
  "o1-mini": 128000,
  "o3-mini": 200000,
};

/**
 * Get the context window limit for a model.
 *
 * @param model - Model identifier (e.g., "claude-3-opus", "gpt-4o")
 * @returns Context window size in tokens, or undefined if unknown
 *
 * @example
 * ```typescript
 * getModelContextLimit("claude-3-opus") // => 200000
 * getModelContextLimit("claude-3-opus-20240229") // => 200000 (partial match)
 * getModelContextLimit("unknown-model") // => undefined
 * ```
 */
export function getModelContextLimit(model?: string): number | undefined {
  if (!model) return undefined;

  // Check exact match first
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];

  // Check partial matches (e.g., "claude-3-opus-20240229" matches "claude-3-opus")
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.includes(key)) return limit;
  }

  return undefined;
}

// ============================================================================
// ContextTracker
// ============================================================================

/**
 * Options for creating a ContextTracker.
 */
export interface ContextTrackerOptions {
  /**
   * Callback invoked when context usage changes.
   * Agents should use this to update their participant metadata.
   *
   * @example
   * ```typescript
   * onUpdate: async (usage) => {
   *   await client.updateMetadata({
   *     ...baseMetadata,
   *     contextUsage: usage,
   *   });
   * }
   * ```
   */
  onUpdate: (usage: ContextWindowUsage) => Promise<void>;

  /** Model identifier for context limit lookup */
  model?: string;

  /** Override the max context tokens (takes precedence over model lookup) */
  maxContextTokens?: number;

  /** Logger function for debug output */
  log?: (message: string) => void;

  /** Minimum interval between metadata updates (default: 1000ms) */
  updateThrottleMs?: number;
}

/**
 * Internal state managed by the ContextTracker.
 */
export interface ContextTrackerState {
  /** Current context usage */
  usage: ContextWindowUsage;
  /** Whether an update is pending (throttled) */
  updatePending: boolean;
}

/**
 * ContextTracker manages context window usage tracking and metadata updates.
 *
 * This utility provides a consistent way to track token usage across
 * different agent implementations (claude-code-responder, codex-responder, etc.).
 *
 * It handles:
 * - Accumulating usage from multiple API calls within a turn
 * - Accumulating session-level usage across turns
 * - Computing usage percentages when context limits are known
 * - Throttled metadata updates to avoid excessive pubsub traffic
 *
 * @example
 * ```typescript
 * const tracker = createContextTracker({
 *   onUpdate: async (usage) => {
 *     await client.updateMetadata({
 *       name: "Claude Code",
 *       type: "claude-code",
 *       handle,
 *       panelId,
 *       contextUsage: usage,
 *     });
 *   },
 *   model: "claude-3-opus",
 *   log,
 * });
 *
 * // After each LLM response
 * await tracker.recordUsage({
 *   inputTokens: 1500,
 *   outputTokens: 500,
 *   costUsd: 0.05,
 * });
 *
 * // At the end of a turn (resets current but keeps session)
 * await tracker.endTurn();
 *
 * // Cleanup on error/completion
 * await tracker.cleanup();
 * ```
 */
export interface ContextTracker {
  /** Read-only access to current state */
  readonly state: ContextTrackerState;

  /**
   * Record token usage from an LLM call.
   * Accumulates to both current turn and session totals.
   * Triggers a throttled metadata update.
   *
   * @param usage - Normalized usage from SDK response
   */
  recordUsage(usage: NormalizedUsage): Promise<void>;

  /**
   * Mark the end of a turn.
   * Resets current turn counters but preserves session totals.
   * Forces an immediate metadata update.
   */
  endTurn(): Promise<void>;

  /**
   * Force an immediate metadata update (bypassing throttle).
   * Use sparingly - prefer letting the throttle batch updates.
   */
  flushUpdate(): Promise<void>;

  /**
   * Update the model (recalculates context limits).
   * Use when model changes mid-session.
   *
   * @param model - New model identifier
   */
  setModel(model: string): void;

  /**
   * Reset all usage counters.
   * Use when starting a completely new session.
   */
  reset(): Promise<void>;

  /**
   * Cleanup and flush any pending updates.
   * Call this in finally blocks or error handlers.
   */
  cleanup(): Promise<void>;
}

/**
 * Create a ContextTracker for managing context window usage.
 *
 * @param options - Configuration options
 * @returns A ContextTracker instance
 */
export function createContextTracker(options: ContextTrackerOptions): ContextTracker {
  const { onUpdate, model: initialModel, maxContextTokens: providedMaxContext, log = () => {}, updateThrottleMs = 1000 } = options;

  let model = initialModel;
  let maxContextTokens = providedMaxContext ?? getModelContextLimit(model);

  const state: ContextTrackerState = {
    usage: {
      current: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      session: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      maxContextTokens,
      usagePercent: 0,
      lastUpdated: Date.now(),
    },
    updatePending: false,
  };

  let pendingUpdateTimeout: ReturnType<typeof setTimeout> | null = null;

  function computeUsagePercent(): number | undefined {
    if (!maxContextTokens) return undefined;
    // Use session input tokens as the "context used" metric
    // Output tokens don't count toward context window usage
    return Math.min(100, Math.round((state.usage.session.inputTokens / maxContextTokens) * 100));
  }

  async function updateMetadata(): Promise<void> {
    state.usage.usagePercent = computeUsagePercent();
    state.usage.lastUpdated = Date.now();
    state.usage.maxContextTokens = maxContextTokens;

    try {
      await onUpdate(state.usage);
      state.updatePending = false;
      log(
        `Context usage updated: ${state.usage.session.inputTokens.toLocaleString()}/${maxContextTokens?.toLocaleString() ?? "?"} tokens (${state.usage.usagePercent ?? "?"}%)`
      );
    } catch (err) {
      log(`Failed to update context usage metadata: ${err}`);
    }
  }

  function scheduleUpdate(): void {
    if (pendingUpdateTimeout) return;
    state.updatePending = true;
    pendingUpdateTimeout = setTimeout(async () => {
      pendingUpdateTimeout = null;
      await updateMetadata();
    }, updateThrottleMs);
  }

  const tracker: ContextTracker = {
    get state() {
      return state;
    },

    async recordUsage(usage: NormalizedUsage): Promise<void> {
      // Accumulate to current turn
      state.usage.current.inputTokens += usage.inputTokens;
      state.usage.current.outputTokens += usage.outputTokens;
      state.usage.current.totalTokens = state.usage.current.inputTokens + state.usage.current.outputTokens;

      // Accumulate to session
      state.usage.session.inputTokens += usage.inputTokens;
      state.usage.session.outputTokens += usage.outputTokens;
      state.usage.session.totalTokens = state.usage.session.inputTokens + state.usage.session.outputTokens;

      // Accumulate cost if available
      if (usage.costUsd !== undefined) {
        state.usage.costUsd = (state.usage.costUsd ?? 0) + usage.costUsd;
      }

      scheduleUpdate();
    },

    async endTurn(): Promise<void> {
      // Reset current turn but keep session
      state.usage.current = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      await tracker.flushUpdate();
    },

    async flushUpdate(): Promise<void> {
      if (pendingUpdateTimeout) {
        clearTimeout(pendingUpdateTimeout);
        pendingUpdateTimeout = null;
      }
      await updateMetadata();
    },

    setModel(newModel: string): void {
      model = newModel;
      maxContextTokens = providedMaxContext ?? getModelContextLimit(model);
      state.usage.maxContextTokens = maxContextTokens;
    },

    async reset(): Promise<void> {
      state.usage = {
        current: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        session: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        maxContextTokens,
        usagePercent: 0,
        costUsd: undefined,
        lastUpdated: Date.now(),
      };
      await tracker.flushUpdate();
    },

    async cleanup(): Promise<void> {
      if (pendingUpdateTimeout) {
        clearTimeout(pendingUpdateTimeout);
        pendingUpdateTimeout = null;
      }
      if (state.updatePending) {
        await updateMetadata();
      }
    },
  };

  return tracker;
}
