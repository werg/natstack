/**
 * OAuth provider abstraction for the email panel.
 *
 * Now uses the NatStack runtime's built-in OAuth service (backed by Nango).
 * The runtime handles token refresh, consent prompts, and connection lifecycle.
 *
 * The connect flow uses staged methods so the panel can show appropriate
 * UI feedback at each step:
 * 1. requestConsent → "Waiting for approval..."
 * 2. startAuth → "Opening sign-in..." (browser panel opens with imported cookies/passwords)
 * 3. waitForConnection → "Complete sign-in in the browser panel..."
 */

import { oauth } from "@workspace/runtime";
import type { OAuthToken, OAuthConnection } from "@workspace/runtime";

export type { OAuthToken, OAuthConnection };

/** Progress callback for staged connect flow. */
export type ConnectProgress = (stage: "consent" | "auth" | "waiting" | "connected", message: string) => void;

export interface OAuthTokenProvider {
  getToken(): Promise<OAuthToken>;
  getConnection(): Promise<OAuthConnection>;
  /** Staged connect with progress feedback. */
  connect(onProgress?: ConnectProgress): Promise<OAuthConnection>;
  disconnect(): Promise<void>;
}

export function createTokenProvider(opts: {
  providerKey: string;
  connectionId?: string;
}): OAuthTokenProvider {
  const { providerKey } = opts;
  const connectionId = opts.connectionId;

  return {
    async getToken() {
      return oauth.getToken(providerKey, connectionId);
    },
    async getConnection() {
      return oauth.getConnection(providerKey, connectionId);
    },
    async connect(onProgress) {
      // Stage 1: Request consent (may show notification in shell chrome)
      onProgress?.("consent", "Requesting access...");
      await oauth.requestConsent(providerKey, {
        scopes: ["gmail.readonly", "gmail.send", "calendar.readonly"],
      });

      // Stage 2: Start auth (syncs cookies, opens browser panel)
      onProgress?.("auth", "Opening sign-in...");
      await oauth.startAuth(providerKey, connectionId);

      // Stage 3: Wait for the user to complete sign-in in the browser panel
      onProgress?.("waiting", "Complete sign-in in the browser panel...");
      const conn = await oauth.waitForConnection(providerKey, connectionId, 120_000);

      onProgress?.("connected", "Connected!");
      return conn;
    },
    async disconnect() {
      await oauth.disconnect(providerKey, connectionId);
    },
  };
}
