import type { AuthenticatedCaller, RpcClient } from "@natstack/rpc";

export interface DurableObjectContext {
  id: { toString(): string; name?: string };
  storage: {
    sql: SqlStorage;
    setAlarm(scheduledTime: number | Date): void;
    getAlarm(): Promise<number | null>;
    deleteAlarm(): void;
    transactionSync<T>(callback: () => T): T;
  };
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
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

interface HttpRpcClientConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
}

type HttpRpcClient = Pick<RpcClient, "call"> & {
  handleIncomingPost(body: unknown): Promise<unknown>;
};

function createHttpRpcClient(config: HttpRpcClientConfig): HttpRpcClient {
  const { selfId, serverUrl, authToken } = config;
  const rpcFetch = globalThis.fetch.bind(globalThis);
  return {
    async call<T>(targetId: string, method: string, args: unknown[]): Promise<T> {
      const response = await rpcFetch(`${serverUrl}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          "X-Natstack-Runtime-Id": selfId,
        },
        body: JSON.stringify({
          type: "call",
          requestId: crypto.randomUUID(),
          targetId,
          method,
          args,
        }),
      });
      if (response.status === 401) throw new Error("RPC authentication failed");
      const json = (await response.json()) as Record<string, unknown>;
      if (json["error"]) throw new Error(String(json["error"]));
      return json["result"] as T;
    },
    async handleIncomingPost(): Promise<unknown> {
      throw new Error("Inbound RPC is not available on @natstack/durable core objects");
    },
  };
}

export abstract class DurableObjectBase {
  static schemaVersion = 1;

  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected env: Record<string, unknown>;

  private schemaReady = false;
  private rpcClient: HttpRpcClient | null = null;
  private currentVerifiedCaller: AuthenticatedCaller | null = null;
  private currentRpcCallerId: string | null = null;
  private currentRpcCallerKind: string | null = null;
  private currentRpcCallerPanelId: string | null = null;
  private currentRpcRequestId: string | null = null;
  private currentRpcIdempotencyKey: string | null = null;
  private currentObjectKey: string | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.env = env as Record<string, unknown>;
  }

  protected abstract createTables(): void;

  protected migrate(_fromVersion: number, _toVersion: number): void {}

  protected ensureReady(): void {
    if (this.schemaReady) return;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    let currentVersion = 0;
    const row = this.sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray();
    if (row.length > 0) currentVersion = parseInt(String(row[0]!["value"]), 10) || 0;
    const targetVersion = (this.constructor as typeof DurableObjectBase).schemaVersion;
    this.createTables();
    if (currentVersion < targetVersion) {
      this.migrate(currentVersion, targetVersion);
      // Migrations may drop legacy tables; rebuild the current schema before stamping success.
      this.createTables();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    }
    this.schemaReady = true;
  }

  protected getStateValue(key: string): string | null {
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    return row.length > 0 ? String(row[0]!["value"]) : null;
  }

  protected setStateValue(key: string, value: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`, key, value);
  }

  protected deleteStateValue(key: string): void {
    this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
  }

  protected parseRequestBody(body: string): {
    args: unknown[];
    error?: string;
    caller?: AuthenticatedCaller | null;
  } {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return { args: parsed };
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
            },
          };
        }
      }
      return { args: (parsed as { args: unknown[] }).args };
    }
    return { args: [parsed] };
  }

  protected get rpc(): HttpRpcClient {
    if (!this.rpcClient) {
      const token = this.env["RPC_AUTH_TOKEN"];
      const source = this.env["WORKER_SOURCE"];
      const className = this.env["WORKER_CLASS_NAME"];
      const gatewayUrl = this.env["GATEWAY_URL"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("RPC not available: RPC_AUTH_TOKEN not configured");
      }
      if (typeof source !== "string" || source.length === 0) {
        throw new Error("RPC not available: WORKER_SOURCE not configured");
      }
      if (typeof className !== "string" || className.length === 0) {
        throw new Error("RPC not available: WORKER_CLASS_NAME not configured");
      }
      if (typeof gatewayUrl !== "string" || gatewayUrl.length === 0) {
        throw new Error("RPC not available: GATEWAY_URL not configured");
      }
      this.rpcClient = createHttpRpcClient({
        selfId: `do-service:${source}:${className}`,
        serverUrl: gatewayUrl,
        authToken: token,
      });
    }
    return this.rpcClient;
  }

  protected get caller(): AuthenticatedCaller | null {
    return this.currentVerifiedCaller;
  }

  protected get rpcCallerId(): string | null {
    return this.currentRpcCallerId;
  }

  protected get rpcCallerKind(): string | null {
    return this.currentRpcCallerKind;
  }

  protected get rpcCallerPanelId(): string | null {
    return this.currentRpcCallerPanelId;
  }

  protected get rpcRequestId(): string | null {
    return this.currentRpcRequestId;
  }

  protected get rpcIdempotencyKey(): string | null {
    return this.currentRpcIdempotencyKey;
  }

  protected get objectKey(): string {
    if (this.currentObjectKey) return this.currentObjectKey;
    if (this.ctx.id.name) {
      this.currentObjectKey = this.ctx.id.name;
      return this.currentObjectKey;
    }
    try {
      const stored = this.sql.exec(`SELECT value FROM state WHERE key = '__objectKey'`).toArray();
      if (stored.length > 0) {
        this.currentObjectKey = String(stored[0]!["value"]);
        return this.currentObjectKey;
      }
    } catch {
      /* state table may not exist yet */
    }
    throw new Error("objectKey not available");
  }

  protected setAlarm(delayMs: number): void {
    this.setAlarmAt(Date.now() + delayMs);
  }

  protected setAlarmAt(timeMs: number): void {
    void this.alarmRpc("workspace-state.alarmSet", { ...this.lifecycleKey(), wakeAt: timeMs });
  }

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

  async alarm(): Promise<void> {
    this.ensureReady();
  }

  async prepareForRestart(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    return { status: "ready" };
  }

  async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !this.currentObjectKey) {
      this.currentObjectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureReady();
    if (this.currentObjectKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO state (key, value) VALUES ('__objectKey', ?)`,
        this.currentObjectKey
      );
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

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
        return this.withCaller(verifiedCallerFromBody, async () => {
          if (this.caller?.callerKind !== "server") {
            return jsonResponse({ error: "Lifecycle calls require server caller" }, 403);
          }
          const result =
            method === "__lifecycle/prepare"
              ? await this.prepareForRestart(args[0] as LifecyclePrepareInput)
              : await this.resumeAfterRestart(args[0] as LifecycleResumeInput);
          return jsonResponse(result ?? null);
        });
      }

      if (method === "__alarm") {
        return this.withCaller(verifiedCallerFromBody, async () => {
          if (this.caller?.callerKind !== "server") {
            return jsonResponse({ error: "Alarm calls require server caller" }, 403);
          }
          await this.alarm();
          return jsonResponse({ result: "ok" });
        });
      }

      const fn = (this as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") return jsonResponse({ error: `Unknown method: ${method}` }, 404);

      return this.withRpcContext(request, verifiedCallerFromBody, async () => {
        const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
        return jsonResponse(result ?? null);
      });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  protected handleWebSocketUpgrade(_request: Request): Response {
    return new Response("WebSocket not supported", { status: 426 });
  }

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

  protected resetRpcClients(): void {
    this.rpcClient = null;
  }

  async getState(): Promise<Record<string, unknown>> {
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return { state };
  }

  private async withCaller(
    caller: AuthenticatedCaller | null,
    callback: () => Promise<Response>
  ): Promise<Response> {
    const previous = this.currentVerifiedCaller;
    this.currentVerifiedCaller = caller;
    try {
      return await callback();
    } finally {
      this.currentVerifiedCaller = previous;
    }
  }

  private async withRpcContext(
    request: Request,
    caller: AuthenticatedCaller | null,
    callback: () => Promise<Response>
  ): Promise<Response> {
    const previousCaller = this.currentVerifiedCaller;
    const previousCallerId = this.currentRpcCallerId;
    const previousCallerKind = this.currentRpcCallerKind;
    const previousCallerPanelId = this.currentRpcCallerPanelId;
    const previousRequestId = this.currentRpcRequestId;
    const previousIdempotencyKey = this.currentRpcIdempotencyKey;
    this.currentVerifiedCaller = caller;
    this.currentRpcCallerId = request.headers.get("X-Natstack-Rpc-Caller-Id");
    this.currentRpcCallerKind = request.headers.get("X-Natstack-Rpc-Caller-Kind");
    this.currentRpcCallerPanelId = request.headers.get("X-Natstack-Rpc-Caller-Panel-Id");
    this.currentRpcRequestId = request.headers.get("X-Natstack-Rpc-Request-Id");
    this.currentRpcIdempotencyKey = request.headers.get("X-Natstack-Rpc-Idempotency-Key");
    try {
      return await callback();
    } finally {
      this.currentVerifiedCaller = previousCaller;
      this.currentRpcCallerId = previousCallerId;
      this.currentRpcCallerKind = previousCallerKind;
      this.currentRpcCallerPanelId = previousCallerPanelId;
      this.currentRpcRequestId = previousRequestId;
      this.currentRpcIdempotencyKey = previousIdempotencyKey;
    }
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
