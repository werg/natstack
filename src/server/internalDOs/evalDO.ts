import { DurableObjectBase, rpc, type DurableObjectContext } from "@natstack/durable";
import type { AuthenticatedCaller } from "@natstack/rpc";
import {
  createBuildServiceClient,
  createEvalImportLoader,
  requireBuildBundleResult,
  type BuildServiceClient,
  type EvalImportLoader,
} from "@natstack/shared/evalImportLoader";
import { eventsMethods } from "@natstack/shared/serviceSchemas/events";
import { externalOpenMethods } from "@natstack/shared/serviceSchemas/externalOpen";
import { fsMethods } from "@natstack/shared/serviceSchemas/fs";
import { metaMethods } from "@natstack/shared/serviceSchemas/meta";
import { EVAL_AMBIENT_ONLY } from "@natstack/shared/runtimeSurface.eval";
import { buildOwnerBindings } from "./evalOwnerBindings.js";
import { ConsoleStreamer } from "./consoleStreamer.js";
import { describeEvalBindingSurface, normalizeAmbientRpcCall } from "./evalSurfaceHelp.js";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@natstack/shared/typedServiceClient";
import {
  createPanelRuntime,
  createRuntimeSelfHandle,
  type PanelRuntimeApi,
} from "@workspace/runtime/panel-runtime";
import {
  createGatewayFetch,
  createHostedRuntime,
  createRpcFs,
  createRuntimeParentHandle,
  createWorkerdClient,
  type RuntimeHost,
  type WorkspaceRuntime,
} from "@workspace/runtime/hosted";

/**
 * EvalDO — the blessed, per-owner unsafe-eval kernel.
 *
 * An internal Durable Object (alongside WorkspaceDO/BrowserDataDO) that runs the agent
 * `eval` capability server-side. It:
 *  - dynamically loads the `@workspace/eval` engine at runtime (it is NOT statically
 *    bundled here — keeps the internal bundle lean and lets the volatile engine update
 *    without a kernel rebuild),
 *  - compiles via the workerd `UNSAFE_EVAL` binding (`new Function` is blocked in workerd;
 *    we install `__natstackCompileFunction__` so the engine's two codegen sites route
 *    through `env.UNSAFE_EVAL.newFunction`),
 *  - persists REPL scope in its own SQLite via `SqlScopePersistence`,
 *  - exposes a synchronous in-DO `db` (its SQLite) to eval'd code, with reserved-table guards.
 *
 * Trust model: only the server `eval` service dispatches to it (owner is enforced there by
 * deriving the objectKey from the verified caller), so the DO needs no in-DO authz.
 *
 * Bindings mirror the in-app eval tool's surface: injected
 * `rpc`/`services`/`fs`/`ctx` + `scope`/`scopes`/`help` + `db`, plus a `chat`
 * binding when the owner is an agent DO bound to a channel (a pure forwarding
 * proxy to the agent — the EvalDO carries ZERO channel logic). (Panel-style
 * `import { fs } from "@workspace/runtime"` does not initialize in a DO isolate.)
 */

/** Reserved tables the user `db` may not DROP/DELETE/ALTER — base state, scope, sqlite internals. */
const RESERVED_TABLE = /\b(state|repl_scopes|scope_blobs|sqlite_[A-Za-z0-9_]*)\b/i;
const DESTRUCTIVE_STMT = /^\s*(DROP|DELETE|ALTER|UPDATE|INSERT|REPLACE|TRUNCATE|CREATE)\b/i;

/**
 * Idle window before an EvalDO discards its in-memory instance. `preventEviction` keeps the
 * DO warm (nothing evicts it otherwise), so it self-evicts to reclaim memory. Long, because
 * eviction forces a cold reload of the engine + a scope rehydrate on the next run.
 */
const IDLE_EVICT_MS = 30 * 60_000;

interface UnsafeEvalBinding {
  eval(code: string, name?: string): unknown;
  newFunction(code: string, name?: string, ...argNames: string[]): (...args: unknown[]) => unknown;
}

interface SandboxResult {
  success: boolean;
  consoleOutput: string;
  returnValue?: unknown;
  exports?: Record<string, unknown>;
  error?: string;
}

interface ScopeManagerLike {
  readonly current: Record<string, unknown>;
  readonly api: unknown;
  hydrate(): Promise<unknown>;
  enterEval(): void;
  exitEval(): Promise<void>;
}

interface EvalEngine {
  executeSandbox(code: string, options: Record<string, unknown>): Promise<SandboxResult>;
  ScopeManager: new (opts: {
    channelId: string;
    panelId: string;
    persistence: unknown;
  }) => ScopeManagerLike;
  SqlScopePersistence: new (sql: unknown) => unknown;
}

type GlobalBag = Record<string, unknown>;
type FsClient = TypedServiceClient<typeof fsMethods>;
type MetaClient = TypedServiceClient<typeof metaMethods>;
type EventsClient = TypedServiceClient<typeof eventsMethods>;
type ExternalOpenClient = TypedServiceClient<typeof externalOpenMethods>;

interface RunArgs {
  code?: string;
  path?: string;
  syntax?: "typescript" | "jsx" | "tsx";
  imports?: Record<string, string>;
  /** Owner's contextId, resolved + passed by the eval service (informational for `ctx`). */
  contextId?: string;
  /**
   * Channel the eval is bound to. Present only when the owner is an agent DO
   * (set by the eval service). Pairs with `agentRef`; when both are present a
   * `chat` binding is injected that forwards every op to the agent DO.
   */
  channelId?: string;
  /**
   * The owning agent DO's runtime id (its own `do:source:Class:objectKey`).
   * Set by the eval service to the verified caller; the `chat` binding proxies
   * every op to `agentRef.chatOp(channelId, op, args)`. The agent re-derives
   * THIS EvalDO's objectKey to authorize the forward.
   */
  agentRef?: string;
  /**
   * Owner-scoped gateway bearer minted by the eval service for THIS EvalDO's
   * concrete `do:...:EvalDO:<objectKey>` identity (NOT the shared internal-DO
   * service bearer). Backs `gatewayConfig`/`gatewayFetch` so a leak is scoped to
   * the owner. Server→DO arg only — never user-supplied.
   */
  gatewayToken?: string;
  /**
   * The owner's nearest panel ancestor (resolved server-side by the eval service
   * from verified entity lineage), or absent when there is none. Backs the
   * portable `parent`/`getParent`/`getParentWithContract`. Server→DO arg only.
   */
  parent?: { parentId: string; parentEntityId: string; parentKind: "panel" | "worker" | "do" };
  /** Caller-provided idempotency key for the run (agents: the raw invocationId). */
  runId?: string;
  /** Opt-in deadline; the run is aborted after this many ms. Absent ⇒ unbounded. */
  timeoutMs?: number;
}

interface RunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  scopeKeys?: string[];
}

export class EvalDO extends DurableObjectBase {
  static override schemaVersion = 1;

  private engine: EvalEngine | null = null;
  private scopeManager: ScopeManagerLike | null = null;
  /** Serializes eval runs — ScopeManager has a single in-progress flag + one current scope. */
  private runChain: Promise<unknown> = Promise.resolve();
  /** In-flight runs in THIS instance, keyed by runId → the single execution promise. A concurrent
   *  `executeRun` (e.g. a deferRedrive that races the first dispatch) SHARES this promise instead of
   *  starting a second sandbox run; also lets `reset` abort live runs and `alarm` skip mid-run. */
  private readonly inFlightRuns = new Map<string, Promise<RunResult>>();
  /** Abort controllers per in-flight run — used by `reset` and the `timeoutMs` deadline. */
  private readonly runAborts = new Map<string, AbortController>();
  private buildClient: BuildServiceClient | null = null;
  private fsClient: FsClient | null = null;
  private metaClient: MetaClient | null = null;
  private eventsClient: EventsClient | null = null;
  private externalOpenClient: ExternalOpenClient | null = null;
  /**
   * The portable runtime surface (createHostedRuntime) — the SAME assembly panel
   * and worker run, so `import { … } from "@workspace/runtime"` resolves to the
   * identical surface in eval. Cached per-object (its rpc/fs are owner-scoped).
   */
  private hostedRuntime: WorkspaceRuntime | null = null;
  /** Owner identity baked into the cached hosted runtime at first init. A warm
   *  EvalDO serves exactly one owner (objectKey = sha256(ownerId\0subKey)), so a
   *  later run arriving with a different contextId/gatewayToken is a routing or
   *  ownership bug — refuse loudly rather than silently run under stale identity
   *  (Finding 3). */
  private hostedRuntimeIdentity: { contextId: string; gatewayToken: string } | null = null;
  private cdpLoaded = false;
  /**
   * The owner's nearest panel ancestor (server-supplied via `RunArgs.parent`),
   * read by the hosted runtime's `resolveParent`. Mutable so a re-resolved parent
   * is reflected even though `hostedRuntime` is cached (the closure reads it live).
   */
  private parentMeta: RunArgs["parent"] | null = null;

  /**
   * Per-OBJECT module registry passed to the engine on every run. Many owners' EvalDOs share
   * one workerd isolate, so the engine's per-isolate global `__natstackModuleMap__` would leak
   * one owner's loaded `imports` into another (and dedup-by-specifier could hand owner B owner
   * A's *version*). A per-object map keeps each owner's modules isolated. Persists across this
   * DO's runs for import continuity (a module loaded in one run is reusable by the next).
   */
  private moduleMap: Record<string, unknown> = {};

  /** Per-object require paired with `moduleMap` (resolves only THIS owner's loaded modules). */
  private engineRequire = (id: string): unknown => {
    const m = this.moduleMap[id];
    if (m !== undefined) return m;
    throw new Error(`Module "${id}" not available in EvalDO; use the imports parameter.`);
  };

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
    // Runs once per boot (this instance), before any run executes — so every `running`
    // row is orphaned by a prior instance whose held connection dropped (server restart).
    this.reconcileOrphanedRuns();
  }

  protected createTables(): void {
    // The base `state` table is created by ensureReady(). The scope table (`repl_scopes`)
    // is created lazily by SqlScopePersistence on first run; user `db` tables are created
    // on demand by eval'd code.
    //
    // The `runs` table is the durable job queue: `startRun` inserts, `executeRun` runs the
    // sandbox synchronously in a HELD handler (the eval service holds the connection open —
    // workerd does not cap held requests), `getRun` is the poll backstop. `agent_ref`/
    // `channel_id` are stored so the alarm-free executeRun reconstructs the `chat` binding.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        args TEXT NOT NULL,
        agent_ref TEXT,
        channel_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        started_at INTEGER NOT NULL,
        deadline_at INTEGER
      )
    `);
  }

  /**
   * Crash recovery: a held `executeRun` connection drops on server restart → workerd cancels
   * the EvalDO handler → the run dies mid-flight, leaving a `running` row no in-memory executor
   * owns. Called once at construction (before any run is live), so every `running` row is stale.
   * Mark them an interrupt error; the waiting caller's `getRun` poll surfaces it and the model
   * re-issues (a fresh runId). We never auto-re-run — evals have side effects (spawned agents).
   */
  private reconcileOrphanedRuns(): void {
    this.sql.exec(
      `UPDATE runs SET status = 'done', result = ? WHERE status = 'running'`,
      JSON.stringify({ success: false, console: "", error: "eval interrupted by restart" })
    );
  }

  private readonly callMainService = (
    service: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> => this.rpc.call("main", `${service}.${method}`, args);

  private mainBuild(): BuildServiceClient {
    return (this.buildClient ??= createBuildServiceClient(this.callMainService));
  }

  private mainFs(): FsClient {
    return (this.fsClient ??= createTypedServiceClient("fs", fsMethods, this.callMainService));
  }

  private mainMeta(): MetaClient {
    return (this.metaClient ??= createTypedServiceClient(
      "meta",
      metaMethods,
      this.callMainService
    ));
  }

  private mainEvents(): EventsClient {
    return (this.eventsClient ??= createTypedServiceClient(
      "events",
      eventsMethods,
      this.callMainService
    ));
  }

  private mainExternalOpen(): ExternalOpenClient {
    return (this.externalOpenClient ??= createTypedServiceClient(
      "externalOpen",
      externalOpenMethods,
      this.callMainService
    ));
  }

  /**
   * Describe an injected runtime binding (fs/vcs/…) as the eval ACTUALLY sees it: the live object's
   * own methods, each enriched from the RPC-service schema where names match (or a known ergonomic
   * note). Truthful by construction — it reflects the real surface instead of the raw service, whose
   * low-level wire methods (e.g. fs.handleClose) the ergonomic client hides behind open()→FileHandle.
   * Returns null when the binding exposes no enumerable methods (e.g. a Proxy namespace) so `help()`
   * falls back to the plain service schema.
   */
  private async describeInjectedSurface(
    name: string,
    obj: Record<string, unknown>
  ): Promise<unknown | null> {
    const liveMethods = Object.keys(obj).filter((k) => typeof obj[k] === "function");
    if (liveMethods.length === 0) return null;
    let serviceMethods: Record<string, unknown> = {};
    try {
      const svc = (await this.mainMeta().describeService(name)) as {
        methods?: Record<string, unknown>;
      };
      serviceMethods = svc?.methods ?? {};
    } catch {
      // Not an RPC service (or not describable) — reflection alone still gives the truthful surface.
    }
    return describeEvalBindingSurface(name, liveMethods, serviceMethods);
  }

  /**
   * Per-object runtime id so the server resolves THIS EvalDO's registered entity (and thus
   * the owner's context) for fs/git/vcs — the shared `do-service:<source>:<class>` id can't
   * distinguish owners. Authorized by the internal-DO service bearer, which covers the
   * `do:natstack/internal:EvalDO:*` prefix (rpcServer.isRuntimeIdForServiceToken).
   */
  protected override get rpcSelfId(): string {
    const source = String(this.env["WORKER_SOURCE"] ?? "");
    const className = String(this.env["WORKER_CLASS_NAME"] ?? "");
    return `do:${source}:${className}:${this.objectKey}`;
  }

  /**
   * Disable the inbound `respond()` reaper: `executeRun` is a HELD handler that legitimately runs
   * for the eval's whole duration (the eval service holds the connection with a no-`headersTimeout`
   * dispatcher). Unbounded by default; an opt-in `timeoutMs` bounds a run, and a dropped connection
   * (server restart) ends it (reconciled on boot). Quick methods (startRun/getRun) resolve at once.
   */
  protected override get respondTimeoutMs(): number {
    return 0;
  }

  /**
   * The EvalDO's METHOD-CALL surface is server-ONLY: the eval service is the sole
   * dispatcher (callerKind "server"; it derives the objectKey from the verified
   * caller and registers the owner context). The generic DO relay is open
   * (rpcServer.checkRelayAuth) AND `exposeAll` reflects every method — including
   * TS-private helpers like `runLocked` (runs arbitrary owner code) and
   * `callMainService` (arbitrary `main` call as the owner), which are
   * runtime-public. So we reject EVERY non-server inbound CALL as a blanket guard.
   *
   * Event DELIVERIES are different: the EvalDO (or eval code) subscribes to topics
   * /channels (vcs.subscribeHead, channel messages), and the publisher — the
   * server event-push (caller "server") OR a PubSubChannel DO (caller "do") —
   * pushes events to it. Those are opt-in notifications routed to `rpc.on`
   * handlers (owner-scoped, non-privileged), NOT method invocations, so we accept
   * them regardless of caller. Blocking them broke channel delivery to a
   * subscribed EvalDO ("DO RPC relay failed (500): EvalDO is server-only").
   */
  protected override assertInboundAllowed(
    caller: AuthenticatedCaller | null,
    kind: "call" | "event"
  ): void {
    if (kind === "event") return;
    if (caller?.callerKind !== "server") {
      throw new Error(
        `eval: EvalDO is server-only (dispatched by the eval service); refusing caller kind ${caller?.callerKind ?? "unknown"}`
      );
    }
  }

  // ── public RPC methods (dispatched by the server `eval` service) ──────────────

  /**
   * Held synchronous run for connection-holding callers (panels over their persistent WS, the CLI):
   * insert + execute in this held handler, return the result in one response. The CALLER holds its
   * own leg; the server holds the EvalDO leg. workerd does not cap a held request.
   */
  @rpc
  async run(args: RunArgs): Promise<RunResult> {
    const runId = args.runId ?? crypto.randomUUID();
    this.startRun({ ...args, runId });
    return this.executeRun(runId);
  }

  /**
   * Quick, idempotent enqueue — insert a `pending` row, return at once (no execution). The eval
   * service awaits this before returning `runId` to an async (agent) caller, so the row exists for
   * `getRun`. Idempotent on `run_id`: a replayed run returns the existing row, never a duplicate.
   */
  @rpc
  startRun(args: RunArgs & { runId: string }): { runId: string; status: string } {
    const runId = args.runId;
    const existing = this.sql.exec(`SELECT status FROM runs WHERE run_id = ?`, runId).toArray()[0];
    if (existing) return { runId, status: String(existing["status"]) };
    const deadlineAt = args.timeoutMs ? Date.now() + args.timeoutMs : null;
    this.sql.exec(
      `INSERT INTO runs (run_id, args, agent_ref, channel_id, status, started_at, deadline_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      runId,
      JSON.stringify(args),
      args.agentRef ?? null,
      args.channelId ?? null,
      Date.now(),
      deadlineAt
    );
    return { runId, status: "pending" };
  }

  /**
   * The HELD synchronous execution (one held connection per call from the eval service / panel).
   * Idempotent on `runId`: a concurrent or re-dispatched call SHARES the single in-flight promise
   * rather than starting a second sandbox run — so a deferRedrive that races the first dispatch can
   * never double-run the eval (which would double-spawn headless agents).
   */
  @rpc
  async executeRun(runId: string): Promise<RunResult> {
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) return inFlight;
    const promise = this.runEval(runId);
    this.inFlightRuns.set(runId, promise);
    void promise.catch(() => undefined).finally(() => this.inFlightRuns.delete(runId));
    return promise;
  }

  /**
   * Run the sandbox once for `runId`: claim the row (pending → running), execute (serialized via
   * `runChain` so ScopeManager's single enter/exit is never concurrent), and persist the result with
   * a CAS so a concurrent `reset` cancel is never resurrected.
   */
  private async runEval(runId: string): Promise<RunResult> {
    this.sql.exec(
      `UPDATE runs SET status = 'running' WHERE run_id = ? AND status = 'pending'`,
      runId
    );
    const row = this.sql
      .exec(`SELECT status, args, deadline_at, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return { success: false, console: "", error: `eval: unknown run ${runId}` };
    const claimed = String(row["status"]);
    if (claimed !== "running") {
      // Already terminal (idempotent re-dispatch, or cancelled before we claimed it).
      if (claimed === "done" && row["result"] != null) {
        return JSON.parse(String(row["result"])) as RunResult;
      }
      return { success: false, console: "", error: `eval: run ${runId} is ${claimed}` };
    }

    const args = JSON.parse(String(row["args"])) as RunArgs;
    const deadlineAt = row["deadline_at"] != null ? Number(row["deadline_at"]) : null;
    const controller = new AbortController();
    this.runAborts.set(runId, controller);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (deadlineAt != null) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) controller.abort();
      else {
        timer = setTimeout(() => controller.abort(), remaining);
        timer.unref?.();
      }
    }

    let result: RunResult;
    try {
      const ran = this.runChain.then(() => this.runLocked(args, controller.signal, runId));
      this.runChain = ran.catch(() => undefined);
      result = await ran;
      if (controller.signal.aborted && result.success) {
        result = {
          success: false,
          console: result.console,
          error: `eval timed out after ${args.timeoutMs}ms`,
        };
      }
    } catch (err) {
      result = {
        success: false,
        console: "",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.runAborts.delete(runId);
      // Arm best-effort idle-eviction now that the run is done (never fires mid-run — see alarm()).
      this.setAlarmAt(Date.now() + IDLE_EVICT_MS, { bestEffort: true });
    }

    // CAS persist: write `done` only if still `running`, so a concurrent `reset` → `cancelled` wins.
    this.sql.exec(
      `UPDATE runs SET status = 'done', result = ? WHERE run_id = ? AND status = 'running'`,
      JSON.stringify(result),
      runId
    );
    const finalStatus = this.sql
      .exec(`SELECT status FROM runs WHERE run_id = ?`, runId)
      .toArray()[0]?.["status"];
    if (String(finalStatus) === "cancelled") {
      return { success: false, console: result.console, error: "eval: run cancelled" };
    }
    return result;
  }

  /** Poll backstop: a run's status + result (`status` is 'pending'|'running'|'done'|'cancelled'|'unknown'). */
  @rpc
  getRun(runId: string): { status: string; result?: RunResult } {
    const row = this.sql
      .exec(`SELECT status, result FROM runs WHERE run_id = ?`, runId)
      .toArray()[0];
    if (!row) return { status: "unknown" };
    const status = String(row["status"]);
    return row["result"] != null
      ? { status, result: JSON.parse(String(row["result"])) as RunResult }
      : { status };
  }

  /** Reset the eval context: cancel in-flight runs, then wipe user tables + scope (preserving base + runs). */
  @rpc
  async reset(): Promise<{ ok: boolean }> {
    // Cancel queued + in-flight runs FIRST so a run finishing normally can't CAS itself `done`
    // (executeRun's write requires status='running'); then abort any live run.
    this.sql.exec(`UPDATE runs SET status = 'cancelled' WHERE status IN ('pending', 'running')`);
    for (const id of this.inFlightRuns.keys()) this.runAborts.get(id)?.abort();
    const result = this.runChain.then(() => this.resetLocked());
    this.runChain = result.catch(() => undefined);
    return result;
  }

  private resetLocked(): { ok: boolean } {
    const tables = this.sql
      .exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('state', 'repl_scopes', 'runs')`
      )
      .toArray() as Array<{ name: string }>;
    for (const { name } of tables) {
      this.sql.exec(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`);
    }
    // Drop the scope table (lazily created by SqlScopePersistence) — IF EXISTS so reset
    // works before the first run (e.g. `--fresh-scope`); the next run recreates it empty.
    this.sql.exec(`DROP TABLE IF EXISTS repl_scopes`);
    this.scopeManager = null; // force fresh hydrate (empty) on next run
    return { ok: true };
  }

  /**
   * Idle GC. The only alarm we arm is the best-effort idle-eviction alarm; when it fires,
   * discard the in-memory instance to reclaim RAM (`preventEviction` means workerd never
   * evicts us). Scope is already persisted after every run (exitEval), so `abort()` is safe:
   * it preserves SQLite, and the next run lazily reconstructs + rehydrates. The aborted
   * `__alarm` dispatch "fails", but the alarm is best-effort so the AlarmDriver does not
   * re-arm it — no resurrection loop.
   */
  override async alarm(): Promise<void> {
    // Never evict mid-run: a held `executeRun` keeps us active anyway, but if a stray idle alarm
    // fires while a run is in flight, re-arm instead of aborting it.
    if (this.inFlightRuns.size > 0) {
      this.setAlarmAt(Date.now() + IDLE_EVICT_MS, { bestEffort: true });
      return;
    }
    // Drop any lingering server-side event subscriptions (e.g. an eval that
    // called vcs.subscribeHead without unsubscribing) BEFORE discarding the
    // instance. The in-memory rpc.on listeners die with the abort, so an
    // un-torn-down server subscription would otherwise re-wake this DO on every
    // matching emit — defeating the idle eviction. A later run can re-subscribe.
    await this.mainEvents()
      .unsubscribeAll()
      .catch(() => {});
    this.ctx.abort("EvalDO: idle eviction (reclaim memory; SQLite preserved)");
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private async runLocked(args: RunArgs, signal?: AbortSignal, runId?: string): Promise<RunResult> {
    const engine = await this.ensureEngine();
    const scopeManager = await this.ensureScopeManager(engine);
    // The hosted runtime's `resolveParent` reads `this.parentMeta` live, so set it
    // before (re)building the host. Server-supplied; defaults to no parent.
    this.parentMeta = args.parent ?? null;
    const rt = this.ensureHostedRuntime(args.contextId ?? "", args.gatewayToken);

    const rpcBinding = {
      // EVAL.md documents the 2-arg ambient sugar `rpc.call(method, args)` (targets "main"). For
      // ergonomics we ALSO accept the full-client habit `rpc.call(target, method, args)`
      // (disambiguated by `normalizeAmbientRpcCall`), so the common cross-context call doesn't fail
      // with a cryptic "Invalid method format". `rpc.callTarget(targetId, method, args)` is unchanged.
      call: (a: string, b?: unknown, c?: unknown) => {
        const [target, method, callArgs] = normalizeAmbientRpcCall(a, b, c);
        return this.rpc.call(target, method, callArgs);
      },
      callTarget: (targetId: string, method: string, callArgs: unknown[] = []) =>
        this.rpc.call(targetId, method, callArgs),
    };
    // `services` IS the runtime — `services.vcs` is the SAME curated client object as the bare
    // `vcs` (and `import { vcs } from "@workspace/runtime"`). There is no second, stringly
    // "services.X.Y → rpc.call('X.Y')" proxy that could diverge from the clients (the old footgun:
    // `services.extensions.use` failing because the raw proxy only knew `invoke`). Server services
    // that have no curated client are reached generically via `callMain("svc.method", …)` / `rpc.call`.
    const services = rt;

    // Layer 2 — the importable surface (gad/workspace/credentials/openPanel/…)
    // injected ambiently too (same refs as `import {…} from "@workspace/runtime"`),
    // plus Layer 3 — eval-only ambient sugar (EVAL_AMBIENT_ONLY + 2-arg rpc).
    const bindings: Record<string, unknown> = {
      ...rt,
      rpc: rpcBinding,
      services,
      ctx: { contextId: args.contextId ?? null, objectKey: this.objectKey },
      scope: scopeManager.current,
      scopes: scopeManager.api,
      db: this.dbBinding(),
      // `help()` → discovery for an agent driving eval: the importable runtime
      // surface (what `import {…} from "@workspace/runtime"` gives), the ambient
      // pre-injected globals (do NOT import these), the available services, and
      // where to look next. `help("<service>")` → that service's methods.
      help: async (serviceName?: string) => {
        if (serviceName) {
          // Prefer the INJECTED binding's surface (what eval actually calls) over the raw RPC
          // service — they can diverge (fs's low-level handle* wire methods are hidden behind
          // open()→FileHandle).
          const injected = (rt as unknown as Record<string, unknown>)[serviceName];
          if (injected !== undefined) {
            if (injected && typeof injected === "object") {
              const described = await this.describeInjectedSurface(
                serviceName,
                injected as Record<string, unknown>
              );
              if (described) return described;
            }
            // A function/value runtime export (openPanel, getPanelHandle, listPanels, callMain, …) —
            // NOT an RPC service. Point to the docs instead of throwing "Unknown service".
            return {
              name: serviceName,
              surface: "injected-runtime",
              kind: typeof injected,
              note:
                `\`${serviceName}\` is a top-level runtime export from \`@workspace/runtime\` (a ` +
                `${typeof injected}) — call it directly, it is not an RPC service. See its signature ` +
                `in skills/sandbox/RUNTIME_API.md (panel APIs: skills/workspace-dev/PANEL_API.md). ` +
                `Use \`help('<name>')\` with a name from the \`services\` list for RPC services.`,
            };
          }
          return this.mainMeta().describeService(serviceName);
        }
        return {
          services: await this.mainMeta().listServices(),
          importable: Object.keys(rt).sort(),
          ambient: [...EVAL_AMBIENT_ONLY],
          guidance:
            "Call help('<name>') for a binding's methods — for injected runtime bindings (fs, vcs, …) " +
            "this describes what you actually call (e.g. fs.open()→FileHandle), not the raw RPC " +
            'service. `importable` names come from `import {…} from "@workspace/runtime"`; `ambient` ' +
            "names are pre-injected globals (do NOT import them). Use the `imports` parameter for " +
            "npm/workspace packages. Full reference: skills/sandbox/EVAL.md.",
        };
      },
    };

    // `chat` binding — pure forwarding to the owning agent DO. Present only when
    // the owner is an agent DO that supplied a channelId (the eval service sets
    // both). The EvalDO carries NO channel/card logic: every ChatSandboxValue
    // method is `agentRef.chatOp(channelId, "<method>", args)`, and the agent
    // performs it AS the agent (correct @agent attribution) and relays the
    // result. `rpc` reuses the already-injected rpc shape.
    // `chat` + `agent` are injected ONLY for agent-owned eval; absent otherwise
    // (CLI/panel eval) — see buildOwnerBindings.
    Object.assign(
      bindings,
      buildOwnerBindings(args, (t, m, a) => this.rpc.call(t, m, a))
    );

    // In path mode, load the entry file. The eval service validates exactly one of
    // `code` or `path`; this fallback remains defensive for direct/internal calls.
    const entryCode =
      args.code !== undefined ? args.code : args.path ? await this.readSourceFile(args.path) : "";

    // Lazily build the cdp-client bundle ONLY when this run references CDP. Most
    // evals (fs/vcs/git) never touch it, and the build is a cold-path round-trip
    // that dominated first-run latency. Direct `import "@workspace/cdp-client"`
    // self-heals via the engine's loadImport; this pre-seed is for the
    // `handle.cdp` → loadLightweightClient sync-require path. The check is
    // conservative — every route to the client (the import specifier,
    // `handle.cdp`, `CdpConnection`, `getCdpEndpoint`) contains "cdp", so a
    // no-match guarantees no CDP use; a false positive just restores prior cost.
    if (this.referencesCdp(entryCode, args.imports)) {
      await this.ensureCdpModule();
    }

    // Live console streaming — agent-owned eval only (`agentRef`+`channelId` set by the eval service).
    // Each chunk is forwarded to the owning agent's `onEvalProgress` (gated there by
    // `assertOwnEvalCaller`), which publishes it as an `invocation.output` event so the chat panel
    // renders the console live. CLI/panel eval (no `agentRef`) gets the full console in the result.
    const agentRef = args.agentRef;
    const channelId = args.channelId;
    const streamer =
      agentRef && channelId && runId
        ? new ConsoleStreamer((chunk) =>
            this.rpc
              .call(agentRef, "onEvalProgress", [{ runId, channelId, output: chunk }])
              .then(() => undefined)
          )
        : null;

    let consoleOutput = "";
    scopeManager.enterEval();
    try {
      const result = await engine.executeSandbox(entryCode, {
        syntax: args.syntax ?? "tsx",
        imports: args.imports,
        sourcePath: args.path,
        loadImport: this.makeLoadImport(),
        loadSourceFile: args.path ? (p: string) => this.readSourceFile(p) : undefined,
        bindings,
        // Per-object map/require so this owner's loaded imports never leak to other owners
        // sharing the isolate (the engine's global module map is the multi-tenant leak).
        moduleMap: this.moduleMap,
        require: this.engineRequire,
        // Opt-in deadline (timeoutMs) → AbortSignal. Best-effort: the engine may not honor it
        // mid-synchronous-CPU; it fires reliably at await points.
        signal,
        onConsole: (formatted: string) => {
          consoleOutput += (consoleOutput ? "\n" : "") + formatted;
          streamer?.push(formatted);
        },
      });
      // Drain the streamed console before returning — guarantees every chunk lands before the
      // invocation terminal that `onEvalComplete` publishes once `executeRun` returns.
      if (streamer) await streamer.finalFlush();
      const consoleText = result.consoleOutput || consoleOutput;
      // Recoverable large output: the harness windows console/return for the
      // model, losing the tail. Stash a bounded copy into the persistent scope so
      // the agent can page/grep it in a follow-up eval. Overwritten each run (not
      // accumulated), and cleared when output is small, so scope can't balloon.
      this.spillLargeOutput(scopeManager.current, consoleText, result.returnValue);
      return {
        success: result.success,
        console: consoleText,
        returnValue: result.returnValue,
        error: result.error,
        scopeKeys: Object.keys(scopeManager.current),
      };
    } finally {
      await scopeManager.exitEval();
    }
  }

  /**
   * Persist a bounded copy of large console/return output into the live scope
   * under reserved `$lastConsole`/`$lastReturn` keys (see runLocked). Below the
   * threshold the keys are removed so a small run doesn't leave a stale buffer.
   */
  private spillLargeOutput(
    scope: Record<string, unknown>,
    console: string,
    returnValue: unknown
  ): void {
    const THRESHOLD = 50_000; // ≤ the harness window — anything windowed IS spilled
    const MAX = 1_000_000; // hard cap so the persisted scope can't balloon
    const stash = (key: string, text: string): void => {
      if (text.length <= THRESHOLD) {
        Reflect.deleteProperty(scope, key);
        return;
      }
      scope[key] =
        text.length > MAX
          ? `${text.slice(0, MAX)}\n…[${text.length - MAX} more chars dropped]`
          : text;
    };
    stash("$lastConsole", console);
    let returnText = "";
    if (returnValue !== undefined) {
      try {
        returnText = JSON.stringify(returnValue, null, 2) ?? String(returnValue);
      } catch {
        returnText = String(returnValue);
      }
    }
    stash("$lastReturn", returnText);
  }

  /** Bootstrap module-map/require/compile globals + dynamically load `@workspace/eval`. */
  private async ensureEngine(): Promise<EvalEngine> {
    if (this.engine) return this.engine;
    const g = globalThis as GlobalBag;

    // Compile function backed by the workerd UnsafeEval binding (new Function is blocked).
    const unsafeEval = this.env["UNSAFE_EVAL"] as UnsafeEvalBinding | undefined;
    if (!unsafeEval) throw new Error("EvalDO: UNSAFE_EVAL binding not configured");
    g["__natstackCompileFunction__"] = (argNames: string[], body: string) =>
      unsafeEval.newFunction(body, "eval", ...argNames);

    // Module map + require (mirrors the worker bundle bootstrap).
    const moduleMap = (g["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
    g["__natstackRequire__"] = (id: string): unknown => {
      const mod = moduleMap[id];
      if (mod) return mod;
      throw new Error(`Module "${id}" not available in EvalDO. Use the imports parameter for npm.`);
    };

    // Load the engine bundle once and execute it into the module map via the same
    // UnsafeEval compiler (new Function is blocked even for this bootstrap step).
    if (!moduleMap["@workspace/eval"]) {
      const built = await this.mainBuild().getBuild("@workspace/eval", undefined, {
        library: true,
        externals: Object.keys(moduleMap),
        libraryTarget: "worker",
      });
      const bundle = requireBuildBundleResult(
        built,
        "EvalDO: build.getBuild did not return a library bundle for @workspace/eval"
      );
      const compile = g["__natstackCompileFunction__"] as (
        a: string[],
        b: string
      ) => (...args: unknown[]) => unknown;
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const fn = compile(["require", "exports", "module"], bundle);
      fn(g["__natstackRequire__"], exports, module);
      moduleMap["@workspace/eval"] = module.exports;
    }

    this.engine = moduleMap["@workspace/eval"] as EvalEngine;
    return this.engine;
  }

  private async ensureScopeManager(engine: EvalEngine): Promise<ScopeManagerLike> {
    if (this.scopeManager) return this.scopeManager;
    const persistence = new engine.SqlScopePersistence(this.sql);
    const mgr = new engine.ScopeManager({
      channelId: this.objectKey, // one scope per EvalDO instance
      panelId: "eval",
      persistence,
    });
    // MUST await hydrate before the manager is used: enterEval/exitEval read &
    // re-persist `current`, so a run that proceeds before the prior scope loads
    // would execute with an empty scope and then OVERWRITE the persisted scope on
    // exit (cold-start data loss). loadCurrent is safe pre-write (ensureSchema
    // created the table in the persistence ctor) and returns empty on a fresh DO.
    await mgr.hydrate();
    this.scopeManager = mgr;
    return mgr;
  }

  /** loadImport over the build service (same on-demand build surface as the in-app eval tool). */
  private makeLoadImport(): EvalImportLoader {
    // The eval sandbox runs in this workerd DO — resolve imports as a worker.
    return createEvalImportLoader(this.mainBuild(), "worker");
  }

  private async readSourceFile(path: string): Promise<string> {
    const contents = await this.mainFs().readFile(path, "utf8");
    if (typeof contents !== "string") {
      throw new Error(`fs.readFile returned non-text content for eval source file: ${path}`);
    }
    return contents;
  }

  /**
   * Build the portable runtime surface once, via the ONE shared
   * `createHostedRuntime` — identical to panel/worker. `import { … } from
   * "@workspace/runtime"` resolves to `rt` (seeded into the per-object module
   * map). `host.rpc` is the real `createRpcClient` (so `vcs.subscribeHead` /
   * `workspace.units.watch` receive server→DO pushes), and `panelRuntime` is
   * fed the real `rpc.on` (no `()=>()=>{}` no-op).
   */
  private ensureHostedRuntime(contextId: string, gatewayToken?: string): WorkspaceRuntime {
    // Owner-scoped gateway token from the eval service (Finding 4 hardening); the
    // env `RPC_AUTH_TOKEN` (shared internal-DO service bearer) is only a fallback
    // for direct/internal calls. gatewayFetch is `relativeOnly` so the bearer
    // never reaches a non-gateway host (eval code is prompt-injectable).
    const token = gatewayToken ?? String(this.env["RPC_AUTH_TOKEN"] ?? "");
    if (this.hostedRuntime) {
      const prev = this.hostedRuntimeIdentity;
      if (prev && (prev.contextId !== contextId || prev.gatewayToken !== token)) {
        throw new Error(
          `eval: hosted-runtime identity drift — this EvalDO was initialized with contextId=${prev.contextId} but a run requested contextId=${contextId}` +
            (prev.gatewayToken === token ? "" : " (and a different gateway token)") +
            `. A warm EvalDO serves one owner; this indicates a routing/ownership bug.`
        );
      }
      return this.hostedRuntime;
    }
    const rpc = this.rpc;
    const gatewayConfig = {
      serverUrl: String(this.env["GATEWAY_URL"] ?? ""),
      token,
    };
    const panelRuntime = createPanelRuntime({
      rpc,
      selfHandle: () => createRuntimeSelfHandle({ id: this.rpcSelfId }),
      // A panel openPanel()'d without an explicit parentId defaults to the eval owner's nearest panel
      // ancestor (server-resolved into this.parentMeta), so an agent/eval launch nests UNDER its owning
      // panel — parity with a panel, which defaults to its own id. A function (not a value) because the
      // runtime is cached while parentMeta is set/re-resolved per run — read live, like resolveParent.
      defaultOpenParentId: () => this.parentMeta?.parentId ?? null,
    }) as PanelRuntimeApi;
    const host: RuntimeHost = {
      id: this.rpcSelfId,
      contextId,
      rpc,
      fs: createRpcFs(rpc),
      gatewayConfig,
      gatewayFetch: createGatewayFetch({ ...gatewayConfig, relativeOnly: true }),
      panelRuntime,
      workers: createWorkerdClient(rpc),
      openExternal: (url, options) => this.mainExternalOpen().openExternal(url, options),
      // The owner's nearest panel ancestor (server-supplied via RunArgs.parent →
      // this.parentMeta). Read live so the cached host reflects a re-resolved
      // parent. null when the owner has no panel ancestor.
      resolveParent: () =>
        this.parentMeta
          ? createRuntimeParentHandle(
              (pid) => panelRuntime.getPanelHandle(pid),
              this.parentMeta.parentId,
              this.parentMeta.parentEntityId,
              this.parentMeta.parentKind
            )
          : null,
    };
    const rt = createHostedRuntime(host);
    this.moduleMap["@workspace/runtime"] = rt;
    this.hostedRuntime = rt;
    this.hostedRuntimeIdentity = { contextId, gatewayToken: token };
    return rt;
  }

  /**
   * Make `@workspace/cdp-client` importable in eval (full CDP commands+events
   * from a connectionless DO). Loaded via the build service like the engine —
   * robust to the internal-DO bundle's module resolution — and cached in the
   * shared isolate map (the client is stateless, so cross-owner sharing is safe,
   * unlike per-owner user imports).
   */
  /**
   * Conservative check: does this run reference CDP at all? Used to gate the
   * (cold-path) cdp-client build. Any route to the client contains the substring
   * "cdp" — the `@workspace/cdp-client` import, `handle.cdp`, `CdpConnection`,
   * `getCdpEndpoint` — so a no-match means no CDP and a false positive only
   * restores the prior unconditional cost. Imports map values are checked too
   * (an explicit `{ "x": "@workspace/cdp-client" }` alias).
   */
  private referencesCdp(code: string, imports?: Record<string, string>): boolean {
    if (/cdp/i.test(code)) return true;
    if (imports && Object.values(imports).some((spec) => /cdp/i.test(spec))) return true;
    return false;
  }

  private async ensureCdpModule(): Promise<void> {
    if (this.cdpLoaded) return;
    const g = globalThis as GlobalBag;
    const globalMap = (g["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
    if (!globalMap["@workspace/cdp-client"]) {
      const built = await this.mainBuild().getBuild("@workspace/cdp-client", undefined, {
        library: true,
        externals: Object.keys(globalMap),
        libraryTarget: "worker",
      });
      const bundle = requireBuildBundleResult(
        built,
        "EvalDO: build.getBuild did not return a library bundle for @workspace/cdp-client"
      );
      const compile = g["__natstackCompileFunction__"] as (
        a: string[],
        b: string
      ) => (...args: unknown[]) => unknown;
      const exports: Record<string, unknown> = {};
      const module = { exports };
      const fn = compile(["require", "exports", "module"], bundle);
      fn(g["__natstackRequire__"], exports, module);
      globalMap["@workspace/cdp-client"] = module.exports;
    }
    const loaded = globalMap["@workspace/cdp-client"] as { CdpConnection?: unknown } | undefined;
    if (typeof loaded?.CdpConnection !== "function") {
      // The default (".") library entry is index.ts, which re-exports BOTH
      // `CdpConnection` (worker.ts, for `import {CdpConnection}`) and `BrowserImpl`
      // (browser.ts, for `handle.cdp.lightweightPage()` via loadLightweightClient).
      // A missing CdpConnection means the build resolved the wrong entry.
      throw new Error(
        "EvalDO: @workspace/cdp-client did not expose CdpConnection (wrong build entry?)"
      );
    }
    // Seed BOTH maps: the per-object map backs `import {…} from "@workspace/cdp-client"`
    // (engine resolution); the global map backs `handle.cdp`'s `loadLightweightClient`,
    // which resolves via the global `__natstackRequire__`.
    this.moduleMap["@workspace/cdp-client"] = globalMap["@workspace/cdp-client"];
    this.cdpLoaded = true;
  }

  /** Synchronous in-DO SQLite, with reserved-table guards enforced on every statement. */
  private dbBinding(): unknown {
    const sql = this.sql;
    const guard = (query: string) => {
      if (DESTRUCTIVE_STMT.test(query) && RESERVED_TABLE.test(query.replace(/["'`]/g, ""))) {
        throw new Error(
          "db: refusing to modify a reserved table (state / repl_scopes / sqlite_*). Use your own table names."
        );
      }
    };
    return {
      exec(query: string, ...bindings: unknown[]): unknown[] {
        guard(query);
        return sql.exec(query, ...bindings).toArray();
      },
      run(query: string, ...bindings: unknown[]): void {
        guard(query);
        sql.exec(query, ...bindings);
      },
    };
  }
}
