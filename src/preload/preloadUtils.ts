/**
 * Shared utilities for preload scripts.
 *
 * Only the shell preload uses this module (panels are served via HTTP
 * with globals injected inline by PanelHttpServer).
 */

// =============================================================================
// Constants for preload argument parsing
// =============================================================================

/** Argument prefix for WS port */
const ARG_WS_PORT = "--natstack-ws-port=";

/** Argument prefix for shell token */
const ARG_SHELL_TOKEN = "--natstack-shell-token=";

// =============================================================================
// Parsing functions
// =============================================================================

export function parseWsPort(): number | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_WS_PORT));
  if (!arg) return null;
  const port = parseInt(arg.slice(ARG_WS_PORT.length), 10);
  return isNaN(port) ? null : port;
}

export function parseShellToken(): string | null {
  const arg = process.argv.find((value) => value.startsWith(ARG_SHELL_TOKEN));
  return arg ? (arg.slice(ARG_SHELL_TOKEN.length) || null) : null;
}
