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
  panelSource: string;
  provider: string;
  scopes: string[];
  grantedAt: number;
}

export interface OAuthClient {
  /** Get a valid access token, auto-refreshing if needed. Requires prior consent. */
  getToken(providerKey: string, connectionId?: string): Promise<OAuthToken>;

  /**
   * Initiate an OAuth connection flow.
   * If the panel hasn't been granted consent, a consent notification
   * appears in the shell chrome. The call blocks until the user
   * approves/denies and the OAuth flow completes.
   */
  connect(providerKey: string, connectionId?: string, opts?: {
    scopes?: string[];
    reason?: string;
  }): Promise<OAuthConnection>;

  /** Disconnect and revoke an OAuth connection. */
  disconnect(providerKey: string, connectionId?: string): Promise<void>;

  /** Get connection metadata without triggering auth. */
  getConnection(providerKey: string, connectionId?: string): Promise<OAuthConnection>;

  /** List all active connections. */
  listConnections(): Promise<OAuthConnection[]>;

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
    async disconnect(pk, cid) {
      await rpc.call<void>("main", "oauth.disconnect", pk, cid ?? defaultConnId(pk));
    },
    async getConnection(pk, cid) {
      return rpc.call<OAuthConnection>("main", "oauth.getConnection", pk, cid ?? defaultConnId(pk));
    },
    async listConnections() {
      return rpc.call<OAuthConnection[]>("main", "oauth.listConnections");
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
