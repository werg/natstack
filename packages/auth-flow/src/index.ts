/**
 * @natstack/auth-flow — client-owned OAuth flow primitives.
 *
 * Builds authorize URLs, runs PKCE, exchanges authorization codes for
 * tokens. Pure logic, no IO except the final token-exchange `fetch`.
 * Consumed by Electron main (loopback redirect URI) and the mobile shell
 * (custom-URL-scheme redirect URI). The remote server only persists the
 * resulting credentials via `authTokens.persist`.
 */

export type { AuthFlowCredentials, AuthFlowSession, AuthorizeRequest } from "./types.js";
export { generatePkce, generateState } from "./pkce.js";
export * as openaiCodex from "./providers/openaiCodex.js";
