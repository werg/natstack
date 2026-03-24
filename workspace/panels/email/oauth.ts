/**
 * OAuth provider abstraction for the email panel.
 *
 * Supports two strategies:
 *
 * 1. **Nango** (recommended for production) — delegates OAuth token lifecycle
 *    to a Nango instance. The panel only needs a connection ID; Nango handles
 *    refresh tokens, re-auth, and provider quirks. This is the path we want
 *    to build first-class support for in NatStack.
 *
 * 2. **Cookie-based** (existing NatStack capability) — uses imported browser
 *    cookies to access Google services in an authenticated browser panel via
 *    Playwright. Good for scraping/automation but not ideal for structured API
 *    access since it depends on session cookies that expire.
 *
 * The abstraction lets the email panel work with either strategy via a unified
 * `OAuthTokenProvider` interface, so the Gmail/Calendar API layer doesn't need
 * to know how tokens are obtained.
 *
 * ---
 *
 * ## What NatStack would need to add for Nango support:
 *
 * 1. A server-side `oauth` service (like `browser-data`) that:
 *    - Stores Nango server URL + secret key in app config
 *    - Proxies `nango.getConnection()` / `nango.getToken()` calls
 *    - Manages connection IDs per panel context
 *    - Triggers OAuth flows (opens Nango auth URL in a browser panel)
 *
 * 2. A runtime API addition:
 *    ```ts
 *    import { oauth } from "@workspace/runtime";
 *    const token = await oauth.getToken("google-mail");
 *    const connections = await oauth.listConnections();
 *    await oauth.connect("google-mail"); // opens auth flow
 *    ```
 *
 * 3. A permission in natstack.yml:
 *    ```yaml
 *    permissions:
 *      oauth:
 *        - provider: google-mail
 *          scopes: [gmail.readonly, calendar.readonly]
 *    ```
 */

import { rpc, db } from "@workspace/runtime";

// ---- Types ----

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

export interface OAuthTokenProvider {
  /** Get a valid access token, refreshing if needed */
  getToken(): Promise<OAuthToken>;
  /** Get connection metadata */
  getConnection(): Promise<OAuthConnection>;
  /** Initiate an OAuth flow (returns when user completes auth) */
  connect(): Promise<OAuthConnection>;
  /** Disconnect / revoke */
  disconnect(): Promise<void>;
}

// ---- Nango Strategy ----

/**
 * Token provider backed by a Nango instance.
 *
 * In the full implementation, this would call through to a server-side
 * `oauth` RPC service. For now, we simulate the interface and demonstrate
 * what the DX would look like.
 *
 * When NatStack adds `oauth` as a runtime service, this becomes:
 *   const token = await oauth.getToken("google-mail");
 */
export function createNangoProvider(opts: {
  providerKey: string;
  connectionId: string;
}): OAuthTokenProvider {
  const { providerKey, connectionId } = opts;

  return {
    async getToken(): Promise<OAuthToken> {
      // TODO: This is where we'd call the NatStack oauth service:
      //   return rpc.call("main", "oauth.getToken", providerKey, connectionId);
      //
      // For now, try the RPC call and fall back to a descriptive error
      // that shows what's missing.
      try {
        return await rpc.call("main", "oauth.getToken", providerKey, connectionId);
      } catch {
        throw new OAuthNotConfiguredError(
          `OAuth service not available. To enable:\n` +
          `1. Add a Nango instance URL to natstack.yml\n` +
          `2. Configure the "${providerKey}" integration in Nango\n` +
          `3. The panel will handle the rest via the oauth runtime service`,
        );
      }
    },

    async getConnection(): Promise<OAuthConnection> {
      try {
        return await rpc.call("main", "oauth.getConnection", providerKey, connectionId);
      } catch {
        return {
          id: connectionId,
          provider: providerKey,
          connected: false,
        };
      }
    },

    async connect(): Promise<OAuthConnection> {
      // In the full implementation, this would:
      // 1. Call oauth.getAuthUrl(providerKey) to get the Nango auth URL
      // 2. Open it in a browser panel via createBrowserPanel()
      // 3. Wait for the OAuth callback to complete
      // 4. Return the new connection
      try {
        return await rpc.call("main", "oauth.connect", providerKey, connectionId);
      } catch {
        throw new OAuthNotConfiguredError(
          `Cannot initiate OAuth flow — oauth service not registered.\n` +
          `This panel needs: oauth.connect("${providerKey}")`,
        );
      }
    },

    async disconnect(): Promise<void> {
      try {
        await rpc.call("main", "oauth.disconnect", providerKey, connectionId);
      } catch {
        // Silently ignore if service isn't available
      }
    },
  };
}

// ---- Cookie-based Strategy ----

/**
 * Token provider that uses imported browser cookies.
 *
 * This leverages NatStack's existing browser data import to access Google
 * services. It works by:
 * 1. Checking for Google OAuth cookies in the imported cookie store
 * 2. Using those cookies in a headless browser session to extract an
 *    access token from Google's OAuth consent flow
 *
 * This is a pragmatic fallback — it works today without any new server
 * infrastructure, but is fragile (cookies expire, Google may block).
 */
export function createCookieProvider(opts: {
  providerKey: string;
}): OAuthTokenProvider {
  let cachedToken: OAuthToken | null = null;

  return {
    async getToken(): Promise<OAuthToken> {
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        return cachedToken;
      }

      // Check if we have Google cookies imported
      const cookies = await rpc.call("main", "browser-data.getCookies", "google.com");
      if (!cookies || (cookies as unknown[]).length === 0) {
        throw new OAuthNotConfiguredError(
          `No Google cookies found. Import your browser cookies first:\n` +
          `1. Use the browser-import skill to import Chrome cookies\n` +
          `2. Ensure google.com cookies are included\n` +
          `3. Retry connecting`,
        );
      }

      // In a full implementation, this would:
      // 1. Sync cookies to a browser session
      // 2. Navigate to accounts.google.com/o/oauth2/auth with appropriate scopes
      // 3. Extract the access token from the redirect
      //
      // For now, surface the gap:
      throw new OAuthNotConfiguredError(
        `Google cookies found (${(cookies as unknown[]).length} cookies), but ` +
        `cookie-to-token extraction is not yet implemented.\n` +
        `This would require browser automation to complete the OAuth flow.\n` +
        `Recommended: use Nango instead for reliable token management.`,
      );
    },

    async getConnection(): Promise<OAuthConnection> {
      try {
        const cookies = await rpc.call("main", "browser-data.getCookies", "google.com");
        return {
          id: "cookie-session",
          provider: opts.providerKey,
          connected: (cookies as unknown[]).length > 0,
        };
      } catch {
        return {
          id: "cookie-session",
          provider: opts.providerKey,
          connected: false,
        };
      }
    },

    async connect(): Promise<OAuthConnection> {
      throw new OAuthNotConfiguredError(
        `Cookie-based auth requires importing browser cookies.\n` +
        `Use the browser-import skill or configure Nango for OAuth.`,
      );
    },

    async disconnect(): Promise<void> {
      cachedToken = null;
    },
  };
}

// ---- Helpers ----

export class OAuthNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthNotConfiguredError";
  }
}

/**
 * Create the best available token provider for a given provider key.
 * Tries Nango first, falls back to cookie-based.
 */
export function createTokenProvider(opts: {
  providerKey: string;
  connectionId?: string;
}): OAuthTokenProvider {
  const connectionId = opts.connectionId ?? `default-${opts.providerKey}`;

  // Try Nango first (preferred)
  return createNangoProvider({
    providerKey: opts.providerKey,
    connectionId,
  });
}

// ---- Persistent connection storage ----

interface StoredConnection {
  provider: string;
  connectionId: string;
  email?: string;
  strategy: "nango" | "cookie";
}

export async function loadSavedConnection(): Promise<StoredConnection | null> {
  try {
    const database = await db.open("email-panel");
    await database.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        email TEXT,
        strategy TEXT NOT NULL DEFAULT 'nango',
        created_at INTEGER NOT NULL
      )
    `);
    const row = await database.get<{
      provider: string;
      connection_id: string;
      email: string | null;
      strategy: string;
    }>("SELECT provider, connection_id, email, strategy FROM connections ORDER BY created_at DESC LIMIT 1");
    await database.close();

    if (!row) return null;
    return {
      provider: row.provider,
      connectionId: row.connection_id,
      email: row.email ?? undefined,
      strategy: row.strategy as "nango" | "cookie",
    };
  } catch {
    return null;
  }
}

export async function saveConnection(conn: StoredConnection): Promise<void> {
  try {
    const database = await db.open("email-panel");
    await database.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        email TEXT,
        strategy TEXT NOT NULL DEFAULT 'nango',
        created_at INTEGER NOT NULL
      )
    `);
    await database.run(
      "INSERT INTO connections (provider, connection_id, email, strategy, created_at) VALUES (?, ?, ?, ?, ?)",
      [conn.provider, conn.connectionId, conn.email ?? null, conn.strategy, Date.now()],
    );
    await database.close();
  } catch {
    // Non-fatal — connection still works, just won't persist across reloads
  }
}
