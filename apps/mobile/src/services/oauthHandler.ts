/**
 * Mobile OAuth deep-link dispatcher.
 *
 * The OAuth flows on mobile (Codex login, credential providers) open the
 * system browser to the provider's authorize URL with `redirect_uri`
 * pointing back at this app. The browser hands the redirect URL to this
 * handler one of two ways:
 *
 *   1) Universal link / Android App Link (PRIMARY, app-identity bound):
 *        https://auth.snugenv.com/oauth/callback/<provider>?code=…&state=…
 *      The OS will only deliver these to *this* app once the AASA /
 *      assetlinks.json verification (served by apps/well-known/) has
 *      bound the host to our team-id + signing cert. Another app
 *      claiming the same host cannot intercept; that's the whole point.
 *
 *   2) `natstack://oauth/callback/<provider>?code=…&state=…`
 *      (TRANSITIONAL FALLBACK). The custom URL scheme is unverified —
 *      any app can register `natstack://`, so a malicious sibling app
 *      with a higher launch priority could grab the auth code. We log
 *      `warn` on every use; once telemetry shows zero hits, the scheme
 *      and its CFBundleURLTypes / intent-filter entries should be
 *      removed. See docs/audit/08-mobile-supply-chain.md H-2.
 *
 * State binding: every pending flow registered via
 * `authCallbackRegistry.registerPendingFlow(state, …)` carries an
 * unguessable PKCE-bound `state`. We look up by state. No state match =>
 * we drop the URL with a `warn` (replay, slow finger on a stale
 * authorize URL, or out-of-band launch).
 *
 * Deduplication: iOS will sometimes deliver the same URL twice (cold
 * start via `getInitialURL` followed by a subsequent `url` event from
 * the same intent). We remember the last 32 states for 5 min and
 * silently swallow the duplicate so `consumePendingFlow` is called at
 * most once per state.
 */

import { Linking, type EmitterSubscription } from "react-native";
import { consumePendingFlow } from "./authCallbackRegistry";
import type { ShellClient } from "./shellClient";

const UNIVERSAL_LINK_HOST = "auth.snugenv.com";
const CUSTOM_SCHEME = "natstack:";
const OAUTH_PATH_PREFIX = "/oauth/callback/";

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 32;

interface ParsedCallback {
  /** Provider id, e.g. "openai-codex", "linear", "github". */
  provider: string;
  code: string;
  state: string;
  rawUrl: string;
  /** True if the URL came over the unverified custom scheme. */
  viaCustomScheme: boolean;
}

/**
 * Parse the limited subset of URL shapes we accept. Returns null for
 * anything we don't recognize so the caller can no-op (some other deep
 * link, e.g. /connect onboarding, will be handled elsewhere).
 *
 * Implemented without `new URL(…)` because React Native's URL polyfill
 * historically chokes on custom schemes; manual parse is dependency-free
 * and easy to audit.
 */
function parseCallback(rawUrl: string): ParsedCallback | null {
  // Universal link: https://auth.snugenv.com/oauth/callback/<provider>?…
  if (rawUrl.startsWith("https://")) {
    const noScheme = rawUrl.slice("https://".length);
    const slash = noScheme.indexOf("/");
    const host = slash >= 0 ? noScheme.slice(0, slash) : noScheme;
    if (host.toLowerCase() !== UNIVERSAL_LINK_HOST) return null;
    const pathAndQuery = slash >= 0 ? noScheme.slice(slash) : "/";
    return parsePathAndQuery(rawUrl, pathAndQuery, /* viaCustomScheme */ false);
  }
  // Custom scheme fallback: natstack://oauth/callback/<provider>?…
  // React Native delivers these as `natstack://oauth/callback/...`, where
  // `oauth` is the URL "host" component. Normalise into a path.
  if (rawUrl.startsWith(CUSTOM_SCHEME)) {
    let rest = rawUrl.slice(CUSTOM_SCHEME.length);
    if (rest.startsWith("//")) rest = rest.slice(2);
    // Treat the entire remainder after the scheme as a `/path?query`.
    const pathAndQuery = rest.startsWith("/") ? rest : `/${rest}`;
    return parsePathAndQuery(rawUrl, pathAndQuery, /* viaCustomScheme */ true);
  }
  return null;
}

function parsePathAndQuery(
  rawUrl: string,
  pathAndQuery: string,
  viaCustomScheme: boolean,
): ParsedCallback | null {
  const queryStart = pathAndQuery.indexOf("?");
  const path =
    queryStart >= 0 ? pathAndQuery.slice(0, queryStart) : pathAndQuery;
  const query = queryStart >= 0 ? pathAndQuery.slice(queryStart + 1) : "";

  if (!path.startsWith(OAUTH_PATH_PREFIX)) return null;
  const provider = path.slice(OAUTH_PATH_PREFIX.length).replace(/\/+$/, "");
  if (!provider || provider.includes("/")) return null;

  const params = new Map<string, string>();
  for (const piece of query.split("&")) {
    if (!piece) continue;
    const eq = piece.indexOf("=");
    const key = eq >= 0 ? piece.slice(0, eq) : piece;
    const value = eq >= 0 ? piece.slice(eq + 1) : "";
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(value));
    } catch {
      // A malformed pct-escape means we can't trust anything in this
      // URL; bail out rather than half-parse.
      return null;
    }
  }

  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (error) {
    // Provider rejected the flow (user denied consent, etc.). We still
    // need to wake up the pending promise so the UI doesn't hang; we
    // synthesise a parsed callback with empty code so the dispatcher
    // can reject the registry entry.
    if (state) {
      return { provider, code: "", state, rawUrl, viaCustomScheme };
    }
    return null;
  }
  if (!code || !state) return null;
  return { provider, code, state, rawUrl, viaCustomScheme };
}

/**
 * Tiny LRU-ish dedupe set. Keyed by state since `code` is single-use and
 * the OS will never resend a different code for the same state.
 */
class StateDedupe {
  private readonly seen = new Map<string, number>();

  has(state: string): boolean {
    const ts = this.seen.get(state);
    if (ts === undefined) return false;
    if (Date.now() - ts > DEDUPE_WINDOW_MS) {
      this.seen.delete(state);
      return false;
    }
    return true;
  }

  remember(state: string): void {
    // Evict expired entries opportunistically so the map can't grow
    // unbounded if the app is left running for days.
    const now = Date.now();
    if (this.seen.size >= DEDUPE_MAX_ENTRIES) {
      for (const [k, ts] of this.seen) {
        if (now - ts > DEDUPE_WINDOW_MS) this.seen.delete(k);
        if (this.seen.size < DEDUPE_MAX_ENTRIES) break;
      }
      // If still full, drop the oldest entry (Map iteration order is
      // insertion order).
      if (this.seen.size >= DEDUPE_MAX_ENTRIES) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    this.seen.set(state, now);
  }
}

const dedupe = new StateDedupe();

function dispatch(shellClient: ShellClient, parsed: ParsedCallback): void {
  if (parsed.viaCustomScheme) {
    // Loud signal so we can drive the custom-scheme retirement. Do NOT
    // include `code` or `state` in the log (they're secrets / one-shot
    // capability tokens).
    console.warn(
      `[oauthHandler] OAuth callback delivered via natstack:// fallback (provider=${parsed.provider}). ` +
        `Universal link verification may be incomplete on this device.`,
    );
  }

  if (dedupe.has(parsed.state)) {
    // Duplicate delivery from the OS; the first delivery already
    // resolved the pending flow.
    return;
  }
  dedupe.remember(parsed.state);

  const entry = consumePendingFlow(parsed.state);
  if (!entry) {
    void shellClient.transport.call("main", "credentials.forwardOAuthCallback", {
      url: parsed.rawUrl,
      state: parsed.state,
    }).catch((err: unknown) => {
      console.warn(
        `[oauthHandler] Failed to forward OAuth callback for provider=${parsed.provider}:`,
        err,
      );
    });
    return;
  }

  if (!parsed.code) {
    entry.reject(new Error(`OAuth provider returned an error response`));
    return;
  }

  entry.resolve({ code: parsed.code, state: parsed.state });
}

function handleUrl(shellClient: ShellClient, rawUrl: string | null): void {
  if (!rawUrl) return;
  const parsed = parseCallback(rawUrl);
  if (!parsed) return; // Not for us — let other deep-link handlers see it.
  dispatch(shellClient, parsed);
}

/**
 * Wire the OAuth deep-link listener for the lifetime of a `ShellClient`
 * session. Called from App.tsx once the shell client is available; the
 * returned cleanup detaches the listener on unmount / sign-out.
 *
 * The `_shellClient` is currently unused — universal-link OAuth is
 * authenticated by the AASA-bound app identity, not by the shell
 * session. The argument is kept so callers can switch to shell-mediated
 * code exchange (e.g. handing the code straight to the server) without
 * a breaking API change. Mark with `void` so eslint/no-unused stays
 * quiet without changing the signature.
 */
export function setupOAuthHandler(shellClient: ShellClient): () => void {
  // Cold-start path: if the OS launched the app *because* of a deep
  // link, `getInitialURL` returns it once. Subsequent foreground
  // re-deliveries arrive via the `url` event.
  void Linking.getInitialURL()
    .then((url) => handleUrl(shellClient, url))
    .catch((err: unknown) => {
      console.warn("[oauthHandler] getInitialURL failed", err);
    });

  let subscription: EmitterSubscription | null = Linking.addEventListener(
    "url",
    ({ url }: { url: string }) => handleUrl(shellClient, url),
  );

  return () => {
    if (subscription) {
      subscription.remove();
      subscription = null;
    }
  };
}

// Test-only export. Not part of the stable surface; the underscore
// prefix is the convention. Used by unit tests that exercise URL
// parsing without spinning up Linking.
export const __test__ = { parseCallback };
