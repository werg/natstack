/**
 * WorkerdManager — Process lifecycle for workerd (Cloudflare V8 isolate runtime).
 *
 * Manages:
 * - Locating the workerd binary
 * - Worker instance lifecycle (create, update, destroy)
 * - Context/token provisioning per instance
 * - Cap'n Proto text config generation with auto-generated router worker
 * - workerd child process management (start, restart, stop)
 */

import { spawn, type ChildProcess } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { FsService } from "@natstack/shared/fsService";
import type { BuildResult } from "./buildV2/buildStore.js";
import type { RouteRegistry, ManifestRouteDecl } from "./routeRegistry.js";
import type {
  BypassRegistry,
  EgressProxy,
  WorkerTokenStore,
} from "./services/egressProxy.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerdManager");

/**
 * Replicate workerd's idFromName() → SQLite filename derivation.
 *
 * workerd derives DO storage filenames as:
 *   1. key = SHA-256(uniqueKey)         — 32 bytes
 *   2. base = HMAC-SHA256(key, name)    — truncate to first 16 bytes
 *   3. mac = HMAC-SHA256(key, base)     — truncate to first 16 bytes
 *   4. filename = hex(base || mac)      — 64 hex chars
 *
 * Verified against workerd source (actor-id-impl.c++) and empirically
 * tested against actual workerd DO storage files.
 */
function computeWorkerdObjectIdHash(uniqueKey: string, objectName: string): string {
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const base = crypto.createHmac("sha256", key).update(objectName).digest().subarray(0, 16);
  const mac = crypto.createHmac("sha256", key).update(base).digest().subarray(0, 16);
  return Buffer.concat([base, mac]).toString("hex");
}

/** DO reference — matches DORef from @workspace/runtime/worker. */
interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerBinding =
  | { type: "service"; worker: string }
  | { type: "text"; value: string }
  | { type: "json"; value: unknown };

export interface WorkerCreateOptions {
  source: string;
  contextId: string;
  name?: string;
  env?: Record<string, string>;
  bindings?: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  /** Build at a specific git ref (branch, tag, or commit SHA).
   *  Use a commit SHA for immutable pinning (content-addressed cache guarantees same build). */
  ref?: string;
  /** ID of the creating caller (panel, worker, DO). Used for parent handle support. */
  parentId?: string;
}

export interface WorkerInstance {
  name: string;
  source: string;
  contextId: string;
  callerId: string;
  token: string;
  env: Record<string, string>;
  bindings: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  buildKey?: string;
  /** Git ref this instance is built at (branch, tag, or commit SHA). */
  ref?: string;
  /** ID of the parent panel that created this worker (for parent handle support). */
  parentId?: string;
  status: "building" | "starting" | "running" | "stopped" | "error";
}

export interface WorkerdManagerDeps {
  tokenManager: TokenManager;
  fsService: FsService;
  /**
   * URL workers use to reach the server's RPC endpoint via HTTP POST.
   * Always points at an in-process loopback HTTP listener — workers are
   * spawned on the same host as the server, so the back-channel never
   * leaves the box. External panel/mobile traffic uses the TLS gateway;
   * this URL is deliberately distinct from it.
   */
  getServerUrl: () => string;
  getBuild: (unitPath: string, ref?: string) => Promise<BuildResult>;
  /** Workspace source root — used for WORKER_SOURCE binding. */
  workspacePath: string;
  /** State directory — used for DO storage (localDisk). */
  statePath: string;
  /** Route registry for `/_r/` dispatch — optional; when absent, route
   *  registration is a no-op and routes in package manifests have no effect. */
  routeRegistry?: RouteRegistry;
  /** Manifest-route lookup, keyed by source. Used alongside routeRegistry. */
  getManifestRoutes?: (source: string) => ManifestRouteDecl[];
  /**
   * STRICT-MODE egress wiring (audit-05 S1 + S2):
   *
   * Factory that builds an `EgressProxy` instance, given the per-worker
   * token registry and the optional bypass list. WorkerdManager owns the
   * lifecycle: it calls `start()` on first config-generation (so the
   * loopback port is known before workerd spawns), passes the resulting
   * `127.0.0.1:<port>` address to every worker / DO service as
   * `globalOutbound` via an `external` HTTP-proxy service, and calls
   * `stop()` on shutdown.
   *
   * When omitted, workers fall back to the legacy `network` service
   * with `allow: ["public", "local"]` — ONLY intended for tests and
   * early-boot scenarios where the credential infrastructure isn't up
   * yet. Production deployments MUST provide this factory.
   */
  buildEgressProxy?: (
    tokenStore: WorkerTokenStore,
    bypassRegistry: BypassRegistry,
  ) => EgressProxy;
  /**
   * Optional explicit list of worker IDs that bypass strict-mode
   * provider gating. Defaults to parsing `STRICT_EGRESS_BYPASS_WORKERS`
   * (comma-separated). See `docs/audit/wave3-egress-migration.md`.
   */
  bypassWorkerIds?: ReadonlyArray<string>;
}

/** The canonical regular-worker instance name for a source. Matches the
 *  sanitization that createRegularInstance applies to rawName. */
function canonicalInstanceNameForSource(source: string): string {
  const raw = source.split("/").pop() ?? "worker";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// WorkerdManager
// ---------------------------------------------------------------------------

export class WorkerdManager {
  private instances = new Map<string, WorkerInstance>();
  private process: ChildProcess | null = null;
  private configDir: string;
  private port: number | null = null;
  private deps: WorkerdManagerDeps;
  private workerdBinary: string | null = null;

  // DO support: shared services (one per source)
  /** Shared DO services — keyed by `${source}:${className}`. Source-scoped: two workers CAN have same className if different source. */
  private doServices = new Map<string, { buildKey: string; className: string; serviceName: string; source: string }>();

  /**
   * STRICT-MODE egress proxy instance (audit-05 S1).
   *
   * Constructed lazily on first config-generation via
   * `deps.buildEgressProxy(...)`. WorkerdManager:
   *   - mints + tracks per-worker `PROXY_AUTH_TOKEN`s in `proxyAuthTokens`,
   *   - exposes them through a `WorkerTokenStore` to the proxy,
   *   - applies the bypass set parsed from `STRICT_EGRESS_BYPASS_WORKERS`
   *     (or `deps.bypassWorkerIds`),
   *   - starts the proxy on a loopback ephemeral port,
   *   - emits an `external` workerd service on `127.0.0.1:<egressPort>`
   *     as `globalOutbound` for every worker / DO,
   *   - stops the proxy on shutdown.
   */
  private egressProxy: EgressProxy | null = null;
  private egressProxyAddress: string | null = null;
  private bypassWorkerIdSet: ReadonlySet<string>;

  /**
   * Per-worker / per-DO-service proxy auth tokens. Key is the value
   * injected as `X-NatStack-Worker-Id` by the workerd runtime:
   *   - regular worker: instance.name (see `generateConfig`).
   *   - DO service: `do-service:${source}:${className}` (see
   *     `generateConfig`'s DO branch).
   *
   * Value is the `PROXY_AUTH_TOKEN` bound into that worker's env.
   * `EgressProxy` looks this map up via `workerTokenStore.getToken(...)`
   * to validate inbound proxy requests (audit-05 S1 / finding #11).
   *
   * Tokens are minted on first config generation and kept stable for
   * the lifetime of the worker / DO service so workerd can continue
   * using them across config regenerations without re-propagating a
   * rotated secret.
   */
  private proxyAuthTokens = new Map<string, string>();
  /** Session ID — generated once per WorkerdManager lifetime, used for restart detection in bootstrap. */
  private sessionId = crypto.randomUUID();
  /**
   * Per-process dispatch secret. Bound into the auto-generated router
   * worker as `DISPATCH_SECRET` and verified when callers provide
   * `X-NatStack-Dispatch-Secret` on `/_w/` requests.
   *
   * This closes audit finding 4.8: the workerd HTTP port is loopback-bound
   * (see `address` in generateConfig) but any *local* process running as
   * the user could otherwise POST to the DO router and forge a dispatch.
   * Public gateway-routed DO routes cannot rely on this process-private
   * header, so absence is allowed for DX; stale/wrong internal dispatch
   * headers are rejected. The matching helper for server-side dispatch is
   * `DODispatch.setGetDispatchSecret`.
   *
   * Generated once per WorkerdManager lifetime — rotates on server restart.
   */
  private dispatchSecret = crypto.randomBytes(32).toString("base64url");

  constructor(deps: WorkerdManagerDeps) {
    this.deps = deps;
    this.configDir = path.join(os.tmpdir(), `natstack-workerd-${process.pid}`);
    fs.mkdirSync(this.configDir, { recursive: true });

    // Parse STRICT_EGRESS_BYPASS_WORKERS (comma-separated worker ids).
    // The env var is the only "documented escape hatch" for migration —
    // see docs/audit/wave3-egress-migration.md. Every bypass use is logged
    // by the EgressProxy on each request from a bypassed worker.
    const fromEnv = (process.env["STRICT_EGRESS_BYPASS_WORKERS"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const fromDeps = deps.bypassWorkerIds ?? [];
    this.bypassWorkerIdSet = new Set([...fromEnv, ...fromDeps]);
    if (this.bypassWorkerIdSet.size > 0) {
      log.warn(
        `[WorkerdManager] STRICT_EGRESS_BYPASS_WORKERS active for: ` +
          Array.from(this.bypassWorkerIdSet).join(", "),
      );
    }
  }

  // =========================================================================
  // Binary resolution
  // =========================================================================

  private findWorkerdBinary(): string {
    if (this.workerdBinary) return this.workerdBinary;

    // Try node_modules/.bin/workerd first
    const candidates = [
      path.join(process.cwd(), "node_modules", ".bin", "workerd"),
      path.join(__dirname, "..", "..", "node_modules", ".bin", "workerd"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        this.workerdBinary = candidate;
        return candidate;
      }
    }

    // Fall back to PATH
    this.workerdBinary = "workerd";
    return "workerd";
  }

  // =========================================================================
  // Instance management
  // =========================================================================

  async createInstance(options: WorkerCreateOptions): Promise<WorkerInstance> {
    return this.createRegularInstance(options);
  }

  // ── Regular (non-durable) worker creation ──

  private async createRegularInstance(options: WorkerCreateOptions): Promise<WorkerInstance> {
    const rawName = options.name ?? options.source.split("/").pop() ?? "worker";
    // Sanitize name — used in generated JS router code and workerd config keys
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (this.instances.has(name)) {
      throw new Error(`Worker instance "${name}" already exists`);
    }

    const callerId = `worker:${name}`;
    const contextId = options.contextId;

    // Create auth token
    const token = this.deps.tokenManager.ensureToken(callerId, "worker");

    // Register context with FsService
    this.deps.fsService.registerCallerContext(callerId, contextId);

    const instance: WorkerInstance = {
      name,
      source: options.source,
      contextId,
      callerId,
      token,
      env: options.env ?? {},
      bindings: options.bindings ?? {},
      stateArgs: options.stateArgs,
      ref: options.ref,
      parentId: options.parentId,
      status: "building",
    };

    this.instances.set(name, instance);

    // Trigger build
    try {
      const buildResult = await this.deps.getBuild(options.source, options.ref);
      instance.buildKey = buildResult.metadata.ev;
      instance.status = "starting";

      // Restart workerd process with updated config
      await this.restartWorkerd();

      instance.status = "running";
      log.info(`Worker instance "${name}" started (source: ${options.source})`);

      // Register regular-worker routes only for the canonical-named instance.
      // Non-canonical instances of the same source don't shadow routes.
      if (this.deps.routeRegistry && this.deps.getManifestRoutes) {
        const canonical = canonicalInstanceNameForSource(options.source);
        if (name === canonical) {
          const routes = this.deps.getManifestRoutes(options.source);
          if (routes.length > 0) {
            this.deps.routeRegistry.registerWorkerRoutes(
              options.source,
              name,
              routes,
            );
          }
        }
      }
    } catch (error) {
      // Rollback: clean up token, context registration, and instance map entry
      instance.status = "error";
      this.instances.delete(name);
      this.deps.tokenManager.revokeToken(callerId);
      this.deps.fsService.unregisterCallerContext(callerId);
      this.proxyAuthTokens.delete(name);
      log.error(`Failed to start worker "${name}":`, error);
      throw error;
    }

    return instance;
  }

  async destroyInstance(name: string): Promise<void> {
    const instance = this.instances.get(name);
    if (!instance) {
      throw new Error(`Worker instance "${name}" not found`);
    }

    // Cleanup
    this.deps.tokenManager.revokeToken(instance.callerId);
    this.deps.fsService.unregisterCallerContext(instance.callerId);
    this.deps.fsService.closeHandlesForCaller(instance.callerId);
    this.proxyAuthTokens.delete(instance.name);
    this.instances.delete(name);

    // Unregister regular-worker routes if this was the canonical instance.
    if (this.deps.routeRegistry) {
      const canonical = canonicalInstanceNameForSource(instance.source);
      if (instance.name === canonical) {
        this.deps.routeRegistry.unregisterWorkerRoutes(instance.source);
      }
    }

    instance.status = "stopped";

    // Restart workerd if there are remaining instances or DO services
    if (this.instances.size > 0 || this.doServices.size > 0) {
      await this.restartWorkerd();
    } else {
      this.stopWorkerd();
    }

    log.info(`Worker instance "${name}" destroyed`);
  }

  async updateInstance(name: string, updates: Partial<WorkerCreateOptions>): Promise<WorkerInstance> {
    const instance = this.instances.get(name);
    if (!instance) {
      throw new Error(`Worker instance "${name}" not found`);
    }

    if (updates.env) instance.env = updates.env;
    if (updates.bindings) instance.bindings = updates.bindings;
    if (updates.stateArgs !== undefined) instance.stateArgs = updates.stateArgs;
    if (updates.ref !== undefined) instance.ref = updates.ref || undefined;

    // Restart workerd with new config
    await this.restartWorkerd();

    log.info(`Worker instance "${name}" updated`);
    return instance;
  }

  listInstances(): Omit<WorkerInstance, "token">[] {
    return Array.from(this.instances.values()).map(({ token: _token, ...rest }) => rest);
  }

  getInstanceStatus(name: string): Omit<WorkerInstance, "token"> | null {
    const instance = this.instances.get(name);
    if (!instance) return null;
    const { token: _token, ...rest } = instance;
    return rest;
  }

  getPort(): number | null {
    return this.port;
  }

  /**
   * Return the per-process dispatch secret used by `DODispatch` (via
   * `setGetDispatchSecret`) to stamp outgoing dispatches. The router verifies
   * this header when present, but does not require it for public DO routes.
   */
  getDispatchSecret(): string {
    return this.dispatchSecret;
  }

  /**
   * Look up the `PROXY_AUTH_TOKEN` registered for a worker id or
   * DO-service key. The `EgressProxy.WorkerTokenStore.getToken` hook
   * delegates to this — every inbound proxy request carrying
   * `X-NatStack-Worker-Id: <id>` must produce a matching bearer token
   * that equals the value returned here, or the proxy rejects with 401.
   *
   * Returns `null` for unknown ids (strict by default — closes audit
   * finding #11: proxy auth was never validated, so any loopback
   * process could forge worker identity).
   */
  getProxyToken(workerId: string): string | null {
    return this.proxyAuthTokens.get(workerId) ?? null;
  }

  /** Mint-on-first-use helper — stable for the lifetime of the key. */
  private ensureProxyToken(workerId: string): string {
    let token = this.proxyAuthTokens.get(workerId);
    if (!token) {
      token = crypto.randomBytes(24).toString("base64url");
      this.proxyAuthTokens.set(workerId, token);
    }
    return token;
  }

  // =========================================================================
  // Strict-mode egress proxy lifecycle
  // =========================================================================

  /**
   * Lazily construct and start the EgressProxy on a loopback ephemeral
   * port. Idempotent — once the address is captured, subsequent calls
   * are no-ops. The address is read by `buildOutboundService` at config
   * generation time.
   *
   * No-op when the dependency is omitted (test / early-boot mode); in
   * that case workers fall back to the legacy `network` service.
   */
  private async ensureEgressProxyStarted(): Promise<void> {
    if (this.egressProxyAddress) return;
    if (!this.deps.buildEgressProxy) return;

    const tokenStore: WorkerTokenStore = {
      getToken: (workerId) => this.proxyAuthTokens.get(workerId) ?? null,
    };
    const bypassRegistry: BypassRegistry = {
      has: (workerId) => this.bypassWorkerIdSet.has(workerId),
    };

    const proxy = this.deps.buildEgressProxy(tokenStore, bypassRegistry);
    const port = await proxy.start();
    this.egressProxy = proxy;
    this.egressProxyAddress = `127.0.0.1:${port}`;
    log.info(`[WorkerdManager] EgressProxy listening on ${this.egressProxyAddress} (strict mode)`);
  }

  // =========================================================================
  // Config generation
  // =========================================================================

  /**
   * Build the per-worker outbound service that workerd will use as
   * `globalOutbound` for one worker / DO.
   *
   * STRICT MODE (when the EgressProxy has bound a loopback address):
   *   Emits an `external` service pointing at the EgressProxy with
   *   `http: { style = proxy }`. Workerd treats this as an HTTP forward
   *   proxy: every `fetch(...)` becomes an HTTP request with a full URL
   *   in the request line directed to the proxy. For HTTPS targets,
   *   workerd issues a CONNECT through the same proxy (which is why
   *   `EgressProxy.handleConnect` is hardened separately — see audit S2).
   *
   *   The proxy authenticates the worker via two headers stamped onto
   *   every outbound request by the workerd binding. Workerd does not
   *   itself stamp these — the worker code does, by injecting the
   *   `PROXY_WORKER_ID` and `PROXY_AUTH_TOKEN` env bindings into the
   *   `Authorization` and `X-NatStack-Worker-Id` headers (see runtime
   *   helper). Lacking those headers, the proxy returns 401 / 407.
   *
   * FALLBACK (when no proxy address): emits the legacy `network` service
   * with `allow: ["public", "local"]`. ONLY intended for tests / early
   * boot where the proxy hasn't started.
   */
  private buildOutboundService(
    serviceName: string,
    _workerId: string,
    _proxyAuthToken: string,
  ): object {
    const proxyAddr = this.egressProxyAddress;
    if (proxyAddr) {
      return {
        name: serviceName,
        external: {
          address: proxyAddr,
          http: {
            // `style = proxy` makes workerd emit the request line with a
            // full URL (`GET https://api.example.com/foo HTTP/1.1`) and
            // issue CONNECT for HTTPS targets — i.e. behave as a normal
            // HTTP forward-proxy client.
            style: "proxy",
          },
        },
      };
    }

    // Fallback for test mode / early boot: legacy `network` service.
    return {
      name: serviceName,
      network: {
        allow: ["public", "local"],
        deny: [],
        tlsOptions: { trustBrowserCas: true },
      },
    };
  }

  private async generateConfig(): Promise<object> {
    const services: object[] = [];
    const instanceNames: string[] = [];

    // Collect DO service names that have been emitted (to avoid duplicating in regular loop)
    const doServiceNames = new Set<string>();

    // ── DO services (one workerd service per source:className) ──
    for (const [serviceKey, doService] of this.doServices) {
      const { className } = doService;
      let bundleContent: string;
      try {
        const buildResult = await this.deps.getBuild(doService.source);
        bundleContent = buildResult.bundle;
      } catch (err) {
        log.warn(`Skipping DO service "${serviceKey}" — build not available:`, err);
        continue;
      }

      doServiceNames.add(doService.serviceName);

      // Service-level auth token — shared by all DO instances of this source:className.
      // Created once when the service is first built, revoked only when the last instance is destroyed.
      // NOT tied to any individual instance's lifecycle.
      const serviceCallerId = `do-service:${serviceKey}`;
      const serviceToken = this.deps.tokenManager.ensureToken(serviceCallerId, "worker");

      // STRICT-MODE egress: per-worker proxy auth token (audit-05 S1).
      // The worker id the EgressProxy authenticates against is
      // `do-service:${serviceKey}`; this token is stable across restarts.
      const doWorkerId = `do-service:${serviceKey}`;
      const doProxyAuthToken = this.ensureProxyToken(doWorkerId);
      const bindings: object[] = [
        { name: "RPC_AUTH_TOKEN", text: serviceToken },
        { name: "PROXY_AUTH_TOKEN", text: doProxyAuthToken },
        { name: "PROXY_WORKER_ID", text: doWorkerId },
        // Source-scoped class identity
        { name: "WORKER_SOURCE", text: doService.source },
        { name: "WORKER_CLASS_NAME", text: className },
        // Session ID for restart detection (changes on each WorkerdManager lifetime)
        { name: "WORKERD_SESSION_ID", text: this.sessionId },
      ];

      // Server URL for RPC bridge (DOs use HttpRpcBridge via POST /rpc)
      bindings.push({ name: "SERVER_URL", text: this.deps.getServerUrl() });

      // DO storage: create a disk service and reference it by name
      const diskServiceName = `${doService.serviceName}_disk`;
      const doStoragePath = path.join(this.deps.statePath, ".databases", "workerd-do");
      fs.mkdirSync(doStoragePath, { recursive: true });

      // STRICT-MODE egress (audit-05 S1): every DO routes outbound through
      // the EgressProxy via an `external` service with HTTP `style = proxy`.
      // The fall-back `network` service (allow ["public", "local"]) is
      // ONLY emitted when no proxy address is configured (e.g. early-boot
      // or test mode); see `buildOutboundService` below.
      const networkServiceName = `${doService.serviceName}_egress`;

      const workerDef: Record<string, unknown> = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2025-12-01",
        // `nodejs_compat` gives worker DOs access to the Node-compatible
        // subset workerd ships (buffer, util, events, etc.). Required by
        // `@mariozechner/pi-agent-core` and the harness image / pi-ai code
        // paths that assume a Node-ish runtime.
        compatibilityFlags: ["nodejs_compat"],
        globalOutbound: networkServiceName,
        durableObjectNamespaces: [
          { className, uniqueKey: `${doService.source.replace(/\//g, "_")}:${className}`, enableSql: true },
        ],
        durableObjectStorage: {
          localDisk: diskServiceName,
        },
      };

      services.push({ name: doService.serviceName, worker: workerDef });
      services.push({ name: diskServiceName, disk: { path: doStoragePath, writable: true } });
      services.push(this.buildOutboundService(networkServiceName, doWorkerId, doProxyAuthToken));
    }

    // ── Regular (non-durable) worker services ──
    for (const [name, instance] of this.instances) {
      // Get the build for this instance (content-addressed — ref builds are cached).
      let bundleContent: string;
      try {
        const buildResult = await this.deps.getBuild(instance.source, instance.ref);
        bundleContent = buildResult.bundle;
      } catch (err) {
        log.warn(`Skipping worker "${name}" — build not available:`, err);
        continue;
      }

      instanceNames.push(name);

      // STRICT-MODE egress: stable per-worker proxy auth token (audit-05 S1).
      const proxyAuthToken = this.ensureProxyToken(instance.name);
      const bindings: object[] = [
        { name: "RPC_AUTH_TOKEN", text: instance.token },
        { name: "PROXY_AUTH_TOKEN", text: proxyAuthToken },
        { name: "PROXY_WORKER_ID", text: instance.name },
        { name: "WORKER_ID", text: instance.name },
        { name: "CONTEXT_ID", text: instance.contextId },
        { name: "SERVER_URL", text: this.deps.getServerUrl() },
      ];

      // Inject stateArgs as a JSON binding so workers can access initial state
      if (instance.stateArgs && Object.keys(instance.stateArgs).length > 0) {
        bindings.push({ name: "STATE_ARGS", json: JSON.stringify(instance.stateArgs) });
      }

      // Inject parent ID if provided (for parent handle support)
      if (instance.parentId) {
        bindings.push({ name: "PARENT_ID", text: instance.parentId });
      }

      // Add user-defined env as text bindings
      for (const [key, value] of Object.entries(instance.env)) {
        bindings.push({ name: key, text: value });
      }

      // Add typed bindings
      for (const [key, binding] of Object.entries(instance.bindings)) {
        switch (binding.type) {
          case "service":
            bindings.push({ name: key, service: { name: binding.worker } });
            break;
          case "text":
            bindings.push({ name: key, text: binding.value });
            break;
          case "json":
            bindings.push({ name: key, json: JSON.stringify(binding.value) });
            break;
        }
      }

      // STRICT-MODE egress: per-worker outbound goes through the
      // EgressProxy as `globalOutbound`. See `buildOutboundService`.
      const networkServiceName = `${name}_egress`;

      // Build workerd service config.
      //
      // workerd's open-source config schema has no per-worker resource-limits
      // field. If we want CPU/subrequest enforcement in this stack, it has to
      // happen above workerd (for example via AbortSignal-based request guards),
      // not in the generated worker config.
      const workerDef: {
        modules: object[];
        bindings: object[];
        compatibilityDate: string;
        globalOutbound?: string;
      } = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2024-01-01",
        globalOutbound: networkServiceName,
      };

      services.push({ name, worker: workerDef });
      services.push(this.buildOutboundService(networkServiceName, instance.name, proxyAuthToken));
    }

    // Collect DO class info for router generation (only those whose service was successfully built).
    // Each entry carries both the actual className (for workerd namespace binding) and the source
    // (for the /_w/ lookup key, so same-named classes from different sources don't collide).
    const doClassNames = Array.from(this.doServices.entries())
      .filter(([, svc]) => doServiceNames.has(svc.serviceName))
      .map(([, svc]) => ({ className: svc.className, source: svc.source, serviceName: svc.serviceName }));

    // Auto-generate router worker
    const hasAnyService = instanceNames.length > 0 || doClassNames.length > 0;
    if (hasAnyService) {
      const routerBindings: object[] = instanceNames.map((name) => ({
        name: `worker_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        service: { name },
      }));

      // Add DO namespace bindings for the router (durableObjectNamespace, not service).
      // Binding names are source-scoped to match the generated router lookup.
      for (const { className, source, serviceName } of doClassNames) {
        const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        routerBindings.push({
          name: bindingName,
          durableObjectNamespace: { className, serviceName },
        });
      }

      const routerCode = this.generateRouterCode(instanceNames, doClassNames);

      // Bind the per-process dispatch secret into the router worker. Public
      // DO routes do not require it, but internal callers that provide the
      // header must match this value.
      routerBindings.push({ name: "DISPATCH_SECRET", text: this.dispatchSecret });

      services.push({
        name: "router",
        worker: {
          modules: [{ name: "router.js", esModule: routerCode }],
          bindings: routerBindings,
          compatibilityDate: "2024-01-01",
        },
      });
    }

    // Find a port
    if (!this.port) {
      const { findServicePort } = await import("@natstack/port-utils");
      this.port = await findServicePort("workerd");
    }

    // Inject WORKERD_URL into DO services (needs port to be resolved)
    for (const svc of services) {
      const worker = (svc as Record<string, unknown>)["worker"] as Record<string, unknown> | undefined;
      if (worker?.["durableObjectNamespaces"]) {
        (worker["bindings"] as object[]).push(
          { name: "WORKERD_URL", text: `http://127.0.0.1:${this.port}` },
        );
      }
    }

    return {
      services,
      sockets: hasAnyService
        ? [{
            name: "http",
            // SECURITY (audit 4.8): bind to loopback only. Workers and DO
            // back-channel traffic never need to leave the host — workerd
            // is co-located with the gateway by construction. Binding to
            // `*:<port>` previously let any host on the network reach the
            // DO router with a forged dispatch.
            address: `127.0.0.1:${this.port}`,
            http: {},
            service: { name: "router" },
          }]
        : [],
    };
  }

  private generateRouterCode(
    instanceNames: string[],
    doClassNames: { className: string; source: string; serviceName: string }[] = [],
  ): string {
    const cases = instanceNames.map((name) => {
      const bindingName = `worker_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      return `    if (prefix === ${JSON.stringify(name)}) return env.${bindingName}.fetch(new Request(newUrl, request));`;
    });

    // Build DO lookup map: "source:className" → binding name.
    // The lookup key combines source + className so same-named classes from different sources
    // dispatch to different workerd services.
    const doLookupEntries = doClassNames.map(({ className, source }) => {
      const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const lookupKey = `${source}:${className}`;
      return `      ${JSON.stringify(lookupKey)}: env.${bindingName}`;
    });

    // Generate DO routing block for /_w/{source0}/{source1}/{className}/{objectKey}/{method...}
    // Source path is always exactly 2 segments (e.g., "workers/agent-worker")
    //
    // DX-preserving dispatch-secret check:
    // Internal DODispatch calls stamp X-NatStack-Dispatch-Secret. Public
    // gateway-routed DO routes and WebSocket upgrades do not need that
    // process-private header, so absence is allowed. If a caller does provide
    // the header, it must match; this catches stale/miswired internal callers
    // without breaking published /_w/ URLs.
    let doBlock = "";
    if (doClassNames.length > 0) {
      doBlock = `
    // /_w/{source0}/{source1}/{className}/{objectKey}/{...method} — source-scoped DO routes
    if (prefix === "_w") {
      const presented = request.headers.get("x-natstack-dispatch-secret") || "";
      const expected = env.DISPATCH_SECRET || "";
      if (presented) {
        if (!expected || presented.length !== expected.length) {
          return new Response(JSON.stringify({ error: "unauthorized: invalid dispatch secret" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        let diff = 0;
        for (let i = 0; i < expected.length; i++) {
          diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
        }
        if (diff !== 0) {
          return new Response(JSON.stringify({ error: "unauthorized: dispatch secret mismatch" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
      const source = parts[1] + "/" + parts[2];
      const doClass = parts[3] || "";
      const objectKey = parts[4] || "";
      const doRest = parts.slice(5);
      if (!doClass || !objectKey) {
        return new Response("Usage: /_w/{source0}/{source1}/{className}/{objectKey}/{method}", { status: 400 });
      }
      const doLookup = {
${doLookupEntries.join(",\n")}
      };
      const ns = doLookup[source + ":" + doClass];
      if (ns) {
        const id = ns.idFromName(objectKey);
        const stub = ns.get(id);
        const doUrl = new URL("/" + objectKey + (doRest.length ? "/" + doRest.join("/") : ""), url.origin);
        doUrl.search = url.search;
        return stub.fetch(new Request(doUrl, request));
      }
      return new Response("DO class not found: " + doClass + " (source: " + source + ")", { status: 404 });
    }
`;
    }

    return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const prefix = parts[0] || "";
    const rest = "/" + parts.slice(1).join("/");
    const newUrl = new URL(rest, url.origin);
    newUrl.search = url.search;
${doBlock}${cases.join("\n")}
    return new Response("Worker not found: " + prefix, { status: 404 });
  }
};
`;
  }

  // =========================================================================
  // Cap'n Proto text config generation
  // =========================================================================

  /**
   * Convert the JSON config object to Cap'n Proto text format.
   * Workerd's JSON config was removed; the native format is capnp text.
   * Bundle code is written to separate files and referenced via `embed`.
   */
  private toCapnpText(config: Record<string, unknown>): string {
    this.bundleFileCounter = 0;
    const body = this.capnpValue(config, 1);
    return `using Workerd = import "/workerd/workerd.capnp";\n\nconst config :Workerd.Config = ${body};\n`;
  }

  private bundleFileCounter = 0;

  private capnpValue(value: unknown, depth: number): string {
    if (value === null || value === undefined) return "void";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return String(value);
    if (typeof value === "string") {
      // Escape for Cap'n Proto text strings (same as JSON string escaping)
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const indent = "  ".repeat(depth);
      const items = value.map((v) => `${indent}${this.capnpValue(v, depth + 1)},`);
      return `[\n${items.join("\n")}\n${"  ".repeat(depth - 1)}]`;
    }

    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const entries = Object.entries(obj);
      if (entries.length === 0) return "()";

      const indent = "  ".repeat(depth);
      const fields = entries.map(([k, v]) => {
        // esModule bundles: write to file, reference via embed
        if (k === "esModule" && typeof v === "string") {
          const filename = `bundle-${this.bundleFileCounter++}.js`;
          fs.writeFileSync(path.join(this.configDir, filename), v);
          return `${indent}${k} = embed "${filename}",`;
        }
        return `${indent}${k} = ${this.capnpValue(v, depth + 1)},`;
      });
      return `(\n${fields.join("\n")}\n${"  ".repeat(depth - 1)})`;
    }

    return String(value);
  }

  // =========================================================================
  // Process lifecycle
  // =========================================================================

  private async restartWorkerd(): Promise<void> {
    await this.stopWorkerd();

    if (this.instances.size === 0 && this.doServices.size === 0) return;

    // STRICT-MODE egress: ensure the proxy is up BEFORE we generate the
    // workerd config — config generation reads `this.egressProxyAddress`
    // to wire each worker's `globalOutbound` to the proxy.
    await this.ensureEgressProxyStarted();

    const config = await this.generateConfig();
    const configPath = path.join(this.configDir, "config.capnp");
    const capnpText = this.toCapnpText(config as Record<string, unknown>);
    fs.writeFileSync(configPath, capnpText);

    const binary = this.findWorkerdBinary();

    this.process = spawn(binary, ["serve", configPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log.info(`[workerd] ${line}`);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log.warn(`[workerd] ${line}`);
    });

    // Wait for startup, detecting early failures (ENOENT, crash, etc.)
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onExit = (code: number | null, signal: string | null) => {
        log.info(`workerd exited (code=${code}, signal=${signal})`);
        this.process = null;
        if (!settled) {
          settled = true;
          reject(new Error(`workerd exited immediately (code=${code}, signal=${signal})`));
        }
      };

      const onError = (err: Error) => {
        log.error("workerd process error:", err);
        this.process = null;
        if (!settled) {
          settled = true;
          reject(new Error(`workerd failed to start: ${err.message}`));
        }
      };

      this.process!.on("exit", onExit);
      this.process!.on("error", onError);

      // If the process survives 500ms, consider it started
      setTimeout(() => {
        if (!settled) {
          settled = true;
          // Keep the exit/error handlers for ongoing monitoring, but replace
          // them with non-rejecting versions since the promise is settled
          this.process?.removeListener("exit", onExit);
          this.process?.removeListener("error", onError);
          this.process?.on("exit", (code, signal) => {
            log.info(`workerd exited (code=${code}, signal=${signal})`);
            this.process = null;
          });
          this.process?.on("error", (err) => {
            log.error("workerd process error:", err);
            this.process = null;
          });
          resolve();
        }
      }, 500);
    });

    log.info(`workerd started on port ${this.port} with ${this.instances.size} worker(s)`);
  }

  private async stopWorkerd(): Promise<void> {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      proc.kill("SIGTERM");
      // Wait for the process to exit so the port is released before respawn.
      // `proc.killed` only reports that a signal was *sent*, not that the
      // process actually died — so track exit observation explicitly.
      let exited = false;
      await new Promise<void>((resolve) => {
        const onExit = () => { exited = true; resolve(); };
        proc.once("exit", onExit);
        setTimeout(() => { proc.removeListener("exit", onExit); resolve(); }, 3000);
      });
      if (!exited) {
        // SIGTERM timed out — force reap so the socket can be reclaimed.
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        await new Promise<void>((resolve) => {
          const onExit = () => resolve();
          proc.once("exit", onExit);
          setTimeout(() => { proc.removeListener("exit", onExit); resolve(); }, 1000);
        });
      }
    }
    // Release the pinned port so restartWorkerd re-probes via findServicePort.
    // findServicePort skips EADDRINUSE ports, which sidesteps the race where
    // the kernel has not finished releasing our previous bind yet.
    this.port = null;
  }

  async restartAll(): Promise<void> {
    await this.restartWorkerd();
  }

  /**
   * Pre-register all DO classes discovered from the build graph.
   * Builds each source, registers the service, and does a single workerd restart.
   * Called at startup so all DO classes are available before any request arrives.
   */
  async registerAllDOClasses(
    doClasses: Array<{ source: string; className: string }>,
  ): Promise<void> {
    let added = false;
    for (const { source, className } of doClasses) {
      const serviceKey = `${source}:${className}`;
      if (this.doServices.has(serviceKey)) continue;

      const sourceSegments = source.split("/").filter(Boolean);
      if (sourceSegments.length !== 2) {
        log.warn(`Skipping DO class with invalid source path: "${source}"`);
        continue;
      }

      try {
        const buildResult = await this.deps.getBuild(source);
        const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
        const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        this.doServices.set(serviceKey, {
          buildKey: buildResult.metadata.ev,
          className,
          serviceName,
          source,
        });
        this.registerRoutesForDoClass(source, className);
        added = true;
      } catch (err) {
        log.warn(`Skipping DO class ${source}:${className} — build failed:`, err);
      }
    }

    if (added) {
      await this.restartWorkerd();
      log.info(`Pre-registered ${this.doServices.size} DO class(es)`);
    }
  }

  /** Register DO-backed routes from a source's manifest for the given class. */
  private registerRoutesForDoClass(source: string, className: string): void {
    if (!this.deps.routeRegistry || !this.deps.getManifestRoutes) return;
    const routes = this.deps.getManifestRoutes(source);
    if (routes.length === 0) return;
    this.deps.routeRegistry.registerDoRoutes(source, className, routes);
  }

  /**
   * Ensure a DO class is registered and workerd is running. Does NOT bootstrap any instance.
   * Use for infrastructure DOs (like PubSubChannel) that don't need DOIdentity.
   */
  async ensureDOClass(source: string, className: string): Promise<void> {
    const serviceKey = `${source}:${className}`;
    if (!this.doServices.has(serviceKey)) {
      const sourceSegments = source.split("/").filter(Boolean);
      if (sourceSegments.length !== 2) {
        throw new Error(`DO source path must be exactly 2 segments, got: "${source}"`);
      }
      const buildResult = await this.deps.getBuild(source);
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      this.doServices.set(serviceKey, {
        buildKey: buildResult.metadata.ev,
        className,
        serviceName,
        source,
      });
      this.registerRoutesForDoClass(source, className);
      await this.restartWorkerd();
    }

    if (!this.process || this.process.exitCode !== null) {
      await this.restartWorkerd();
    }
  }

  /**
   * Ensure a Durable Object class is registered and workerd is running.
   * DOs self-bootstrap from env bindings on first request — no external bootstrap call needed.
   * Used by the DODispatch retry path: when a dispatch fails with a retryable error
   * (DO class not registered, workerd restarted, ECONNREFUSED), DODispatch calls
   * this to (re-)register the class and restart workerd, then retries once.
   */
  async ensureDO(source: string, className: string, _objectKey: string): Promise<void> {
    await this.ensureDOClass(source, className);
  }

  // =========================================================================
  // DO cloning (filesystem-level SQLite copy)
  // =========================================================================

  /**
   * Clone a DO's SQLite storage to a new object key.
   * The cloned DO starts with identical state. Used for channel forking.
   */
  async cloneDO(ref: DORef, newObjectKey: string): Promise<DORef> {
    const uniqueKey = `${ref.source.replace(/\//g, "_")}:${ref.className}`;
    const storagePath = path.join(this.deps.statePath, ".databases", "workerd-do", uniqueKey);

    const sourceHash = computeWorkerdObjectIdHash(uniqueKey, ref.objectKey);
    const targetHash = computeWorkerdObjectIdHash(uniqueKey, newObjectKey);

    const sourceFile = path.join(storagePath, `${sourceHash}.sqlite`);
    const targetFile = path.join(storagePath, `${targetHash}.sqlite`);

    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Source DO storage not found: ${ref.className}/${ref.objectKey} (expected ${sourceFile})`);
    }
    fs.copyFileSync(sourceFile, targetFile);

    return { source: ref.source, className: ref.className, objectKey: newObjectKey };
  }

  /**
   * Destroy a DO's SQLite storage. Deletes the main .sqlite plus any
   * WAL/SHM sidecar files. Used for cleaning up orphaned clones on fork failure.
   */
  async destroyDO(ref: DORef): Promise<void> {
    const uniqueKey = `${ref.source.replace(/\//g, "_")}:${ref.className}`;
    const storagePath = path.join(this.deps.statePath, ".databases", "workerd-do", uniqueKey);
    const hash = computeWorkerdObjectIdHash(uniqueKey, ref.objectKey);
    const base = path.join(storagePath, hash);

    for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"]) {
      try { fs.unlinkSync(base + suffix); }
      catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdown(): Promise<void> {
    await this.stopWorkerd();

    // Cleanup all instances
    for (const [, instance] of this.instances) {
      this.deps.tokenManager.revokeToken(instance.callerId);
      this.deps.fsService.unregisterCallerContext(instance.callerId);
      this.deps.fsService.closeHandlesForCaller(instance.callerId);
    }
    this.instances.clear();

    // Cleanup DO tracking — revoke service-level tokens
    for (const [serviceKey] of this.doServices) {
      this.deps.tokenManager.revokeToken(`do-service:${serviceKey}`);
    }
    this.doServices.clear();

    // Drop all proxy-auth tokens — workers and DO services are gone.
    this.proxyAuthTokens.clear();

    // Stop the egress proxy if we started one. Best-effort.
    if (this.egressProxy) {
      try {
        await this.egressProxy.stop();
      } catch (err) {
        log.warn("[WorkerdManager] EgressProxy stop failed:", err);
      }
      this.egressProxy = null;
      this.egressProxyAddress = null;
    }

    // Clean up config dir
    try {
      fs.rmSync(this.configDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }

    log.info("WorkerdManager shut down");
  }

  /**
   * Called by push trigger when a worker source is rebuilt.
   * Restarts HEAD-tracking instances (no ref) running the given source.
   *
   * DO class reconciliation:
   *   - `doClasses === undefined`: caller doesn't know the current DO shape
   *     for this source, leave DO services untouched (legacy/conservative
   *     behavior).
   *   - `doClasses` is an explicit array (possibly empty): treat it as the
   *     authoritative current list. Classes in the list that aren't yet
   *     registered get registered; classes registered but missing from the
   *     list get torn down (service-level token revoked, entry removed from
   *     `doServices`, workerd restarted).
   *
   * This is what lets a manifest edit that DROPS a DO class actually remove
   * the stale workerd service on the next rebuild, rather than leaving an
   * orphaned class bound forever.
   */
  async onSourceRebuilt(source: string, doClasses?: Array<{ className: string }>): Promise<void> {
    let needsRestart = false;

    for (const instance of this.instances.values()) {
      // Only auto-restart workers tracking HEAD (no ref set)
      if (instance.source === source && !instance.ref) {
        instance.status = "starting";
        needsRestart = true;
      }
    }

    // Also check DO services tracking this source
    for (const [_serviceKey, doService] of this.doServices) {
      if (doService.source === source) {
        needsRestart = true;
      }
    }

    // Reconcile DO services for this source against the new manifest list.
    if (doClasses) {
      const newClassNames = new Set(doClasses.map((c) => c.className));

      // 1. Remove stale DO services: entries for this source whose className
      //    is no longer in the manifest.
      for (const [serviceKey, svc] of Array.from(this.doServices.entries())) {
        if (svc.source !== source) continue;
        if (newClassNames.has(svc.className)) continue;
        this.deps.tokenManager.revokeToken(`do-service:${serviceKey}`);
        this.proxyAuthTokens.delete(`do-service:${serviceKey}`);
        this.doServices.delete(serviceKey);
        this.deps.routeRegistry?.unregisterDoRoutes(source, svc.className);
        needsRestart = true;
        log.info(`Unregistered stale DO class ${serviceKey} after manifest change`);
      }

      // 2. Register newly-added DO classes.
      for (const { className } of doClasses) {
        const serviceKey = `${source}:${className}`;
        if (!this.doServices.has(serviceKey)) {
          try {
            const buildResult = await this.deps.getBuild(source);
            const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
            const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
            this.doServices.set(serviceKey, {
              buildKey: buildResult.metadata.ev,
              className,
              serviceName,
              source,
            });
            this.registerRoutesForDoClass(source, className);
            needsRestart = true;
            log.info(`Registered new DO class ${source}:${className} from push`);
          } catch (err) {
            log.warn(`Failed to register DO class ${source}:${className}:`, err);
          }
        }
      }
    }

    // Reconcile routes: manifest may have added, removed, or changed route
    // entries for this source. The registry is rebuilt from scratch for this
    // source using the current manifest + live DO classes + canonical instance.
    if (this.deps.routeRegistry && this.deps.getManifestRoutes) {
      const newRoutes = this.deps.getManifestRoutes(source);
      const liveDoClasses = new Set<string>();
      for (const svc of this.doServices.values()) {
        if (svc.source === source) liveDoClasses.add(svc.className);
      }
      const canonical = canonicalInstanceNameForSource(source);
      const hasCanonicalInstance = this.instances.has(canonical)
        && this.instances.get(canonical)!.source === source;
      this.deps.routeRegistry.reconcileWorkerRoutes(
        source,
        newRoutes,
        liveDoClasses,
        hasCanonicalInstance ? canonical : null,
      );
    }

    if (needsRestart) {
      log.info(`Restarting worker instances for rebuilt source: ${source}`);
      try {
        await this.restartWorkerd();
        for (const instance of this.instances.values()) {
          if (instance.source === source && !instance.ref && instance.status === "starting") {
            instance.status = "running";
          }
        }
      } catch (err) {
        log.error(`Failed to restart workers for ${source}:`, err);
        for (const instance of this.instances.values()) {
          if (instance.source === source && !instance.ref && instance.status === "starting") {
            instance.status = "error";
          }
        }
      }
    }
  }
}
