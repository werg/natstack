/**
 * OAuth deep link handler — intercepts `natstack://...` URLs.
 *
 * Two flows share the `natstack://` scheme:
 *
 *   - `natstack://oauth-callback?...` — Nango-mediated providers
 *     (Gmail, GitHub, Slack, etc.). The mobile shell forwards the raw
 *     callback params to the server's `oauth.callback` so the server can
 *     finish the exchange via Nango. Unchanged by the auth refactor.
 *
 *   - `natstack://auth-callback?code=...&state=...` — client-owned AI
 *     provider flows (OpenAI Codex). The mobile shell does the PKCE
 *     exchange itself via `@natstack/auth-flow` and ships the resulting
 *     tokens to the server's `authTokens.persist`. The pending flow is
 *     looked up by `state` in `authCallbackRegistry`.
 *
 * Setup:
 *   - iOS: `natstack` URL scheme in Info.plist (already registered)
 *   - Android: intent filter in AndroidManifest.xml (already registered)
 */

import { Linking } from "react-native";
import type { ShellClient } from "./shellClient";
import { consumePendingFlow } from "./authCallbackRegistry";

const NANGO_CALLBACK_PREFIX = "natstack://oauth-callback";
const CLIENT_AUTH_CALLBACK_PREFIX = "natstack://auth/callback";

function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });
  } catch {
    const queryIndex = url.indexOf("?");
    if (queryIndex === -1) return params;
    const queryString = url.slice(queryIndex + 1);
    for (const pair of queryString.split("&")) {
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) continue;
      const key = decodeURIComponent(pair.slice(0, eqIndex));
      const value = decodeURIComponent(pair.slice(eqIndex + 1));
      params[key] = value;
    }
  }
  return params;
}

/**
 * Set up the OAuth deep link handler. Listens for incoming `natstack://`
 * URLs and dispatches to the right code path. Returns a cleanup function.
 */
export function setupOAuthHandler(shellClient: ShellClient): () => void {
  const handleUrl = ({ url }: { url: string }) => {
    if (url.startsWith(CLIENT_AUTH_CALLBACK_PREFIX)) {
      handleClientAuthCallback(url);
      return;
    }
    if (url.startsWith(NANGO_CALLBACK_PREFIX)) {
      handleNangoCallback(url, shellClient);
      return;
    }
  };

  const subscription = Linking.addEventListener("url", handleUrl);

  // Cold-start deep-link.
  void Linking.getInitialURL().then((url: string | null) => {
    if (url) handleUrl({ url });
  });

  return () => {
    subscription.remove();
  };
}

function handleClientAuthCallback(url: string): void {
  const params = parseQueryParams(url);
  const state = params["state"] ?? "";
  const code = params["code"] ?? "";
  const error = params["error"];

  const pending = consumePendingFlow(state);
  if (!pending) {
    console.warn("[OAuthHandler] No matching pending auth flow for state:", state);
    return;
  }
  if (error) {
    pending.reject(new Error(`OAuth provider error: ${error}`));
    return;
  }
  if (!code) {
    pending.reject(new Error("OAuth callback missing code"));
    return;
  }
  pending.resolve({ code, state });
}

function handleNangoCallback(url: string, shellClient: ShellClient): void {
  const params = parseQueryParams(url);
  const providerKey = params["providerKey"] ?? params["provider_key"] ?? "";
  if (!providerKey) {
    console.warn("[OAuthHandler] Missing providerKey in Nango callback URL — server may reject");
  }
  const callbackData = {
    providerKey,
    connectionId: params["connectionId"] ?? params["connection_id"],
    code: params["code"],
    state: params["state"],
  };
  shellClient.transport
    .call("main", "oauth.callback", callbackData)
    .then(() => {
      console.log("[OAuthHandler] Nango callback forwarded to server");
    })
    .catch((error: unknown) => {
      console.error("[OAuthHandler] Failed to forward Nango callback:", error);
    });
}

/** Open an OAuth authorization URL in the system browser (Nango flows). */
export async function openOAuthUrl(authUrl: string): Promise<void> {
  const canOpen = await Linking.canOpenURL(authUrl);
  if (!canOpen) {
    console.error("[OAuthHandler] Cannot open URL:", authUrl);
    return;
  }
  await Linking.openURL(authUrl);
}
