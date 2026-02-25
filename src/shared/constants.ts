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
// Content Security Policy
// =============================================================================

/**
 * Permissive CSP for panels and workers.
 * Allows connections to localhost services (git, pubsub) and external APIs.
 */
export const PANEL_CSP = [
  "default-src 'self' https: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http://localhost:* http://127.0.0.1:*",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' https: data: blob:",
  "font-src 'self' https: data:",
  "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* http://127.0.0.1:* https://127.0.0.1:* ws://localhost:* wss://localhost:* http://localhost:* https://localhost:* ws: wss: https:",
].join("; ");

/**
 * CSP meta tag for HTML injection.
 */
export const PANEL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP}">`;
