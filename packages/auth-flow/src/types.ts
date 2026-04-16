/**
 * OAuth credentials returned by a provider's token endpoint after the
 * authorization-code exchange. Provider-agnostic shape — provider-specific
 * fields (e.g. OpenAI's `accountId`) are encoded in `extra`.
 *
 * Mirrors the field names used by `oauth-tokens.json` on the server, so the
 * server can persist a credential blob without re-shaping it.
 */
export interface AuthFlowCredentials {
  /** Bearer token used in API calls. */
  access: string;
  /** Long-lived token used to silently obtain a new `access` after expiry. */
  refresh: string;
  /** Absolute Unix-millis timestamp at which `access` expires. */
  expires: number;
  /** Provider-specific extras (e.g. accountId for OpenAI). */
  extra?: Record<string, unknown>;
}

/**
 * Identifies an in-flight authorization-code flow on the client side. The
 * `verifier` (PKCE) and `redirectUri` must be carried from auth-URL build
 * through callback handling to token exchange — the provider validates that
 * the same redirect URI used at /authorize is presented at /token.
 */
export interface AuthFlowSession {
  providerId: string;
  state: string;
  verifier: string;
  redirectUri: string;
}

/** Result of building an authorize URL for a provider. */
export interface AuthorizeRequest {
  authUrl: string;
  session: AuthFlowSession;
}
