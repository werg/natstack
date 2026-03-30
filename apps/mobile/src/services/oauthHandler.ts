/**
 * OAuth deep link handler -- Intercepts natstack://oauth-callback URLs.
 *
 * When a panel triggers an OAuth flow (e.g., GitHub, Google), the
 * external browser redirects back to natstack://oauth-callback?...
 * with authorization codes or tokens. This service listens for those
 * deep links and forwards the callback data to the NatStack server
 * via RPC so the server can complete the OAuth exchange.
 *
 * URL scheme: natstack://oauth-callback?code=...&state=...
 *
 * Setup:
 * - iOS: Configure the `natstack` URL scheme in Info.plist
 * - Android: Configure the intent filter in AndroidManifest.xml
 */

import { Linking } from "react-native";
import type { ShellClient } from "./shellClient";

/** The URL scheme prefix for OAuth callbacks */
const OAUTH_CALLBACK_PREFIX = "natstack://oauth-callback";

/**
 * Parse query parameters from a URL string.
 * Returns a plain object of key-value pairs.
 */
function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });
  } catch {
    // If URL constructor fails (e.g., custom scheme), parse manually
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
 * Set up the OAuth deep link handler.
 *
 * Listens for incoming `natstack://oauth-callback?...` URLs and
 * forwards the callback parameters to the server via RPC.
 *
 * @param shellClient - The connected ShellClient instance
 * @returns A cleanup function to remove the listener
 *
 * Usage:
 *   const cleanup = setupOAuthHandler(shellClient);
 *   // ... later, on unmount:
 *   cleanup();
 */
export function setupOAuthHandler(shellClient: ShellClient): () => void {
  const handleUrl = ({ url }: { url: string }) => {
    if (!url.startsWith(OAUTH_CALLBACK_PREFIX)) return;

    console.log("[OAuthHandler] Received callback:", url);

    const params = parseQueryParams(url);

    // The server requires { providerKey, connectionId?, code?, state? }.
    // The auth URL includes provider_key (added in oauthManager.getAuthUrl),
    // and Nango forwards it through the redirect. Also check providerKey
    // (camelCase) in case a future redirect uses that form.
    const providerKey = params["providerKey"] ?? params["provider_key"] ?? "";
    if (!providerKey) {
      console.warn("[OAuthHandler] Missing providerKey in callback URL — server may reject");
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
        console.log("[OAuthHandler] Callback forwarded to server");
      })
      .catch((error: unknown) => {
        console.error("[OAuthHandler] Failed to forward callback:", error);
      });
  };

  // Listen for deep links while the app is running
  const subscription = Linking.addEventListener("url", handleUrl);

  // Also check for a deep link that opened the app (cold start)
  void Linking.getInitialURL().then((url: string | null) => {
    if (url && url.startsWith(OAUTH_CALLBACK_PREFIX)) {
      handleUrl({ url });
    }
  });

  // Return cleanup function
  return () => {
    subscription.remove();
  };
}

/**
 * Open an OAuth authorization URL in the system browser.
 *
 * Called by panels that need to initiate an OAuth flow. The external
 * browser will handle the OAuth provider's login page and redirect
 * back to natstack://oauth-callback when complete.
 *
 * @param authUrl - The OAuth authorization URL to open
 */
export async function openOAuthUrl(authUrl: string): Promise<void> {
  const canOpen = await Linking.canOpenURL(authUrl);
  if (!canOpen) {
    console.error("[OAuthHandler] Cannot open URL:", authUrl);
    return;
  }
  await Linking.openURL(authUrl);
}
