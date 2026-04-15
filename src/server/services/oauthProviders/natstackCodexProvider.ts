/**
 * NatstackCodexProvider — OpenAI Codex (ChatGPT) OAuth flow, owned by us.
 *
 * Why this exists: pi-ai's `loginOpenAICodex` hardcodes
 * `REDIRECT_URI = http://localhost:1455/auth/callback` and spins up its own
 * local HTTP server on port 1455 to receive the callback. That works only
 * when the user's browser runs on the same machine as the server. In a
 * remote-server setup (user's laptop runs Electron, but the natstack-server
 * runs on a home server or VPS), the browser can't reach `localhost:1455`
 * because *that's on the server*. We can't patch pi-ai to use a different
 * redirect URI without upstream changes, because the authorization URL and
 * the token exchange both must share the same `redirect_uri`.
 *
 * This provider owns the full flow end-to-end:
 *   1. Generate PKCE verifier/challenge and a CSRF state.
 *   2. Register a flow entry keyed by state, with a 10-minute TTL.
 *   3. Build the authorize URL with `redirect_uri =
 *      ${NATSTACK_PUBLIC_URL}/_r/s/auth/oauth/callback` (the gateway-owned
 *      route; see Phase 1).
 *   4. Invoke `callbacks.onAuth({ url })` — the caller (authService) then
 *      surfaces the URL to the initiating client for opening.
 *   5. Wait (with abort/timeout) for the callback handler to resolve the
 *      flow with the authorization code.
 *   6. Exchange the code for tokens at `https://auth.openai.com/oauth/token`
 *      using our `redirectUri` (MUST match step 3).
 *   7. Extract the account ID from the JWT and return OAuthCredentials.
 *
 * `refreshToken` and `getApiKey` delegate to pi-ai's existing
 * `openaiCodexOAuthProvider` — those paths don't touch a callback server
 * and are already correct.
 *
 * Durability: the flow table lives in-process. If the server restarts mid-
 * flow, the user retries. Acceptable for v1 (OAuth is seconds-scale). A
 * DO-backed table would survive restarts; reserved for a later phase.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("NatstackCodexProvider");

// ── OpenAI OAuth constants (mirror pi-ai/openai-codex.js) ──
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Lazy pi-ai import — ESM subpath from our CJS bundle, mirrors authService.ts.
type PiAiOauthModule = {
  openaiCodexOAuthProvider: OAuthProviderInterface;
};
let _piAiOauthPromise: Promise<PiAiOauthModule> | null = null;
function loadPiAiOauth(): Promise<PiAiOauthModule> {
  if (!_piAiOauthPromise) {
    _piAiOauthPromise = import(
      "@mariozechner/pi-ai/oauth"
    ) as Promise<PiAiOauthModule>;
  }
  return _piAiOauthPromise;
}

import { oauthSuccessHtml, oauthErrorHtml } from "@natstack/shared/oauthPage";

/**
 * Test-only access to private provider state. Indirected through a symbol
 * so it's impossible to call accidentally from production code: callers
 * must `import { __testAccess }` explicitly. Not exported via the service
 * surface; real consumers never need this.
 */
export const __testAccess: unique symbol = Symbol("NatstackCodexProvider.__testAccess");

export interface NatstackCodexTestHandle {
  pendingStates(): string[];
  resolveFlow(state: string, code: string): boolean;
}

interface FlowEntry {
  verifier: string;
  redirectUri: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  /** Expiry timer. Cleared on resolve/reject/teardown. */
  timer: NodeJS.Timeout;
}

// ── PKCE ──
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(verifier),
  );
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    // Base64url → base64; atob handles base64 only.
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as
    | { chatgpt_account_id?: unknown }
    | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

// ── Flow table + provider ──

export interface NatstackCodexProviderDeps {
  /** Returns the externally-reachable base URL (e.g. "https://server.lan:3000").
   *  No trailing slash. Callback path is always `/_r/s/auth/oauth/callback`. */
  getPublicUrl: () => string;
  /** Override used by tests to inject mocked transports. */
  fetchImpl?: typeof fetch;
  /** `nowMs`: injection point for deterministic expiry tests. */
  nowMs?: () => number;
  /** Override originator string in auth URL. Default "pi". */
  originator?: string;
}

/** Public path under the gateway that our callback listens on. Kept as a
 *  constant so both the authService route registration and this provider's
 *  `redirect_uri` computation stay in sync. */
export const CODEX_CALLBACK_PATH = "/oauth/callback";
/** Service-route-namespaced path (for logging / errors). */
export const CODEX_CALLBACK_FULL_PATH = "/_r/s/auth/oauth/callback";

export class NatstackCodexProvider implements OAuthProviderInterface {
  readonly id = "openai-codex";
  readonly name = "ChatGPT Plus/Pro (Codex Subscription)";
  readonly usesCallbackServer = false;

  private readonly flows = new Map<string, FlowEntry>();

  constructor(private readonly deps: NatstackCodexProviderDeps) {}

  /** Build the absolute callback URL from the current public-url config. */
  private callbackUrl(): string {
    const base = this.deps.getPublicUrl().replace(/\/$/, "");
    return `${base}${CODEX_CALLBACK_FULL_PATH}`;
  }

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const { verifier, challenge } = await generatePkce();
    const state = randomBytes(16).toString("hex");
    const redirectUri = this.callbackUrl();

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", this.deps.originator ?? "pi");

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.flows.delete(state);
        reject(new Error("OAuth flow timed out after 10 minutes"));
      }, FLOW_TTL_MS);

      // Tie AbortSignal (if present) to flow cancellation.
      if (callbacks.signal) {
        const onAbort = () => {
          const entry = this.flows.get(state);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.flows.delete(state);
          reject(new Error("OAuth flow aborted"));
        };
        if (callbacks.signal.aborted) onAbort();
        else callbacks.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.flows.set(state, { verifier, redirectUri, resolve, reject, timer });

      // Hand the URL off to the caller AFTER the flow is registered so there's
      // no race where the callback arrives before we're ready.
      try {
        callbacks.onAuth({
          url: url.toString(),
          instructions:
            "Open this URL to complete sign-in. The window will close itself when done.",
        });
      } catch (err) {
        clearTimeout(timer);
        this.flows.delete(state);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const tokens = await this.exchangeCode(code, verifier, redirectUri);
    const accountId = getAccountId(tokens.access);
    if (!accountId) {
      throw new Error("Failed to extract accountId from access token");
    }
    return {
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
      accountId,
    };
  }

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const mod = await loadPiAiOauth();
    return mod.openaiCodexOAuthProvider.refreshToken(credentials);
  }

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  }

  /**
   * Gateway route handler: resolves a pending flow with the `code` query
   * param, or renders an error page.
   */
  async handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";

    const entry = this.flows.get(state);
    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        oauthErrorHtml(
          "No matching OAuth flow.",
          "The login request has expired or was already completed. Please start the flow again from the app.",
        ),
      );
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(oauthErrorHtml("Missing authorization code."));
      entry.reject(new Error("OAuth callback missing code"));
      clearTimeout(entry.timer);
      this.flows.delete(state);
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      oauthSuccessHtml(
        "OpenAI authentication completed. You can close this window.",
      ),
    );

    clearTimeout(entry.timer);
    this.flows.delete(state);
    entry.resolve(code);
  }

  /** Drop all in-flight flows. Called on shutdown and from tests. */
  teardown(): void {
    for (const entry of this.flows.values()) {
      clearTimeout(entry.timer);
      try { entry.reject(new Error("Provider torn down")); } catch { /* ignore */ }
    }
    this.flows.clear();
  }

  /**
   * Test-only accessor — see `__testAccess` at module top. Private state
   * (pending flow table, synthetic resolve) is reachable only through the
   * exported symbol, not by any public method name. Production callers
   * have no way to accidentally poke at it.
   */
  [__testAccess](): NatstackCodexTestHandle {
    return {
      pendingStates: () => [...this.flows.keys()],
      resolveFlow: (state, code) => {
        const entry = this.flows.get(state);
        if (!entry) return false;
        clearTimeout(entry.timer);
        this.flows.delete(state);
        entry.resolve(code);
        return true;
      },
    };
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<{ access: string; refresh: string; expires: number }> {
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const response = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.error(`code→token exchange failed: ${response.status} ${text}`);
      throw new Error(`OAuth token exchange failed (${response.status})`);
    }
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (
      !json.access_token ||
      !json.refresh_token ||
      typeof json.expires_in !== "number"
    ) {
      throw new Error("OAuth token response missing expected fields");
    }
    const now = this.deps.nowMs ? this.deps.nowMs() : Date.now();
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: now + json.expires_in * 1000,
    };
  }
}
