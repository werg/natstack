/**
 * ws-auth — Token extraction and server-side validation for DO WebSocket connections.
 *
 * Panels connect with a token in the URL query params (matching current PubSub client behavior).
 * The DO validates the token by calling the server's /validate-token endpoint.
 */

import { HttpClient } from "./http-client.js";

export interface TokenValidationResult {
  valid: boolean;
  callerId?: string;
  callerKind?: string;
}

/**
 * Extract auth token from a WebSocket upgrade request URL.
 * Expects `?token=xxx` query parameter.
 */
export function extractToken(request: Request): string | null {
  const url = new URL(request.url);
  return url.searchParams.get("token");
}

/**
 * Validate a token against the server's /validate-token endpoint.
 * Returns caller identity on success, or { valid: false } on failure.
 */
export async function validateToken(
  serverUrl: string,
  authToken: string,
  token: string,
): Promise<TokenValidationResult> {
  try {
    const resp = await fetch(`${serverUrl}/validate-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) return { valid: false };
    const result = await resp.json() as TokenValidationResult;
    return result;
  } catch {
    return { valid: false };
  }
}
