/**
 * DurableObjectBase — Tiny generic foundation for all Durable Objects.
 *
 * Only what every DO needs: context, SQL, schema versioning, state KV,
 * alarm support, HTTP dispatch, WebSocket upgrade stub, and hibernation hooks.
 *
 * Agent-specific concerns (harnesses, turns, subscriptions, streams) live
 * in @workspace/agentic-do — composable modules that extend this base.
 */

import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@natstack/shared/typedServiceClient";
import { runtimeMethods } from "@natstack/shared/serviceSchemas/runtime";
import { workerLogMethods } from "@natstack/shared/serviceSchemas/workerLog";
import { workspaceStateMethods } from "@natstack/shared/serviceSchemas/workspaceState";
import {
  collectExposableMethods,
  createConnectionlessRpcClient,
  envelopeFromMessage,
  rpcExposedMethodNames,
  rpcMethodPolicy,
  type ConnectionlessRpcClient,
  type DeferrableRpcClient,
  type RpcEnvelope,
  type RpcRequest,
} from "@natstack/rpc";
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { _initFsWithRpc } from "./fs.js";
import { createNonPanelRuntimeHandle } from "../shared/handles.js";
import {
  createPanelRuntime,
  type OpenPanelOptions,
  type PanelRuntimeApi,
  type PanelRuntimeTree,
} from "../shared/panelRuntime.js";
import type { AuthenticatedCaller, RpcClient } from "@natstack/rpc";
import type { RuntimeFs } from "../types.js";
import type { PanelHandle } from "../core/index.js";

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

function installConsoleBridge(rpc: Pick<RpcClient, "call">): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;
  const workerLogService = createTypedServiceClient("workerLog", workerLogMethods, (svc, m, a) =>
    rpc.call("main", `${svc}.${m}`, a)
  );
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
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
    } catch {
      message = "<unserializable>";
    }
    try {
      // Normal path: forward ONLY via workerLog (the contextful `[do:<id>]` line). Do NOT
      // also print to the local console, or every DO line double-prints in the server
      // terminal (once as `[workerd]` from stdout, once as `[workerLog]`). If the forward
      // fails (workerLog unreachable — early boot, server down), fall back to the original
      // console so the line is never lost. `original.*` is bound pre-override ⇒ no recursion.
      workerLogService.write(level, message).catch(() => {
        original[level](...args);
      });
    } finally {
      forwarding = false;
    }
  };
  console.log = (...args: unknown[]) => forward("log", args);
  console.info = (...args: unknown[]) => forward("info", args);
  console.warn = (...args: unknown[]) => forward("warn", args);
  console.error = (...args: unknown[]) => forward("error", args);
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
  // Keep background work alive after an RPC/fetch handler returns.
  waitUntil?(promise: Promise<unknown>): void;
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

export interface LifecyclePrepareInput {
  epoch: string;
  reason: string;
  deadlineMs: number;
}

export interface LifecyclePrepareResult {
  status: "ready" | "failed";
  detail?: string;
}

export interface LifecycleResumeInput {
  epoch: string;
  previousGeneration: number | null;
  currentGeneration: number;
  reason: "planned" | "crash" | "server_restart";
}

// (RPC exposure is now opt-in via `@rpc` + `rpcExposedMethodNames` — no reserved deny-list needed;
// framework/lifecycle methods are simply never `@rpc`-marked, and the base-proto boundary backstops.)

export abstract class DurableObjectBase {
  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected env: Record<string, unknown>;

  private _schemaReady = false;
  private _connectionless: ConnectionlessRpcClient | null = null;
  protected _currentRpcCallerId: string | null = null;
  protected _currentRpcCallerKind: string | null = null;
  protected _currentRpcCallerPanelId: string | null = null;
  protected _currentRpcRequestId: string | null = null;
  protected _currentRpcIdempotencyKey: string | null = null;
  private _currentVerifiedCaller: AuthenticatedCaller | null = null;
  private _panelRuntime: PanelRuntimeApi | null = null;
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

  /** Tables that must exist before a schema version is recorded as ready. */
  protected requiredTables(): readonly string[] {
    return [];
  }

  protected validateSchema(): void {
    const missing = this.requiredTables().filter((table) => {
      const rows = this.sql
        .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table)
        .toArray();
      return rows.length === 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `${this.constructor.name} schema validation failed: missing table(s): ${missing.join(", ")}`
      );
    }
  }

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
    } catch {
      /* table might not have the row yet */
    }

    const targetVersion = (this.constructor as typeof DurableObjectBase).schemaVersion;
    if (currentVersion > targetVersion) {
      throw new Error(
        `${this.constructor.name} schema version ${currentVersion} is newer than supported version ${targetVersion}`
      );
    }

    if (currentVersion === 0) {
      this.createTables();
      this.validateSchema();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    } else if (currentVersion < targetVersion) {
      this.migrate(currentVersion, targetVersion);
      this.createTables();
      this.validateSchema();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    } else {
      this.createTables();
      this.validateSchema();
    }
  }

  // --- State KV (generic, always available) ---

  protected getStateValue(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    return row.length > 0 ? (row[0]!["value"] as string) : null;
  }

  protected setStateValue(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`, key, value);
  }

  protected deleteStateValue(key: string): void {
    this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
  }

  // --- Deferred (out-of-band) calls: REMOVED (unified-log Stage B) ---
  //
  // The generic deferred-RPC layer (`deferred_requests` + redrive) existed for
  // agent suspensions; the event-sourced harness journals intentions in the
  // trajectory log and re-derives dispatch from the fold, so the table and its
  // machinery are gone. Server-side deferral (capability approvals) still uses
  // the rpc bridge's deferral registry — that path never touched this DO table.

  /** Parse a POST body into positional method arguments. */
  protected parseRequestBody(body: string): {
    args: unknown[];
    error?: string;
    caller?: AuthenticatedCaller | null;
  } {
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
      const caller = (parsed as { __caller?: unknown }).__caller;
      if (caller && typeof caller === "object") {
        const record = caller as Record<string, unknown>;
        if (typeof record["callerId"] === "string" && typeof record["callerKind"] === "string") {
          return {
            args: (parsed as { args: unknown[] }).args,
            caller: {
              callerId: record["callerId"],
              callerKind: record["callerKind"] as AuthenticatedCaller["callerKind"],
              ...(typeof record["callerPanelId"] === "string"
                ? { callerPanelId: record["callerPanelId"] }
                : {}),
            } as AuthenticatedCaller,
          };
        }
      }
      return { args: (parsed as { args: unknown[] }).args };
    }
    return { args: [parsed] };
  }

  // --- RPC bridge + shared clients (lazy) ---

  /**
   * RPC bridge — the unified connectionless `createRpcClient` core (envelope
   * transport + `callDeferred`). The DO's public methods are `exposeAll`'d onto
   * it so inbound request envelopes dispatch to the class method via the shared
   * `handleEnvelope`; `respond`/`deliver` are wired in `fetch`.
   */
  protected get rpc(): DeferrableRpcClient {
    return this.connectionlessClient().client;
  }

  private connectionlessClient(): ConnectionlessRpcClient {
    if (!this._connectionless) {
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
      const serverUrl = this.env["GATEWAY_URL"] as string;
      if (!serverUrl) {
        throw new Error("RPC not available: GATEWAY_URL not configured");
      }
      const connectionless = createConnectionlessRpcClient({
        selfId: `do:${source}:${className}:${this.objectKey}`,
        serverUrl,
        authToken: token,
        callerKind: "do",
      });
      // Expose ONLY this DO's `@rpc`-marked methods (opt-in / default-deny). Private/protected helpers
      // and all framework plumbing (`dispatchInboundEnvelope`, state KV, panel/alarm helpers) are
      // unreachable over the open relay; a forgotten `@rpc` fails loud ("not exposed"). The
      // base-prototype boundary remains as a backstop.
      connectionless.client.exposeAll(
        collectExposableMethods(this, rpcExposedMethodNames(this), DurableObjectBase.prototype)
      );
      this._connectionless = connectionless;
      // Bridge DO `console.*` to the server terminal. Installed lazily on
      // first rpc access — constructor-time logs are still local-only, but
      // steady-state errors reach the main terminal.
      installConsoleBridge(connectionless.client);
    }
    return this._connectionless;
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

  /**
   * The authenticated caller of the in-flight method, in the canonical
   * `AuthenticatedCaller` shape shared with the bridge and server. Sourced from
   * the signed `X-Natstack-Rpc-Caller-*` headers the server injects. Null when
   * there is no active RPC caller (e.g. alarm/lifecycle). Prefer this over the
   * raw `rpcCallerId`/`rpcCallerKind` pair for authorization checks.
   */
  protected get caller(): AuthenticatedCaller | null {
    if (this._currentVerifiedCaller) return this._currentVerifiedCaller;
    const callerId = this._currentRpcCallerId;
    if (!callerId) return null;
    return {
      callerId,
      callerKind: (this._currentRpcCallerKind as AuthenticatedCaller["callerKind"]) ?? "unknown",
      ...(this._currentRpcCallerPanelId ? { callerPanelId: this._currentRpcCallerPanelId } : {}),
    };
  }

  protected get rpcCallerPanelId(): string | null {
    return this._currentRpcCallerPanelId;
  }

  /** Get a handle to the parent (first dispatcher) */
  protected getParent(): PanelHandle | null {
    const callerId = this.rpcCallerId;
    if (!callerId) return null;
    if (this.rpcCallerKind === "panel") {
      const panelId = this.rpcCallerPanelId ?? callerId;
      return this.panelRuntime.fromMetadata({
        id: panelId,
        title: panelId,
        source: panelId,
        kind: "workspace",
        parentId: null,
        rpcTargetId: callerId,
      });
    }
    if (this.rpcCallerKind === "worker" || this.rpcCallerKind === "do") {
      return createNonPanelRuntimeHandle({ id: callerId });
    }
    return null;
  }

  /** Correlation id of the inbound call, when the caller stamped one. */
  protected get rpcRequestId(): string | null {
    return this._currentRpcRequestId;
  }

  /** Dedup key of the inbound call, when the caller stamped one. */
  protected get rpcIdempotencyKey(): string | null {
    return this._currentRpcIdempotencyKey;
  }

  private get panelRuntime(): PanelRuntimeApi {
    if (!this._panelRuntime) {
      this._panelRuntime = createPanelRuntime({
        rpc: this.rpc,
        selfHandle: () =>
          createNonPanelRuntimeHandle({
            id: String(this.env["DO_ID"] ?? this.ctx.id.toString()),
          }),
        defaultOpenParentId: null,
        requesterPanelId: () =>
          this._currentRpcCallerKind === "panel"
            ? (this._currentRpcCallerPanelId ?? this._currentRpcCallerId)
            : null,
      });
    }
    return this._panelRuntime;
  }

  /** Open a workspace or browser panel. */
  protected openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle> {
    return this.panelRuntime.openPanel(source, options);
  }

  /** List all visible panels. */
  protected listPanels(): Promise<PanelHandle[]> {
    return this.panelRuntime.listPanels();
  }

  /** Get a handle for a known panel slot id. */
  protected getPanelHandle(id: string, kind?: "workspace" | "browser"): PanelHandle {
    return this.panelRuntime.getPanelHandle(id, kind);
  }

  /** Panel tree API for Durable Objects. */
  protected get panelTree(): PanelRuntimeTree {
    return this.panelRuntime.panelTree;
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
    await this.setOwnTitle(title, { explicit: true });
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
  protected async setOwnTitle(
    title: string | null | undefined,
    options: { explicit?: boolean } = {}
  ): Promise<void> {
    const normalized = title == null ? null : title.trim();
    const effective = normalized && normalized.length > 0 ? normalized : null;
    if (effective === this._titleSetForThisActivation) return;
    let bridge: Pick<RpcClient, "call">;
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
    const runtimeService = createTypedServiceClient("runtime", runtimeMethods, (svc, m, a) =>
      bridge.call("main", `${svc}.${m}`, a)
    );
    try {
      await runtimeService.setTitle(effective, { explicit: options.explicit === true });
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
    if (name) {
      this._objectKey = name;
      return name;
    }
    // Fallback to persisted state (survives hibernation)
    try {
      const stored = this.sql.exec(`SELECT value FROM state WHERE key = '__objectKey'`).toArray();
      if (stored.length > 0) {
        this._objectKey = stored[0]!["value"] as string;
        return this._objectKey;
      }
    } catch {
      /* state table may not exist yet */
    }
    throw new Error("objectKey not available — no request received yet and ctx.id.name not set");
  }

  // --- Alarm (server-driven; persists across workerd/server restarts) ---
  //
  // workerd does not implement alarms for SQLite-backed Durable Objects (and
  // never for facets), so the wake time is registered durably with the server
  // (WorkspaceDO `do_alarms`) and the server's AlarmDriver fires `__alarm` on
  // schedule. These are fire-and-forget relay calls (matching the old sync
  // `ctx.storage.setAlarm` signature); persistent failure is logged.

  protected setAlarm(delayMs: number): void {
    this.setAlarmAt(Date.now() + delayMs);
  }

  /** Schedule the alarm at an absolute epoch-ms time. */
  protected setAlarmAt(timeMs: number): void {
    void this.alarmRpc("workspace-state.alarmSet", () =>
      this.workspaceStateService.alarmSet({ ...this.lifecycleKey(), wakeAt: timeMs })
    );
  }

  /** Cancel any pending alarm for this DO. */
  protected deleteAlarm(): void {
    void this.alarmRpc("workspace-state.alarmClear", () =>
      this.workspaceStateService.alarmClear(this.lifecycleKey())
    );
  }

  private lifecycleKey(): { source: string; className: string; objectKey: string } {
    return {
      source: String(this.env["WORKER_SOURCE"] ?? ""),
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      objectKey: this.objectKey,
    };
  }

  /**
   * Typed client for the workspace-state service. Built lazily — the call
   * function dereferences `this.rpc` per call, so constructing the client
   * never touches the (possibly not-yet-ready) RPC bridge.
   */
  private _workspaceStateService?: TypedServiceClient<typeof workspaceStateMethods>;

  private get workspaceStateService(): TypedServiceClient<typeof workspaceStateMethods> {
    return (this._workspaceStateService ??= createTypedServiceClient(
      "workspace-state",
      workspaceStateMethods,
      (svc, m, a) => this.rpc.call("main", `${svc}.${m}`, a)
    ));
  }

  private async alarmRpc(label: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (err) {
      console.warn(`[durable] ${label} failed:`, err instanceof Error ? err.message : err);
    }
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
      try {
        this.sql.exec(
          `INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`,
          this._objectKey
        );
      } catch {
        /* state table may not exist yet — ensureReady hasn't run */
      }
    }

    this.ensureReady();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    // Converged inbound dispatch: an `RpcEnvelope` POSTed to `__rpc` (relay
    // traffic, server→DO event push, deferred replies) flows through the shared
    // core's `handleEnvelope` → `exposeAll`'d method / event listeners.
    if (method === "__rpc") {
      return this.handleInboundEnvelope(request);
    }

    try {
      let args: unknown[] = [];
      let verifiedCallerFromBody: AuthenticatedCaller | null = null;
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
          verifiedCallerFromBody = result.caller ?? null;
        }
      }

      if (method === "__lifecycle/prepare" || method === "__lifecycle/resume") {
        const previousVerifiedCaller = this._currentVerifiedCaller;
        this._currentVerifiedCaller = verifiedCallerFromBody;
        try {
          if (this.caller?.callerKind !== "server") {
            return new Response(
              JSON.stringify({ error: "Lifecycle calls require server caller" }),
              {
                status: 403,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          const result =
            method === "__lifecycle/prepare"
              ? await this.prepareForRestart(args[0] as LifecyclePrepareInput)
              : await this.resumeAfterRestart(args[0] as LifecycleResumeInput);
          return new Response(JSON.stringify(result ?? null), {
            headers: { "Content-Type": "application/json" },
          });
        } finally {
          this._currentVerifiedCaller = previousVerifiedCaller;
        }
      }

      // Alarm endpoint — server-driven (workerd lacks SQLite/facet alarms).
      // The AlarmDriver fires this on schedule; gate to the server caller.
      if (method === "__alarm") {
        const previousVerifiedCaller = this._currentVerifiedCaller;
        this._currentVerifiedCaller = verifiedCallerFromBody;
        try {
          if (this.caller?.callerKind !== "server") {
            return new Response(JSON.stringify({ error: "Alarm calls require server caller" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }
          await this.alarm();
          return new Response(JSON.stringify({ result: "ok" }), {
            headers: { "Content-Type": "application/json" },
          });
        } finally {
          this._currentVerifiedCaller = previousVerifiedCaller;
        }
      }

      // Method-path dispatch (the server's instance-token channel,
      // `DODispatch.dispatch`): build an inbound request envelope from
      // {method, args, __caller} and route it through the SAME converged core
      // dispatch as `__rpc`. `(this)[method]` is gone — `exposeAll` is the single
      // dispatch. Returns the raw method result (the DODispatch contract).
      const caller: AuthenticatedCaller =
        verifiedCallerFromBody ?? { callerId: "", callerKind: "unknown" };
      const envelope = envelopeFromMessage({
        selfId: `do:${this.env["WORKER_SOURCE"]}:${this.env["WORKER_CLASS_NAME"]}:${this.objectKey}`,
        from: caller.callerId || "unknown",
        target: `do:${this.env["WORKER_SOURCE"]}:${this.env["WORKER_CLASS_NAME"]}:${this.objectKey}`,
        caller,
        message: {
          type: "request",
          requestId: crypto.randomUUID(),
          fromId: caller.callerId || "unknown",
          method,
          args,
        },
      });
      const responseEnvelope = await this.dispatchInboundEnvelope(envelope);
      const responseMessage = responseEnvelope?.message;
      if (responseMessage?.type === "response" && "error" in responseMessage) {
        if (responseMessage.error.startsWith('Method "')) {
          return new Response(JSON.stringify({ error: `Unknown method: ${method}` }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: responseMessage.error }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      const result =
        responseMessage?.type === "response" && "result" in responseMessage
          ? (responseMessage.result ?? null)
          : null;
      return new Response(JSON.stringify(result), {
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

  /** Handle an `RpcEnvelope` POSTed to `__rpc`; returns a response envelope (or `{}` for events). */
  private async handleInboundEnvelope(request: Request): Promise<Response> {
    const envelope = (await request.json()) as RpcEnvelope;
    const message = envelope.message;
    if (message?.type !== "request" && message?.type !== "stream-request") {
      this.connectionlessClient().deliver(envelope);
      return new Response(JSON.stringify({}), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const responseEnvelope = await this.dispatchInboundEnvelope(envelope);
    return new Response(JSON.stringify(responseEnvelope ?? {}), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Default-deny inbound caller gate (workspace realm, Layer A). Every relay-reachable `@rpc`
   * method must declare an `@rpc({ callers })` policy admitting the caller's kind; a method with no
   * policy, or a caller (including an unattributed/null caller) whose kind is not listed, is refused.
   * Identity-level tightening ("this agent's own EvalDO", a specific PubSubChannel/agent DO) stays as
   * an inline check inside the method — this is the coarse kind floor beneath it. Returns an error
   * string to refuse, or null to allow. Events (owner-scoped pushes) are delivered via `deliver`, not
   * through here, so they are unaffected.
   */
  protected inboundCallerDenial(
    method: string | undefined,
    caller: AuthenticatedCaller | null
  ): string | null {
    if (!method) return null;
    const policy = rpcMethodPolicy(this, method);
    const kind = caller?.callerKind;
    if (policy && kind && (policy.callers as readonly string[]).includes(kind)) return null;
    return policy
      ? `${method}: caller kind "${kind ?? "unattributed"}" is not permitted (allowed: ${policy.callers.join(", ")})`
      : `${method}: refused — no @rpc({ callers }) policy declared (workspace DOs are default-deny over the relay)`;
  }

  /**
   * Dispatch an inbound request envelope through the converged core
   * (`respond` → `handleEnvelope` → `exposeAll`'d method), with the DO's
   * caller-context getters bound to `envelope.delivery.caller` for the duration.
   */
  private async dispatchInboundEnvelope(envelope: RpcEnvelope): Promise<RpcEnvelope | null> {
    const connectionless = this.connectionlessClient();
    // An unattributed method-path call carries a synthetic empty caller; surface
    // it as a null caller context (matching the pre-convergence behavior) rather
    // than a forgeable `"unknown"` — methods that gate on `this.caller` rely on it.
    const rawCaller = envelope.delivery.caller;
    const caller = rawCaller && rawCaller.callerId !== "" ? rawCaller : null;
    const message = envelope.message as RpcRequest;
    const prev = {
      verifiedCaller: this._currentVerifiedCaller,
      callerId: this._currentRpcCallerId,
      callerKind: this._currentRpcCallerKind,
      callerPanelId: this._currentRpcCallerPanelId,
      requestId: this._currentRpcRequestId,
      idempotencyKey: this._currentRpcIdempotencyKey,
    };
    this._currentVerifiedCaller = caller;
    this._currentRpcCallerId = caller?.callerId ?? null;
    this._currentRpcCallerKind = caller?.callerKind ?? null;
    this._currentRpcCallerPanelId = caller?.callerPanelId ?? null;
    this._currentRpcRequestId = message?.requestId ?? null;
    this._currentRpcIdempotencyKey = envelope.delivery.idempotencyKey ?? null;
    try {
      const denial = this.inboundCallerDenial(message?.method, caller);
      if (denial) {
        return {
          from: envelope.target,
          target: envelope.from,
          delivery: { caller: caller ?? { callerId: "", callerKind: "unknown" } },
          provenance: envelope.provenance ?? [],
          message: { type: "response", requestId: message?.requestId ?? "", error: denial },
        } as RpcEnvelope;
      }
      return await connectionless.respond(envelope);
    } finally {
      this._currentVerifiedCaller = prev.verifiedCaller;
      this._currentRpcCallerId = prev.callerId;
      this._currentRpcCallerKind = prev.callerKind;
      this._currentRpcCallerPanelId = prev.callerPanelId;
      this._currentRpcRequestId = prev.requestId;
      this._currentRpcIdempotencyKey = prev.idempotencyKey;
    }
  }

  /** Override in subclasses to accept WebSocket connections. */
  protected handleWebSocketUpgrade(_request: Request): Response {
    return new Response("WebSocket not supported", { status: 426 });
  }

  async prepareForRestart(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    return { status: "ready" };
  }

  async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {
    // No generic continuation store: event-sourced subclasses re-derive their
    // pending work from their logs on wake.
  }

  protected async markCheckpointableWorkActive(detail?: unknown): Promise<void> {
    // The lease must be registered before the turn does real work — a turn that
    // proceeds unleased won't get prepare/resume on a restart (unrecoverable).
    // The upsert is a relay RPC that can transiently fail under load, so retry a
    // few times; the caller surfaces persistent failure rather than swallowing.
    const payload = { ...this.lifecycleKey(), detail };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.workspaceStateService.lifecycleLeaseUpsert(payload);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  protected async markCheckpointableWorkInactive(): Promise<void> {
    await this.workspaceStateService.lifecycleLeaseClear(this.lifecycleKey());
  }

  // --- Hibernation hooks ---
  // On a resumed hibernated DO, workerd can invoke these on a fresh instance
  // WITHOUT going through fetch(), so schema must be ready here too.
  // Subclasses that override these MUST call super.webSocketMessage() etc.

  async webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void> {
    this.ensureReady();
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    this.ensureReady();
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    this.ensureReady();
  }

  // --- Clone support ---

  protected resetRpcClients(): void {
    this._connectionless = null;
    this._panelRuntime = null;
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
