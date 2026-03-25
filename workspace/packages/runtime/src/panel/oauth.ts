/**
 * Panel-side OAuth client.
 *
 * Provides typed access to the server-side OAuth service for
 * token management, connection lifecycle, and consent tracking.
 */

import type { RpcBridge } from "@natstack/rpc";

export interface OAuthToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface OAuthConnection {
  id: string;
  provider: string;
  email?: string;
  connected: boolean;
  lastRefreshed?: number;
}

export interface OAuthConsentRequired {
  status: "consent-required";
  provider: string;
}

export interface ConsentRecord {
  panelId: string;
  provider: string;
  scopes: string[];
  grantedAt: number;
}

export interface OAuthStartAuthResult {
  authUrl: string;
  browserPanelId?: string;
}

export interface OAuthClient {
  /** Get a valid access token, auto-refreshing if needed. Requires prior consent. */
  getToken(providerKey: string, connectionId?: string): Promise<OAuthToken>;

  /**
   * All-in-one connect (consent + auth + wait). Blocks until complete.
   * For better UX, use the staged methods instead: requestConsent → startAuth → waitForConnection.
   */
  connect(providerKey: string, connectionId?: string, opts?: {
    scopes?: string[];
    reason?: string;
  }): Promise<OAuthConnection>;

  /**
   * Stage 1: Request consent. If not yet granted, shows a notification
   * in the shell chrome and blocks until the user approves/denies.
   * Returns immediately if consent was already granted.
   */
  requestConsent(providerKey: string, opts?: { scopes?: string[] }): Promise<{ consented: boolean }>;

  /**
   * Stage 2: Start the auth flow. Syncs imported cookies for the provider,
   * opens the Nango auth URL in a browser panel, and returns immediately.
   * The browser panel has autofill for imported passwords.
   */
  startAuth(providerKey: string, connectionId?: string): Promise<OAuthStartAuthResult>;

  /**
   * Stage 3: Wait for the OAuth flow to complete in the browser panel.
   * Polls the connection status until connected or timeout.
   */
  waitForConnection(providerKey: string, connectionId?: string, timeoutMs?: number): Promise<OAuthConnection>;

  /** Disconnect and revoke an OAuth connection. */
  disconnect(providerKey: string, connectionId?: string): Promise<void>;

  /** Get connection metadata without triggering auth. */
  getConnection(providerKey: string, connectionId?: string): Promise<OAuthConnection>;

  /** List all active connections. */
  listConnections(): Promise<OAuthConnection[]>;

  /** List configured OAuth providers from Nango. */
  listProviders(): Promise<Array<{ key: string; provider: string }>>;

  /** Explicitly grant consent for a provider (usually done via the consent notification). */
  grantConsent(providerKey: string, scopes: string[]): Promise<void>;

  /** Revoke consent for a provider. */
  revokeConsent(providerKey: string): Promise<void>;

  /** List all consent records for this panel. */
  listConsents(): Promise<ConsentRecord[]>;
}

export function createOAuthClient(rpc: RpcBridge): OAuthClient {
  const defaultConnId = (pk: string) => `default-${pk}`;

  return {
    async getToken(pk, cid) {
      return rpc.call<OAuthToken>("main", "oauth.getToken", pk, cid ?? defaultConnId(pk));
    },
    async connect(pk, cid, opts) {
      return rpc.call<OAuthConnection>("main", "oauth.connect", pk, cid ?? defaultConnId(pk), opts);
    },
    async requestConsent(pk, opts) {
      return rpc.call<{ consented: boolean }>("main", "oauth.requestConsent", pk, opts);
    },
    async startAuth(pk, cid) {
      return rpc.call<OAuthStartAuthResult>("main", "oauth.startAuth", pk, cid ?? defaultConnId(pk));
    },
    async waitForConnection(pk, cid, timeoutMs) {
      return rpc.call<OAuthConnection>("main", "oauth.waitForConnection", pk, cid ?? defaultConnId(pk), timeoutMs);
    },
    async disconnect(pk, cid) {
      await rpc.call<void>("main", "oauth.disconnect", pk, cid ?? defaultConnId(pk));
    },
    async getConnection(pk, cid) {
      return rpc.call<OAuthConnection>("main", "oauth.getConnection", pk, cid ?? defaultConnId(pk));
    },
    async listConnections() {
      return rpc.call<OAuthConnection[]>("main", "oauth.listConnections");
    },
    async listProviders() {
      return rpc.call<Array<{ key: string; provider: string }>>("main", "oauth.listProviders");
    },
    async grantConsent(pk, scopes) {
      await rpc.call<void>("main", "oauth.grantConsent", pk, scopes);
    },
    async revokeConsent(pk) {
      await rpc.call<void>("main", "oauth.revokeConsent", pk);
    },
    async listConsents() {
      return rpc.call<ConsentRecord[]>("main", "oauth.listConsents");
    },
  };
}
