/**
 * Shared OAuth client — used by both panels and workers.
 *
 * Provides typed access to the server-side OAuth service for
 * token management, connection lifecycle, and consent tracking.
 *
 * A single OAuthClient type is used everywhere. Server-side per-method
 * policy restricts which callers can invoke interactive auth methods.
 */

import type { RpcCaller } from "@natstack/rpc";

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

export interface ConsentRecord {
  callerId: string;
  provider: string;
  scopes: string[];
  grantedAt: number;
}

export interface OAuthStartAuthResult {
  authUrl: string;
  browserPanelId?: string;
}

/**
 * Unified OAuth client for panels and workers.
 * Server-side per-method policy restricts worker access to interactive methods.
 */
export interface OAuthClient {
  /** Get a valid access token, auto-refreshing if needed. */
  getToken(providerKey: string, connectionId?: string): Promise<OAuthToken>;

  /** Get connection metadata without triggering auth. */
  getConnection(providerKey: string, connectionId?: string): Promise<OAuthConnection>;

  /** List all active connections. */
  listConnections(): Promise<OAuthConnection[]>;

  /** List configured OAuth providers from Nango. */
  listProviders(): Promise<Array<{ key: string; provider: string }>>;

  /**
   * All-in-one connect (consent + auth + wait). Blocks until complete.
   * For better UX, use the staged methods instead: requestConsent → startAuth → waitForConnection.
   * Only available in panels — workers cannot drive the interactive auth flow.
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

  /** List all consent records for this caller. */
  listConsents(): Promise<ConsentRecord[]>;
}

export function createOAuthClient(rpc: RpcCaller): OAuthClient {
  const defaultConnId = (pk: string) => `default-${pk}`;

  return {
    async getToken(pk, cid) {
      return rpc.call<OAuthToken>("main", "oauth.getToken", pk, cid ?? defaultConnId(pk));
    },
    async connect(pk, cid, opts) {
      const connId = cid ?? defaultConnId(pk);
      // Stage 1: consent
      await rpc.call<{ consented: boolean }>("main", "oauth.requestConsent", pk, opts);
      // Stage 2: start auth (opens browser panel)
      await rpc.call<OAuthStartAuthResult>("main", "oauth.startAuth", pk, connId);
      // Stage 3: poll for connection (client-side, doesn't block RPC handler)
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const conn = await rpc.call<OAuthConnection>("main", "oauth.getConnection", pk, connId);
        if (conn.connected) return conn;
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error(`OAuth connection timed out for "${pk}"`);
    },
    async requestConsent(pk, opts) {
      return rpc.call<{ consented: boolean }>("main", "oauth.requestConsent", pk, opts);
    },
    async startAuth(pk, cid) {
      return rpc.call<OAuthStartAuthResult>("main", "oauth.startAuth", pk, cid ?? defaultConnId(pk));
    },
    async waitForConnection(pk, cid, timeoutMs) {
      const connId = cid ?? defaultConnId(pk);
      const deadline = Date.now() + (timeoutMs ?? 120_000);
      while (Date.now() < deadline) {
        const conn = await rpc.call<OAuthConnection>("main", "oauth.getConnection", pk, connId);
        if (conn.connected) return conn;
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error(`OAuth connection timed out for "${pk}"`);
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
    async listConsents() {
      return rpc.call<ConsentRecord[]>("main", "oauth.listConsents");
    },
  };
}
