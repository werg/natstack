/**
 * DurableObjectBase — Tiny generic foundation for all Durable Objects.
 *
 * Only what every DO needs: context, SQL, schema versioning, state KV,
 * alarm support, HTTP dispatch, WebSocket upgrade stub, and hibernation hooks.
 *
 * Agent-specific concerns (harnesses, turns, subscriptions, streams) live
 * in @workspace/agentic-do — composable modules that extend this base.
 */

import { createHttpRpcClient, type HttpRpcClient } from "../shared/httpRpcBridge.js";
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { _initFsWithRpc } from "./fs.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "../shared/handles.js";
import { createCdpAutomation } from "../panel/cdpAutomation.js";
import type { AuthenticatedCaller, RpcClient } from "@natstack/rpc";
import type { PanelLifecycleResult } from "@natstack/shared/types";
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
      // Fire-and-forget. Failures go to the *original* console to avoid
      // infinite recursion if the RPC path itself is broken.
      rpc.call("main", "workerLog.write", [level, message]).catch((err) => {
        original.warn("[console-bridge] forward failed:", err);
      });
    } finally {
      forwarding = false;
    }
  };
  console.log = (...args: unknown[]) => {
    original.log(...args);
    forward("log", args);
  };
  console.info = (...args: unknown[]) => {
    original.info(...args);
    forward("info", args);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    forward("warn", args);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    forward("error", args);
  };
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

/** Outcome of {@link DurableObjectBase.callDeferred}. */
export type DeferredCallOutcome =
  | { status: "completed"; requestId: string; result: unknown }
  | { status: "deferred"; requestId: string };

type DurablePanelListItem = {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
  children?: DurablePanelListItem[];
};

type DurablePanelMetadataResult = {
  id?: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  runtimeEntityId?: string | null;
  contextId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
};

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

export abstract class DurableObjectBase {
  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected env: Record<string, unknown>;

  private _schemaReady = false;
  private _rpc: HttpRpcClient | null = null;
  private _deferredSchemaReady = false;
  protected _currentRpcCallerId: string | null = null;
  protected _currentRpcCallerKind: string | null = null;
  protected _currentRpcCallerPanelId: string | null = null;
  protected _currentRpcRequestId: string | null = null;
  protected _currentRpcIdempotencyKey: string | null = null;
  private _currentVerifiedCaller: AuthenticatedCaller | null = null;
  private _panelMetadataCache = new Map<string, PanelHandleMetadata>();
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

  // --- Deferred (out-of-band) calls ---
  //
  // A generic, transport-correlated continuation primitive: issue a server call
  // that may complete out-of-band, persist a durable row keyed by requestId
  // *before* issuing, and resume idempotently when the result is delivered via
  // an inbound onDeferredResult POST (which revives a hibernated DO). The table
  // is created lazily on first use, so DOs that never defer pay nothing.
  //
  // Subclasses with a richer continuation store (e.g. agent turn suspensions)
  // do NOT use this; they own their own table. This is for plain DOs.

  /** Lazily create the deferred_requests table (only when first deferring). */
  private ensureDeferredSchema(): void {
    if (this._deferredSchemaReady) return;
    this.ensureReady();
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS deferred_requests (
         request_id TEXT PRIMARY KEY,
         idempotency_key TEXT,
         target TEXT NOT NULL,
         method TEXT NOT NULL,
         args_json TEXT NOT NULL,
         context_json TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         result_json TEXT,
         is_error INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    );
    this._deferredSchemaReady = true;
  }

  /** True if the deferred table exists, without creating it. */
  private deferredTableExists(): boolean {
    if (this._deferredSchemaReady) return true;
    const rows = this.sql
      .exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='deferred_requests'`)
      .toArray();
    return rows.length > 0;
  }

  /**
   * Issue a server call that may complete out-of-band. Persists the call
   * durably (keyed by requestId) before issuing, so a later onDeferredResult —
   * or a restart re-drive — can resume it. If the server resolves inline
   * (fast path), the result is applied immediately and returned.
   *
   * `context` is opaque JSON handed back to `onDeferredResolved`, so the DO can
   * reconstitute what to do with the result after a hibernation.
   */
  protected async callDeferred(
    target: string,
    method: string,
    args: unknown[],
    options?: { idempotencyKey?: string; context?: unknown }
  ): Promise<DeferredCallOutcome> {
    this.ensureDeferredSchema();
    const requestId = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO deferred_requests
         (request_id, idempotency_key, target, method, args_json, context_json,
          status, is_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      requestId,
      options?.idempotencyKey ?? null,
      target,
      method,
      JSON.stringify(args),
      options?.context !== undefined ? JSON.stringify(options.context) : null,
      now,
      now
    );
    const ack = await this.rpc.callDeferred(target, method, args, {
      requestId,
      ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    });
    if (ack.status === "completed") {
      await this.applyDeferredResult(requestId, ack.result, false);
      return { status: "completed", requestId, result: ack.result };
    }
    return { status: "deferred", requestId };
  }

  /**
   * Inbound delivery of a settled deferred call. Server-only; reached via the
   * direct method dispatch path (caller headers present) so the gate sees
   * `callerKind === "server"`. Idempotent: duplicate / unknown / already-settled
   * deliveries are no-ops.
   */
  async onDeferredResult(payload: {
    requestId: string;
    result: unknown;
    isError: boolean;
  }): Promise<{ ok: boolean }> {
    if (this.caller?.callerKind !== "server") {
      throw new Error("onDeferredResult requires a server caller");
    }
    if (!payload || typeof payload.requestId !== "string") {
      throw new Error("onDeferredResult requires a requestId");
    }
    if (!this.deferredTableExists()) return { ok: true };
    await this.applyDeferredResult(payload.requestId, payload.result, Boolean(payload.isError));
    return { ok: true };
  }

  /**
   * Atomic check-and-set: mark a pending deferred row terminal and dispatch the
   * subclass hook exactly once. The SELECT→UPDATE runs synchronously (no await
   * between), so concurrent deliveries cannot double-fire the hook.
   */
  private async applyDeferredResult(
    requestId: string,
    result: unknown,
    isError: boolean
  ): Promise<void> {
    const rows = this.sql
      .exec(`SELECT status, context_json FROM deferred_requests WHERE request_id = ?`, requestId)
      .toArray();
    if (rows.length === 0) return; // unknown / superseded
    if ((rows[0]!["status"] as string) !== "pending") return; // already terminal
    const contextJson = rows[0]!["context_json"] as string | null;
    this.sql.exec(
      `UPDATE deferred_requests SET status = ?, result_json = ?, is_error = ?, updated_at = ?
       WHERE request_id = ?`,
      isError ? "failed" : "completed",
      JSON.stringify(result ?? null),
      isError ? 1 : 0,
      Date.now(),
      requestId
    );
    const context = contextJson != null ? JSON.parse(contextJson) : undefined;
    try {
      await this.onDeferredResolved(requestId, result, isError, context);
    } catch (err) {
      console.warn(`[DurableObjectBase] onDeferredResolved threw for ${requestId}:`, err);
    }
  }

  /**
   * Re-drive still-pending deferred calls (backstop for a dropped push). Safe to
   * call on any reactivation; reissues with the original requestId so the server
   * dedups against in-flight/just-completed work and grant-backed resolutions
   * return inline without a re-prompt. No-op if nothing was ever deferred.
   */
  protected async redriveDeferredRequests(): Promise<void> {
    if (!this.deferredTableExists()) return;
    const rows = this.sql
      .exec(
        `SELECT request_id, idempotency_key, target, method, args_json
         FROM deferred_requests WHERE status = 'pending'`
      )
      .toArray();
    for (const row of rows) {
      const requestId = row["request_id"] as string;
      const target = row["target"] as string;
      const method = row["method"] as string;
      const idempotencyKey = row["idempotency_key"] as string | null;
      let args: unknown[];
      try {
        args = JSON.parse(row["args_json"] as string) as unknown[];
      } catch {
        continue;
      }
      try {
        const ack = await this.rpc.callDeferred(target, method, args, {
          requestId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        if (ack.status === "completed") {
          await this.applyDeferredResult(requestId, ack.result, false);
        }
      } catch (err) {
        console.warn(`[DurableObjectBase] re-drive of deferred ${requestId} failed:`, err);
      }
    }
  }

  /**
   * Override to react when a deferred call settles. `context` is the opaque JSON
   * passed to `callDeferred`. Default: no-op.
   */
  protected async onDeferredResolved(
    _requestId: string,
    _result: unknown,
    _isError: boolean,
    _context: unknown
  ): Promise<void> {}

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

  /** RPC bridge for calling services and other workers/DOs */
  protected get rpc(): HttpRpcClient {
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
      this._rpc = createHttpRpcClient({
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
    };
  }

  protected get rpcCallerPanelId(): string | null {
    return this._currentRpcCallerPanelId;
  }

  /** Correlation id of the inbound call, when the caller stamped one. */
  protected get rpcRequestId(): string | null {
    return this._currentRpcRequestId;
  }

  /** Dedup key of the inbound call, when the caller stamped one. */
  protected get rpcIdempotencyKey(): string | null {
    return this._currentRpcIdempotencyKey;
  }

  /** Get a handle to the parent (first dispatcher) */
  protected getParent(): PanelHandle | null {
    const callerId = this.rpcCallerId;
    if (!callerId) return null;
    if (this.rpcCallerKind === "panel") {
      const panelId = this.rpcCallerPanelId ?? callerId;
      return this.createRuntimePanelHandle(panelId, {
        rpcTargetId: callerId,
      });
    }
    if (this.rpcCallerKind === "worker" || this.rpcCallerKind === "do") {
      return createNonPanelRuntimeHandle({ id: callerId });
    }
    return null;
  }

  private panelCall<T>(method: string, args: unknown[]): Promise<T> {
    return this.rpc.call<T>("main", `panelTree.${method}`, args);
  }

  private rememberPanelMetadata(metadata: PanelHandleMetadata): PanelHandleMetadata {
    const next = { ...(this._panelMetadataCache.get(metadata.id) ?? {}), ...metadata };
    this._panelMetadataCache.set(metadata.id, next);
    return next;
  }

  private metadataForPanelId(
    id: string,
    overrides: Partial<PanelHandleMetadata> = {}
  ): PanelHandleMetadata {
    return this.rememberPanelMetadata({
      title: id,
      source: id,
      kind: "workspace",
      parentId: null,
      ...(this._panelMetadataCache.get(id) ?? {}),
      ...overrides,
      id,
    });
  }

  private metadataFromPanelResult(
    id: string,
    meta: DurablePanelMetadataResult
  ): PanelHandleMetadata {
    return {
      id,
      title: meta.title,
      source: meta.source,
      kind: meta.kind,
      parentId: meta.parentId,
      contextId: meta.contextId ?? null,
      rpcTargetId: meta.runtimeEntityId ?? meta.id ?? id,
      effectiveVersion: meta.effectiveVersion ?? null,
      ref: meta.ref ?? null,
    };
  }

  private cdpForPanelMetadata(metadata: PanelHandleMetadata) {
    return createCdpAutomation(this.rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId:
        this._currentRpcCallerKind === "panel"
          ? (this._currentRpcCallerPanelId ?? this._currentRpcCallerId)
          : null,
    });
  }

  private panelOps(): PanelHandleHostOps {
    return {
      refresh: async (id) => {
        const meta = await this.panelCall<DurablePanelMetadataResult | null>("metadata", [id]);
        return meta
          ? this.rememberPanelMetadata(this.metadataFromPanelResult(id, meta))
          : this.metadataForPanelId(id);
      },
      children: (id) => this.panelTree.children(id),
      parent: (id, parentId) => {
        const resolvedParentId = parentId ?? this._panelMetadataCache.get(id)?.parentId ?? null;
        return resolvedParentId ? this.panelTree.get(resolvedParentId) : null;
      },
      ensureLoaded: (id) => this.panelCall("ensureLoaded", [id]),
      isLoaded: async (id) => {
        try {
          const lease = await this.panelCall<{ leased?: boolean } | null>("getRuntimeLease", [id]);
          return Boolean(lease?.leased);
        } catch {
          return false;
        }
      },
      reload: (id) => this.panelCall<PanelLifecycleResult>("reload", [id]),
      close: (id) => this.panelCall<PanelLifecycleResult>("close", [id]),
      archive: (id) => this.panelCall("archive", [id]),
      unload: (id) => this.panelCall<PanelLifecycleResult>("unload", [id]),
      movePanel: (id, newParentId, targetPosition) =>
        this.panelCall("movePanel", [{ panelId: id, newParentId, targetPosition }]),
      takeOver: (id) => this.panelCall("takeOver", [id]),
      openDevTools: (id, mode) => this.panelCall("openDevTools", [id, mode]),
      rebuildPanel: (id) => this.panelCall<PanelLifecycleResult>("rebuildPanel", [id]),
      rebuildAndReload: (id) => this.panelCall<PanelLifecycleResult>("rebuildAndReload", [id]),
      updatePanelState: (id, state) => this.panelCall("updatePanelState", [id, state]),
      focus: (id) => this.panelCall("focus", [id]),
      stateArgs: {
        get: (id) => this.panelCall("getStateArgs", [id]),
        set: (id, updates) => this.panelCall("setStateArgs", [id, updates]),
      },
      snapshot: (id) => this.panelCall("snapshot", [id]),
      callAgent: (id, method, args) => this.panelCall("callAgent", [id, method, args]),
    };
  }

  private createRuntimePanelHandle(
    id: string,
    metadata: Partial<PanelHandleMetadata> = {}
  ): PanelHandle {
    const resolvedMetadata = this.metadataForPanelId(id, metadata);
    return createPanelHandle({
      rpc: this.rpc,
      metadata: resolvedMetadata,
      cdp: this.cdpForPanelMetadata(resolvedMetadata),
      ops: this.panelOps(),
    });
  }

  private panelListItemToMetadata(item: DurablePanelListItem): PanelHandleMetadata {
    return this.rememberPanelMetadata({
      id: item.panelId,
      title: item.title,
      source: item.source,
      kind: item.kind,
      parentId: item.parentId,
      contextId: item.contextId,
      rpcTargetId: item.runtimeEntityId ?? item.panelId,
      effectiveVersion: item.effectiveVersion ?? null,
      ref: item.ref ?? null,
    });
  }

  private hydratePanelListItem(item: DurablePanelListItem): PanelHandle {
    const metadata = this.panelListItemToMetadata(item);
    return createPanelHandle({
      rpc: this.rpc,
      metadata,
      cdp: this.cdpForPanelMetadata(metadata),
      ops: this.panelOps(),
    });
  }

  /** Panel tree API for Durable Objects. */
  protected get panelTree(): {
    self(): PanelHandle;
    get(id: string): PanelHandle;
    list(): Promise<PanelHandle[]>;
    roots(): Promise<PanelHandle[]>;
    children(id: string): Promise<PanelHandle[]>;
    parent(id: string): PanelHandle | null;
    open(
      source: string,
      options?: {
        parentId?: string | null;
        name?: string;
        focus?: boolean;
        stateArgs?: Record<string, unknown>;
      }
    ): Promise<PanelHandle>;
  } {
    const flatten = (items: DurablePanelListItem[]): DurablePanelListItem[] => {
      const out: DurablePanelListItem[] = [];
      const visit = (item: DurablePanelListItem) => {
        out.push(item);
        for (const child of item.children ?? []) visit(child);
      };
      for (const item of items) visit(item);
      return out;
    };
    return {
      self: () =>
        createNonPanelRuntimeHandle({
          id: String(this.env["DO_ID"] ?? this.ctx.id.toString()),
        }),
      get: (id) => this.createRuntimePanelHandle(id),
      list: async () =>
        flatten(await this.panelCall<DurablePanelListItem[]>("list", [null])).map((item) =>
          this.hydratePanelListItem(item)
        ),
      roots: async () =>
        (await this.panelCall<DurablePanelListItem[]>("roots", [])).map((item) =>
          this.hydratePanelListItem(item)
        ),
      children: async (id) =>
        (await this.panelCall<DurablePanelListItem[]>("list", [id])).map((item) =>
          this.hydratePanelListItem(item)
        ),
      parent: (id) => {
        const parentId = this._panelMetadataCache.get(id)?.parentId ?? null;
        return parentId ? this.createRuntimePanelHandle(parentId) : null;
      },
      open: async (source, options) => {
        const parentId = options?.parentId ?? null;
        const result = await this.panelCall<{
          id: string;
          title: string;
          kind: "workspace" | "browser";
          runtimeEntityId?: string | null;
          effectiveVersion?: string | null;
        }>("create", [source, { ...options, parentId }]);
        return this.hydratePanelListItem({
          panelId: result.id,
          title: result.title,
          source: result.kind === "browser" ? `browser:${source}` : source,
          kind: result.kind,
          parentId,
          contextId: "",
          runtimeEntityId: result.runtimeEntityId ?? result.id,
          effectiveVersion: result.effectiveVersion ?? null,
        });
      },
    };
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
    try {
      await bridge.call("main", "runtime.setTitle", [
        effective,
        { explicit: options.explicit === true },
      ]);
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
    void this.alarmRpc("workspace-state.alarmSet", { ...this.lifecycleKey(), wakeAt: timeMs });
  }

  /** Cancel any pending alarm for this DO. */
  protected deleteAlarm(): void {
    void this.alarmRpc("workspace-state.alarmClear", this.lifecycleKey());
  }

  private lifecycleKey(): { source: string; className: string; objectKey: string } {
    return {
      source: String(this.env["WORKER_SOURCE"] ?? ""),
      className: String(this.env["WORKER_CLASS_NAME"] ?? this.constructor.name),
      objectKey: this.objectKey,
    };
  }

  private async alarmRpc(method: string, payload: unknown): Promise<void> {
    try {
      await this.rpc.call("main", method, [payload]);
    } catch (err) {
      console.warn(`[durable] ${method} failed:`, err instanceof Error ? err.message : err);
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

      // Event endpoint — handle incoming events
      if (method === "__event") {
        if (args.length < 2) {
          return new Response(
            JSON.stringify({ error: "__event requires at least [event, payload]" }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            }
          );
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
      const previousCallerPanelId = this._currentRpcCallerPanelId;
      const previousRequestId = this._currentRpcRequestId;
      const previousIdempotencyKey = this._currentRpcIdempotencyKey;
      const previousVerifiedCaller = this._currentVerifiedCaller;
      this._currentVerifiedCaller = verifiedCallerFromBody;
      this._currentRpcCallerId = request.headers.get("X-Natstack-Rpc-Caller-Id");
      this._currentRpcCallerKind = request.headers.get("X-Natstack-Rpc-Caller-Kind");
      this._currentRpcCallerPanelId = request.headers.get("X-Natstack-Rpc-Caller-Panel-Id");
      this._currentRpcRequestId = request.headers.get("X-Natstack-Rpc-Request-Id");
      this._currentRpcIdempotencyKey = request.headers.get("X-Natstack-Rpc-Idempotency-Key");
      try {
        const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
        return new Response(JSON.stringify(result ?? null), {
          headers: { "Content-Type": "application/json" },
        });
      } finally {
        this._currentRpcCallerId = previousCallerId;
        this._currentRpcCallerKind = previousCallerKind;
        this._currentRpcCallerPanelId = previousCallerPanelId;
        this._currentRpcRequestId = previousRequestId;
        this._currentRpcIdempotencyKey = previousIdempotencyKey;
        this._currentVerifiedCaller = previousVerifiedCaller;
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

  async prepareForRestart(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    return { status: "ready" };
  }

  async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {
    // Generic backstop: re-drive any pending deferred calls. Subclasses that
    // override this and maintain their own continuation store need not call
    // super (they don't use the generic deferred_requests table).
    await this.redriveDeferredRequests();
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
        await this.rpc.call("main", "workspace-state.lifecycleLeaseUpsert", [payload]);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  protected async markCheckpointableWorkInactive(): Promise<void> {
    await this.rpc.call("main", "workspace-state.lifecycleLeaseClear", [this.lifecycleKey()]);
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
