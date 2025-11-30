/**
 * Shared constants for the NatStack application.
 * Centralized to avoid magic numbers and ensure consistency.
 */

// =============================================================================
// AI / Tool Execution Timeouts
// =============================================================================

/**
 * Maximum time allowed for a single tool execution (5 minutes).
 * Used by both main process and worker manager.
 */
export const TOOL_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Maximum duration for an AI stream before forced cancellation (10 minutes).
 * Prevents runaway streams from consuming resources indefinitely.
 */
export const MAX_STREAM_DURATION_MS = 10 * 60 * 1000;

/**
 * Default maximum steps for agent loops (tool-calling iterations).
 */
export const DEFAULT_MAX_STEPS = 10;

// =============================================================================
// Worker Defaults
// =============================================================================

/**
 * Default memory limit for workers in megabytes.
 */
export const DEFAULT_WORKER_MEMORY_LIMIT_MB = 1024;
