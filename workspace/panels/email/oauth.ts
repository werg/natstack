/**
 * OAuth provider abstraction for the email panel.
 *
 * Now uses the NatStack runtime's built-in OAuth service (backed by Nango).
 * The runtime handles token refresh, consent prompts, and connection lifecycle.
 */

import { oauth } from "@workspace/runtime";
import type { OAuthToken, OAuthConnection } from "@workspace/runtime";

export type { OAuthToken, OAuthConnection };

export interface OAuthTokenProvider {
  getToken(): Promise<OAuthToken>;
  getConnection(): Promise<OAuthConnection>;
  connect(): Promise<OAuthConnection>;
  disconnect(): Promise<void>;
}

/**
 * Create a token provider backed by the NatStack OAuth runtime service.
 *
 * When `connect()` is called:
 * 1. If no consent: a notification appears in the shell chrome for approval
 * 2. After consent: Nango auth URL opens in a browser panel
 * 3. User completes OAuth flow in the browser panel
 * 4. Connection is returned with token access
 */
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
    async connect() {
      return oauth.connect(providerKey, connectionId, {
        scopes: ["gmail.readonly", "gmail.send", "calendar.readonly"],
      });
    },
    async disconnect() {
      await oauth.disconnect(providerKey, connectionId);
    },
  };
}
