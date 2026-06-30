/**
 * Pipe / WebSocket close codes, shared across every transport so the
 * terminal-vs-retry decision is identical everywhere.
 *
 * A *terminal* close means "this session is gone for good — do NOT auto-reopen
 * it"; any other code is a transient drop the client re-establishes. Previously
 * the server-side `webrtcSessionShim` and the WS client transport each hardcoded
 * their own set, and they had drifted: 4093 (panel retired) was terminal on the
 * WebRTC pipe but not on WS, and 4005 (bad first message) was terminal on WS but
 * not on the pipe — so the same server close produced opposite reconnect
 * behavior per transport. This module is the single source of truth.
 */

/** Auth token was revoked while the connection was live. */
export const CLOSE_TOKEN_REVOKED = 4001;
/** First message on the socket was not `ws:auth` (protocol violation). */
export const CLOSE_EXPECTED_AUTH = 4005;
/** Auth token was missing / invalid / not permitted for this caller kind. */
export const CLOSE_INVALID_TOKEN = 4006;
/** Panel runtime lease denied (no lease, or held by another connection). */
export const CLOSE_LEASE_DENIED = 4090;
/** Panel runtime lease revoked (reassigned to a newer connection). */
export const CLOSE_LEASE_REVOKED = 4091;
/** Panel was retired (removed from the tree) — its session must not come back. */
export const CLOSE_PANEL_RETIRED = 4093;

/**
 * Closes after which the client must NOT reconnect the session. Every transport
 * (the server `webrtcSessionShim`, the WS client transport, anything that
 * classifies a close code) must consult this one set.
 */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CLOSE_TOKEN_REVOKED,
  CLOSE_EXPECTED_AUTH,
  CLOSE_INVALID_TOKEN,
  CLOSE_LEASE_DENIED,
  CLOSE_LEASE_REVOKED,
  CLOSE_PANEL_RETIRED,
]);

/** True when `code` is a terminal close (do not auto-reopen the session). */
export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_CLOSE_CODES.has(code);
}
