/**
 * OpenAI Codex (ChatGPT subscription) auth flow — client side.
 *
 * Splits the work that previously lived in
 * `src/server/services/oauthProviders/natstackCodexProvider.ts`:
 *
 *  - This module owns auth-URL construction, PKCE binding, and
 *    code→token exchange. It runs on the *client* (Electron main or
 *    mobile shell), terminating the OAuth flow there.
 *  - The server keeps only the `getApiKey` / `refreshToken` parts of
 *    `OAuthProviderInterface` (the parts that don't need a browser).
 *
 * `redirect_uri` is supplied by the caller — desktop binds an ephemeral
 * loopback HTTP server on `127.0.0.1:<port>` (RFC 8252 §7.3); mobile uses
 * a custom URL scheme registered in `Info.plist` / `AndroidManifest.xml`.
 * OpenAI's OAuth client accepts arbitrary redirect URIs as long as the
 * `client_id` matches and PKCE/state validate.
 */

import { generatePkce, generateState } from "../pkce.js";
import type { AuthFlowCredentials, AuthorizeRequest } from "../types.js";

const PROVIDER_ID = "openai-codex";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/**
 * Build the authorize URL the user's browser should open. The returned
 * `session` carries the PKCE verifier + state — pass it back to
 * `exchangeCode` once the redirect lands so we can validate state and
 * complete the exchange with the matching verifier.
 */
export async function buildAuthorizeUrl(opts: { redirectUri: string; originator?: string }): Promise<AuthorizeRequest> {
  const { verifier, challenge } = await generatePkce();
  const state = generateState();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  // Must match a value OpenAI has allowlisted for this client_id. The
  // official openai/codex Rust CLI uses "codex_cli_rs" as the canonical
  // value (see codex-rs/login/src/auth/default_client.rs DEFAULT_ORIGINATOR).
  // Pi-ai's "pi" default is *not* on the list and gets `unknown_error` at
  // the authorize endpoint.
  url.searchParams.set("originator", opts.originator ?? "codex_cli_rs");

  return {
    authUrl: url.toString(),
    session: {
      providerId: PROVIDER_ID,
      state,
      verifier,
      redirectUri: opts.redirectUri,
    },
  };
}

/**
 * Exchange the authorization code for tokens. The caller is responsible for
 * having already validated `state` against `session.state` before calling.
 */
export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}): Promise<AuthFlowCredentials> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const response = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: opts.code,
      code_verifier: opts.verifier,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI Codex token exchange failed (${response.status}): ${text}`);
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI Codex token response missing expected fields");
  }
  const accountId = extractAccountId(json.access_token);
  if (!accountId) {
    throw new Error("OpenAI Codex access token missing chatgpt_account_id claim");
  }
  const now = opts.nowMs ? opts.nowMs() : Date.now();
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: now + json.expires_in * 1000,
    extra: { accountId },
  };
}

export const PROVIDER_INFO = {
  id: PROVIDER_ID,
  displayName: "OpenAI Codex (ChatGPT subscription)",
} as const;

// ── Internals ──────────────────────────────────────────────────────────

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
