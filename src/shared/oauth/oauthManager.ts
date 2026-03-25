/**
 * OAuthManager — server-side OAuth token management via Nango.
 *
 * Wraps the Nango REST API with plain fetch (no SDK dependency).
 * Handles token caching, automatic refresh, connection lifecycle,
 * and per-panel consent tracking.
 *
 * Uses the shared DatabaseManager for SQLite access (token cache
 * and consent store) rather than managing connections directly.
 */

import { createDevLogger } from "@natstack/dev-log";
import type { DatabaseManager } from "../db/databaseManager.js";
import type { OAuthToken, OAuthConnection, ConsentRecord, NangoConnectionResponse } from "./types.js";

const log = createDevLogger("OAuthManager");

interface OAuthManagerOptions {
  nangoUrl: string;
  nangoSecretKey: string;
  databaseManager: DatabaseManager;
  /** Owner ID used for DatabaseManager handle tracking */
  ownerId?: string;
}

// In-memory token cache
interface CachedToken {
  token: OAuthToken;
  fetchedAt: number;
}

export class OAuthManager {
  private nangoUrl: string;
  private nangoSecretKey: string;
  private databaseManager: DatabaseManager;
  private ownerId: string;

  // In-memory token cache
  private tokenCache = new Map<string, CachedToken>();

  // Database handle (lazy-initialized)
  private dbHandle: string | null = null;

  constructor(opts: OAuthManagerOptions) {
    this.nangoUrl = opts.nangoUrl.replace(/\/$/, "");
    this.nangoSecretKey = opts.nangoSecretKey;
    this.databaseManager = opts.databaseManager;
    this.ownerId = opts.ownerId ?? "oauth-manager";
  }

  private ensureDb(): string {
    if (!this.dbHandle) {
      this.dbHandle = this.databaseManager.open(this.ownerId, "oauth");
      this.databaseManager.exec(this.dbHandle, `
        CREATE TABLE IF NOT EXISTS oauth_consent (
          panel_source TEXT NOT NULL,
          provider TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          granted_at INTEGER NOT NULL,
          PRIMARY KEY (panel_source, provider)
        )
      `);
      this.databaseManager.exec(this.dbHandle, `
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          provider TEXT NOT NULL,
          connection_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          scopes TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (provider, connection_id)
        )
      `);
    }
    return this.dbHandle;
  }

  // =========================================================================
  // Nango API
  // =========================================================================

  private get isConfigured(): boolean {
    return !!this.nangoUrl && !!this.nangoSecretKey;
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new Error(
        "OAuth not configured. Set oauth.nangoUrl in natstack.yml and " +
        "add nango secret to ~/.config/natstack/.secrets.yml",
      );
    }
  }

  private async nangoFetch(path: string, init?: RequestInit): Promise<Response> {
    this.assertConfigured();
    const url = `${this.nangoUrl}${path}`;
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.nangoSecretKey}`);

    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Nango API error ${res.status}: ${body}`);
    }
    return res;
  }

  // =========================================================================
  // Token management
  // =========================================================================

  async getToken(providerKey: string, connectionId: string): Promise<OAuthToken> {
    const cacheKey = `${providerKey}:${connectionId}`;

    // Check in-memory cache
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.token.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    // Check SQLite cache
    const handle = this.ensureDb();
    const row = this.databaseManager.get<{ access_token: string; expires_at: number; scopes: string }>(
      handle,
      "SELECT access_token, expires_at, scopes FROM oauth_tokens WHERE provider = ? AND connection_id = ?",
      [providerKey, connectionId],
    );

    if (row && row.expires_at > Date.now() + 60_000) {
      const token: OAuthToken = {
        accessToken: row.access_token,
        expiresAt: row.expires_at,
        scopes: JSON.parse(row.scopes),
      };
      this.tokenCache.set(cacheKey, { token, fetchedAt: Date.now() });
      return token;
    }

    // Fetch from Nango
    const res = await this.nangoFetch(
      `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
    );
    const data = await res.json() as NangoConnectionResponse;

    const token: OAuthToken = {
      accessToken: data.credentials.access_token,
      expiresAt: data.credentials.expires_at
        ? new Date(data.credentials.expires_at).getTime()
        : Date.now() + 3600_000,
      scopes: [],
    };

    // Cache
    this.tokenCache.set(cacheKey, { token, fetchedAt: Date.now() });
    this.databaseManager.run(
      handle,
      "INSERT OR REPLACE INTO oauth_tokens (provider, connection_id, access_token, expires_at, scopes) VALUES (?, ?, ?, ?, ?)",
      [providerKey, connectionId, token.accessToken, token.expiresAt, JSON.stringify(token.scopes)],
    );

    return token;
  }

  // =========================================================================
  // Connection management
  // =========================================================================

  async getConnection(providerKey: string, connectionId: string): Promise<OAuthConnection> {
    if (!this.isConfigured) {
      return { id: connectionId, provider: providerKey, connected: false };
    }

    try {
      const res = await this.nangoFetch(
        `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
      );
      const data = await res.json() as NangoConnectionResponse;
      return {
        id: data.connection_id,
        provider: data.provider_config_key,
        email: (data.metadata?.email as string) ?? undefined,
        connected: true,
        lastRefreshed: Date.now(),
      };
    } catch {
      return { id: connectionId, provider: providerKey, connected: false };
    }
  }

  async getAuthUrl(providerKey: string, connectionId: string): Promise<string> {
    this.assertConfigured();
    return `${this.nangoUrl}/auth/${encodeURIComponent(providerKey)}?connection_id=${encodeURIComponent(connectionId)}`;
  }

  async listConnections(): Promise<OAuthConnection[]> {
    if (!this.isConfigured) return [];

    try {
      const res = await this.nangoFetch("/connections");
      const data = await res.json() as { connections: Array<{ connection_id: string; provider_config_key: string }> };
      return (data.connections ?? []).map(c => ({
        id: c.connection_id,
        provider: c.provider_config_key,
        connected: true,
      }));
    } catch {
      return [];
    }
  }

  async disconnect(providerKey: string, connectionId: string): Promise<void> {
    if (!this.isConfigured) return;

    try {
      await this.nangoFetch(
        `/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(providerKey)}`,
        { method: "DELETE" },
      );
    } catch (err) {
      log.warn(`Failed to disconnect ${providerKey}/${connectionId}:`, err);
    }

    // Clear caches
    this.tokenCache.delete(`${providerKey}:${connectionId}`);
    const handle = this.ensureDb();
    this.databaseManager.run(
      handle,
      "DELETE FROM oauth_tokens WHERE provider = ? AND connection_id = ?",
      [providerKey, connectionId],
    );
  }

  // =========================================================================
  // Consent tracking
  // =========================================================================

  async hasConsent(panelSource: string, providerKey: string): Promise<boolean> {
    const handle = this.ensureDb();
    const row = this.databaseManager.get<{ c: number }>(
      handle,
      "SELECT 1 as c FROM oauth_consent WHERE panel_source = ? AND provider = ?",
      [panelSource, providerKey],
    );
    return !!row;
  }

  async grantConsent(panelSource: string, providerKey: string, scopes: string[]): Promise<void> {
    const handle = this.ensureDb();
    this.databaseManager.run(
      handle,
      "INSERT OR REPLACE INTO oauth_consent (panel_source, provider, scopes, granted_at) VALUES (?, ?, ?, ?)",
      [panelSource, providerKey, JSON.stringify(scopes), Date.now()],
    );
  }

  async revokeConsent(panelSource: string, providerKey: string): Promise<void> {
    const handle = this.ensureDb();
    this.databaseManager.run(
      handle,
      "DELETE FROM oauth_consent WHERE panel_source = ? AND provider = ?",
      [panelSource, providerKey],
    );
  }

  async listConsents(panelSource: string): Promise<ConsentRecord[]> {
    const handle = this.ensureDb();
    const rows = this.databaseManager.query<{ panel_source: string; provider: string; scopes: string; granted_at: number }>(
      handle,
      "SELECT panel_source, provider, scopes, granted_at FROM oauth_consent WHERE panel_source = ?",
      [panelSource],
    );

    return rows.map(r => ({
      panelSource: r.panel_source,
      provider: r.provider,
      scopes: JSON.parse(r.scopes),
      grantedAt: r.granted_at,
    }));
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  close(): void {
    if (this.dbHandle) {
      this.databaseManager.close(this.dbHandle);
      this.dbHandle = null;
    }
  }
}
