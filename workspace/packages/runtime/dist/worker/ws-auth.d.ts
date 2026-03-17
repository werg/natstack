/**
 * ws-auth — Token extraction and server-side validation for DO WebSocket connections.
 *
 * Panels connect with a token in the URL query params (matching current PubSub client behavior).
 * The DO validates the token by calling the server's /validate-token endpoint.
 */
export interface TokenValidationResult {
    valid: boolean;
    callerId?: string;
    callerKind?: string;
}
/**
 * Extract auth token from a WebSocket upgrade request URL.
 * Expects `?token=xxx` query parameter.
 */
export declare function extractToken(request: Request): string | null;
/**
 * Validate a token against the server's /validate-token endpoint.
 * Returns caller identity on success, or { valid: false } on failure.
 */
export declare function validateToken(serverUrl: string, authToken: string, token: string): Promise<TokenValidationResult>;
//# sourceMappingURL=ws-auth.d.ts.map