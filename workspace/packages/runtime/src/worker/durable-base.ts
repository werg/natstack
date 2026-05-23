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
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { _initFsWithRpc } from "./fs.js";
import { createParentHandle } from "../shared/handles.js";
import type { RpcBridge } from "@natstack/rpc";
import type { RuntimeFs } from "../types.js";

// ---------------------------------------------------------------------------
// Console bridge — forwards DO console.* output to the server terminal.
//
// workerd's native console routing does not reliably surface DO logs to the
// embedding process's stdout/stderr, which makes swallowed errors inside DOs
// invisible during development. The bridge installs a proxy that, in
// addition to the local console.*, fires a best-effort `workerLog.write`
// RPC to the server. The server's `workerLog` service prefixes the caller
// DO's identity and prints through dev-log, so lines appear in the main
// terminal as `[server] [workerLog] [do:<src>:<cls>:<key>] <level>: <msg>`.
//
// Installed at most once per isolate via a module-local guard. The bridged
// handlers route their own failure logs back to the original console to
// avoid recursion.
// ---------------------------------------------------------------------------

let consoleBridgeInstalled = false;

function installConsoleBridge(rpc: RpcBridge): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  // Re-entrancy guard: if the RPC path itself logs (directly or via a
  // downstream library), the proxy would recurse. Keep forwards suppressed
  // while one is in-flight on the same synchronous stack.
  let forwarding = false;
  const forward = (level: "log" | "info" | "warn" | "error", args: unknown[]): void => {
    if (forwarding) return;
    forwarding = true;
    let message: string;
    try {
      message = args
        .map((a) => {
          if (typeof a === "string") return a;
          if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
          try { return JSON.stringify(a); }
          catch { return String(a); }
        })
        .join(" ");
    } catch {
      message = "<unserializable>";
    }
    try {
      // Fire-and-forget. Failures go to the *original* console to avoid
      // infinite recursion if the RPC path itself is broken.
      rpc.call("main", "workerLog.write", [level, message]).catch((err) => {
        original.warn("[console-bridge] forward failed:", err);
      });
    } finally {
      forwarding = false;
    }
  };
  console.log = (...args: unknown[]) => { original.log(...args); forward("log", args); };
  console.info = (...args: unknown[]) => { original.info(...args); forward("info", args); };
  console.warn = (...args: unknown[]) => { original.warn(...args); forward("warn", args); };
  console.error = (...args: unknown[]) => { original.error(...args); forward("error", args); };
}

// Minimal types for workerd DurableObject context (cannot import cloudflare:workers in Node)

export interface DurableObjectContext {
  id: { toString(): string; name?: string };
  storage: {
    sql: SqlStorage;
    setAlarm(scheduledTime: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
    /**
     * Run a synchronous block inside a DO storage transaction. Workerd
     * rejects raw `BEGIN`/`COMMIT` SQL and requires this API instead — it
     * auto-rolls-back on thrown exceptions and coalesces with the DO's
     * atomic-write semantics. The callback must be synchronous.
     */
    transactionSync<T>(callback: () => T): T;
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
  protected _currentRpcCallerId: string | null = null;
  protected _currentRpcCallerKind: string | null = null;
  private _credentials: CredentialClient | null = null;
  private _notifications: NotificationClient | null = null;
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

  /** Subclasses may migrate persisted SQL state between schema versions. */
  protected migrate(_fromVersion: number, _toVersion: number): void {}

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
      if (row.length > 0) currentVersion = parseInt(row[0]!["value"] as string, 10) || 0;
    } catch { /* table might not have the row yet */ }

    const targetVersion = (this.constructor as typeof DurableObjectBase).schemaVersion;
    if (currentVersion < targetVersion) {
      this.createTables();
      this.migrate(currentVersion, targetVersion);
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

  /** Parse a POST body into positional method arguments. */
  protected parseRequestBody(body: string): { args: unknown[]; error?: string } {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return { args: parsed };
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      ("__instanceToken" in parsed || "__instanceId" in parsed) &&
      Array.isArray((parsed as { args?: unknown }).args)
    ) {
      return { args: (parsed as { args: unknown[] }).args };
    }
    return { args: [parsed] };
  }

  // --- RPC bridge + shared clients (lazy) ---

  /** RPC bridge for calling services and other workers/DOs */
  protected get rpc(): RpcBridge & { handleIncomingPost(body: unknown): Promise<unknown> } {
    if (!this._rpc) {
      const token = this.env["RPC_AUTH_TOKEN"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("RPC not available: RPC_AUTH_TOKEN not configured");
      }
      const source = this.env["WORKER_SOURCE"];
      const className = this.env["WORKER_CLASS_NAME"];
      if (typeof source !== "string" || source.length === 0) {
        throw new Error("RPC not available: WORKER_SOURCE not configured");
      }
      if (typeof className !== "string" || className.length === 0) {
        throw new Error("RPC not available: WORKER_CLASS_NAME not configured");
      }
      if (!token) {
        throw new Error("RPC not available: RPC_AUTH_TOKEN not configured");
      }
      const serverUrl = this.env["GATEWAY_URL"] as string;
      if (!serverUrl) {
        throw new Error("RPC not available: GATEWAY_URL not configured");
      }
      this._rpc = createHttpRpcBridge({
        selfId: `do:${source}:${className}:${this.objectKey}`,
        serverUrl,
        authToken: token,
      });
      // Bridge DO `console.*` to the server terminal. Installed lazily on
      // first rpc access — constructor-time logs are still local-only, but
      // steady-state errors reach the main terminal.
      installConsoleBridge(this._rpc);
    }
    return this._rpc;
  }

  /** OAuth client for token access */
  protected get credentials(): CredentialClient {
    if (!this._credentials) this._credentials = createCredentialClient(this.rpc);
    return this._credentials;
  }

  /** Notification client for shell notifications */
  protected get notifications(): NotificationClient {
    if (!this._notifications) this._notifications = createNotificationClient(this.rpc);
    return this._notifications;
  }

  /** Filesystem client */
  protected get fs(): RuntimeFs {
    if (!this._fs) this._fs = _initFsWithRpc(this.rpc);
    return this._fs;
  }

  protected get rpcCallerId(): string | null {
    return this._currentRpcCallerId;
  }

  protected get rpcCallerKind(): string | null {
    return this._currentRpcCallerKind;
  }

  /** Get a handle to the parent (first dispatcher) */
  protected getParent() {
    return createParentHandle({ rpc: this.rpc, parentId: null });
  }

  /** Last value pushed via `setOwnTitle` during this activation. Used to
   *  dedupe redundant `runtime.setTitle` RPCs. Persists only across method
   *  calls within one isolate; on hibernation it resets. */
  private _titleSetForThisActivation: string | null = null;

  /** Persistent state key used to record explicit (tool-driven) title sets.
   *  When this key is "1" the heuristic first-message fallback in chat agents
   *  is suppressed so explicit titles survive hibernation/restart. */
  private static readonly EXPLICIT_TITLE_STATE_KEY = "__title_explicit";

  protected get titleSetForThisActivation(): string | null {
    return this._titleSetForThisActivation;
  }

  /**
   * Returns true iff a previous activation called `setOwnTitleExplicitly`.
   * Heuristic title setters (e.g. chat agents' first-user-message fallback)
   * should bail when this is true so a user-confirmed title isn't overwritten.
   */
  protected isOwnTitleExplicitlySet(): boolean {
    try {
      return this.getStateValue(DurableObjectBase.EXPLICIT_TITLE_STATE_KEY) === "1";
    } catch {
      // `state` table may not exist before the first ensureReady — read
      // returning false is the safe default (no explicit title yet).
      return false;
    }
  }

  /**
   * Set the title and durably record that an explicit setter (e.g. the
   * built-in `set_title` agent tool) chose it. Subsequent activations check
   * `isOwnTitleExplicitlySet` before running any heuristic fallback.
   */
  protected async setOwnTitleExplicitly(title: string | null | undefined): Promise<void> {
    await this.setOwnTitle(title);
    try {
      this.ensureReady();
      this.setStateValue(DurableObjectBase.EXPLICIT_TITLE_STATE_KEY, "1");
    } catch (err) {
      console.warn("[DurableObjectBase] failed to persist explicit-title flag:", err);
    }
  }

  /**
   * Set the server-controlled display title for this entity. Approval UIs
   * (and any other surface that resolves an entity by id) show this in
   * place of the opaque id. Best-effort — failures log a warning and do
   * not throw. Pass null/empty to clear.
   *
   * This is the heuristic / non-persisting setter — use
   * `setOwnTitleExplicitly` when an explicit tool call drives the change.
   */
  protected async setOwnTitle(title: string | null | undefined): Promise<void> {
    const normalized = title == null ? null : title.trim();
    const effective = normalized && normalized.length > 0 ? normalized : null;
    if (effective === this._titleSetForThisActivation) return;
    let bridge: RpcBridge;
    try {
      bridge = this.rpc;
    } catch (err) {
      // `this.rpc` throws when the workerd env bindings aren't ready yet —
      // typical during constructor-time calls before the first request has
      // attached the RPC token. Skip silently; setOwnTitle will be retried
      // on the next caller (request, alarm, RPC handler).
      void err;
      return;
    }
    // Set the flag eagerly so concurrent callers (e.g. constructor-issued
    // setOwnTitle + the first-message fallback) see this title as already
    // claimed and don't race to overwrite it.
    this._titleSetForThisActivation = effective;
    // Test harnesses point GATEWAY_URL at an unreachable sentinel; emit no
    // noise when the RPC fails in that mode. Real installs surface failures.
    const gatewayUrl = String(this.env["GATEWAY_URL"] ?? "");
    const isTestSentinel =
      gatewayUrl.includes("test-server.invalid") || gatewayUrl.includes(".test/");
    try {
      await bridge.call("main", "runtime.setTitle", [effective]);
    } catch (err) {
      if (!isTestSentinel) {
        console.warn("[DurableObjectBase] runtime.setTitle failed:", err);
      }
    }
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
    // Parse /{objectKey}/{method} — router includes objectKey in forwarded URL
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this._objectKey) {
      this._objectKey = decodeURIComponent(segments[0]!);
      // Persist for hibernation recovery
      try { this.sql.exec(`INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`, this._objectKey); }
      catch { /* state table may not exist yet — ensureReady hasn't run */ }
    }

    this.ensureReady();

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

      const previousCallerId = this._currentRpcCallerId;
      const previousCallerKind = this._currentRpcCallerKind;
      this._currentRpcCallerId = request.headers.get("X-Natstack-Rpc-Caller-Id");
      this._currentRpcCallerKind = request.headers.get("X-Natstack-Rpc-Caller-Kind");
      try {
        const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
        return new Response(JSON.stringify(result ?? null), {
          headers: { "Content-Type": "application/json" },
        });
      } finally {
        this._currentRpcCallerId = previousCallerId;
        this._currentRpcCallerKind = previousCallerKind;
      }
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

  protected resetRpcClients(): void {
    this._rpc = null;
    this._credentials = null;
    this._notifications = null;
    this._fs = null;
  }

  // --- Introspection ---

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state };
  }
}
