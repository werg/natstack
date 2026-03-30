/**
 * Shared OAuth types used by both the server-side OAuthManager
 * and the panel-side OAuthClient.
 */

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

/**
 * Nango connection response (subset of fields we use).
 */
export interface NangoConnectionResponse {
  id: number;
  connection_id: string;
  provider_config_key: string;
  credentials: {
    type: string;
    access_token: string;
    expires_at?: string;
    raw: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}
