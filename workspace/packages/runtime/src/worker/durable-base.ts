/**
 * DurableObjectBase — Tiny generic foundation for all Durable Objects.
 *
 * Only what every DO needs: context, SQL, schema versioning, state KV,
 * alarm support, HTTP dispatch, WebSocket upgrade stub, and hibernation hooks.
 *
 * Agent-specific concerns (harnesses, turns, subscriptions, streams) live
 * in @workspace/agentic-do — composable modules that extend this base.
 */

import { createHttpRpcBridge } from "../shared/httpRpcBridge.js";
import { createOAuthClient, type OAuthClient } from "../shared/oauth.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { createDbClient } from "../shared/database.js";
import { createRpcFs } from "../shared/rpcFs.js";
import { createParentHandle } from "../shared/handles.js";
import type { RpcBridge } from "@natstack/rpc";
import type { DbClient } from "@natstack/types";
import type { RuntimeFs } from "../types.js";

// Minimal types for workerd DurableObject context (cannot import cloudflare:workers in Node)

export interface DurableObjectContext {
  id: { toString(): string; name?: string };
  storage: {
    sql: SqlStorage;
    setAlarm(scheduledTime: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
  };
  // Tagged accept: tags survive hibernation, retrievable via getWebSockets(tag)
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  // Retrieve by tag, or all if no tag
  getWebSockets(tag?: string): WebSocket[];
  // Run async init during construction or upgrade (blocks other events)
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlResult;
}

export interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export abstract class DurableObjectBase {
  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected env: Record<string, unknown>;

  private _schemaReady = false;
  private _rpc: (RpcBridge & { handleIncomingPost(body: unknown): Promise<unknown> }) | null = null;
  private _oauth: OAuthClient | null = null;
  private _notifications: NotificationClient | null = null;
  private _db: DbClient | null = null;
  private _fs: RuntimeFs | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.env = env as Record<string, unknown>;
    // Schema is NOT initialized here — deferred to first fetch()/alarm().
    // This avoids the init-order bug where createTables() would be called
    // during super() before subclass fields are initialized.
  }

  // --- Schema (lazy init, enforced automatically) ---

  static schemaVersion = 1;

  /** Subclasses define their SQL tables here. Called during schema init. */
  protected abstract createTables(): void;

  /**
   * Lazily called on first fetch() or alarm(). Safe for subclasses to call
   * earlier from their constructor if they need schema before first request.
   */
  protected ensureReady(): void {
    if (this._schemaReady) return;
    this.ensureSchema();
    this._schemaReady = true; // only after success — allows retry on next request if init throws
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    let currentVersion = 0;
    try {
      const row = this.sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray();
      if (row.length > 0) currentVersion = parseInt(row[0]!["value"] as string, 10);
    } catch { /* table might not have the row yet */ }

    const targetVersion = (this.constructor as typeof DurableObjectBase).schemaVersion;
    if (currentVersion < targetVersion) {
      this.createTables();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion),
      );
    }
  }

  // --- State KV (generic, always available) ---

  protected getStateValue(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    return row.length > 0 ? (row[0]!["value"] as string) : null;
  }

  protected setStateValue(key: string, value: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
      key, value,
    );
  }

  protected deleteStateValue(key: string): void {
    this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
  }

  /** Persist identity fields from postToDOWithToken envelope. */
  protected persistIdentity(instanceToken?: string, instanceId?: string, parentId?: string): void {
    if (instanceToken) {
      const existing = this.getStateValue("__instanceToken");
      if (existing !== instanceToken) {
        this.setStateValue("__instanceToken", instanceToken);
        this._rpc = null;
      }
    }
    if (parentId && !this.getStateValue("__parentId")) {
      this.setStateValue("__parentId", parentId);
    }
    if (instanceId) {
      this.setStateValue("__instanceId", instanceId);
    }
  }

  /**
   * Parse a POST body, handling the postToDOWithToken envelope format.
   * Returns the extracted args and an optional error string if the envelope is malformed.
   * On success, also calls persistIdentity() with the envelope fields.
   */
  protected parseRequestBody(body: string): { args: unknown[]; error?: string } {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return { args: parsed };
    }
    if (parsed && typeof parsed === "object" && "__instanceToken" in parsed) {
      const args = Array.isArray(parsed.args) ? parsed.args : parsed.args !== undefined ? [parsed.args] : [];
      const token = parsed.__instanceToken;
      if (typeof token !== "string") {
        return { args: [], error: "Invalid envelope: __instanceToken must be a string" };
      }
      this.persistIdentity(
        token,
        typeof parsed.__instanceId === "string" ? parsed.__instanceId : undefined,
        typeof parsed.__parentId === "string" ? parsed.__parentId : undefined,
      );
      return { args };
    }
    return { args: [parsed] };
  }

  // --- RPC bridge + shared clients (lazy) ---

  /** RPC bridge for calling services and other workers/DOs */
  protected get rpc(): RpcBridge & { handleIncomingPost(body: unknown): Promise<unknown> } {
    if (!this._rpc) {
      const token = this.getStateValue("__instanceToken");
      if (!token) {
        throw new Error("RPC not available: no instance token. This DO has not been dispatched via postToDOWithToken yet.");
      }
      const serverUrl = this.env["SERVER_URL"] as string;
      if (!serverUrl) {
        throw new Error("RPC not available: SERVER_URL not configured");
      }
      const instanceId = this.getStateValue("__instanceId");
      this._rpc = createHttpRpcBridge({
        selfId: instanceId ?? `do:unknown:${this.objectKey}`,
        serverUrl,
        authToken: token,
      });
    }
    return this._rpc;
  }

  /** OAuth client for token access */
  protected get oauth(): OAuthClient {
    if (!this._oauth) this._oauth = createOAuthClient(this.rpc);
    return this._oauth;
  }

  /** Notification client for shell notifications */
  protected get notifications(): NotificationClient {
    if (!this._notifications) this._notifications = createNotificationClient(this.rpc);
    return this._notifications;
  }

  /** Database client */
  protected get db(): DbClient {
    if (!this._db) this._db = createDbClient(this.rpc);
    return this._db;
  }

  /** Filesystem client */
  protected get fs(): RuntimeFs {
    if (!this._fs) this._fs = createRpcFs(this.rpc);
    return this._fs;
  }

  /** Get a handle to the parent (first dispatcher) */
  protected getParent() {
    const parentId = this.getStateValue("__parentId");
    return createParentHandle({ rpc: this.rpc, parentId: parentId ?? null });
  }

  // --- Object key identity ---
  // Set from the first fetch() request URL: /{objectKey}/{method}
  // The router includes the objectKey in the forwarded URL.

  private _objectKey: string | null = null;

  protected get objectKey(): string {
    if (this._objectKey) return this._objectKey;
    // Fallback to ctx.id.name (available in some workerd versions)
    const name = this.ctx.id.name;
    if (name) { this._objectKey = name; return name; }
    // Fallback to persisted state (survives hibernation)
    try {
      const stored = this.sql.exec(`SELECT value FROM state WHERE key = '__objectKey'`).toArray();
      if (stored.length > 0) {
        this._objectKey = stored[0]!["value"] as string;
        return this._objectKey;
      }
    } catch { /* state table may not exist yet */ }
    throw new Error("objectKey not available — no request received yet and ctx.id.name not set");
  }

  // --- Alarm (persists across workerd restarts) ---

  protected setAlarm(delayMs: number): void {
    this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /** Override in subclasses for timed callbacks. Call super.alarm() first. */
  async alarm(): Promise<void> {
    this.ensureReady();
  }

  // --- HTTP dispatch + WebSocket upgrade ---

  async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    // Parse /{objectKey}/{method} — router includes objectKey in forwarded URL
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this._objectKey) {
      this._objectKey = decodeURIComponent(segments[0]!);
      // Persist for hibernation recovery
      try { this.sql.exec(`INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`, this._objectKey); }
      catch { /* state table may not exist yet — ensureReady hasn't run */ }
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    // RPC endpoint — handle incoming RPC calls
    if (method === "__rpc") {
      const body = await request.json();
      const result = await this.rpc.handleIncomingPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }

      // Event endpoint — handle incoming events
      if (method === "__event") {
        if (args.length < 2) {
          return new Response(JSON.stringify({ error: "__event requires at least [event, payload]" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const [event, payload, fromId] = args as [string, unknown, string | undefined];
        await this.rpc.handleIncomingPost({ type: "emit", event, payload, fromId: fromId ?? "" });
        return new Response(JSON.stringify({ result: "ok" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const fn = (this as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        return new Response(JSON.stringify({ error: `Unknown method: ${method}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
      return new Response(JSON.stringify(result ?? null), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  /** Override in subclasses to accept WebSocket connections. */
  protected handleWebSocketUpgrade(_request: Request): Response {
    return new Response("WebSocket not supported", { status: 426 });
  }

  // --- Hibernation hooks ---
  // On a resumed hibernated DO, workerd can invoke these on a fresh instance
  // WITHOUT going through fetch(), so schema must be ready here too.
  // Subclasses that override these MUST call super.webSocketMessage() etc.

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    this.ensureReady();
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.ensureReady();
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    this.ensureReady();
  }

  // --- Clone support ---

  /** Scrub RPC identity state after cloning so the clone gets fresh identity on next dispatch. */
  protected scrubRpcIdentity(): void {
    this.deleteStateValue("__instanceToken");
    this.deleteStateValue("__parentId");
    this.deleteStateValue("__instanceId");
    this._rpc = null;
    this._oauth = null;
    this._notifications = null;
    this._db = null;
    this._fs = null;
  }

  // --- Introspection ---

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state };
  }
}
