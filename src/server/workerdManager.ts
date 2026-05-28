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
import { createRequire } from "module";
import * as path from "path";
import * as os from "os";
import { pathToFileURL } from "url";
import type { TokenManager } from "@natstack/shared/tokenManager";
import { createVerifiedCaller, type VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { FsService } from "@natstack/shared/fsService";
import { canonicalEntityId } from "@natstack/shared/runtime/entitySpec";
import { primaryTextArtifactContent, type BuildResult } from "./buildV2/buildStore.js";
import type { RouteRegistry, ManifestRouteDecl } from "./routeRegistry.js";
import type { SingletonRegistry } from "@natstack/shared/workspace/singletonRegistry";
import { createDevLogger } from "@natstack/dev-log";
import {
  getPhysicalPathForAsarPath,
  getPlatformPackageBinaryPath,
} from "@natstack/shared/runtimePaths";
import { getInternalDOBundle, isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("WorkerdManager");
const DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS = 15_000;
const WORKERD_STARTUP_OUTPUT_LINES = 40;
declare const __filename: string | undefined;

// This file is bundled as both ESM (standalone server) and CJS (Electron
// utility process). build.mjs injects __filename into the ESM bundle, while
// CJS provides it natively. Avoid spelling import.meta here: esbuild warns
// whenever import.meta appears in CJS output, even behind typeof guards.
const requireFromUrl: string =
  typeof __filename !== "undefined" && __filename
    ? pathToFileURL(__filename).href
    : pathToFileURL(process.cwd() + "/").href;

const require = createRequire(requireFromUrl);

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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
  /** Parent panel/worker id injected into the runtime for getParent(). */
  parentId?: string;
  /** Parent runtime entity id, when the display/control id differs from the RPC id. */
  parentEntityId?: string;
  /** Parent runtime kind for constructing the correct unified handle shape. */
  parentKind?: "panel" | "worker" | "do";
  env?: Record<string, string>;
  bindings?: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  /** Build at a specific git ref (branch, tag, or commit SHA).
   *  Use a commit SHA for immutable pinning (content-addressed cache guarantees same build). */
  ref?: string;
}

export interface WorkerInstance {
  name: string;
  source: string;
  contextId: string;
  callerId: string;
  parentId?: string;
  parentEntityId?: string;
  parentKind?: "panel" | "worker" | "do";
  token: string;
  env: Record<string, string>;
  bindings: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  buildKey?: string;
  /** Git ref this instance is built at (branch, tag, or commit SHA). */
  ref?: string;
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
  /** Additional externally advertised gateway URLs that map to this server. */
  getServerAliasUrls?: () => readonly string[];
  getBuild: (unitPath: string, ref?: string) => Promise<BuildResult>;
  /** Workspace source root — used for WORKER_SOURCE binding. */
  workspacePath: string;
  /** State directory — used for DO storage (localDisk). */
  statePath: string;
  /** Route registry for `/_r/` dispatch — optional; when absent, route
   *  registration is a no-op and routes in package manifests have no effect. */
  routeRegistry?: RouteRegistry;
  /** Manifest-route lookup, keyed by source. Used alongside routeRegistry. */
  getManifestRoutes?: (source: string) => ReadonlyArray<ManifestRouteDecl>;
  /** Singleton registry — joins routes' (source,className) to object keys. */
  singletonRegistry?: SingletonRegistry;
  getProxyPort: (caller: VerifiedCaller) => Promise<number | null> | number | null;
  getWorkerdGatewayToken: () => string;
  /** Override for tests; production uses the default router readiness window. */
  workerdStartupReadyTimeoutMs?: number;
  cleanupWebhookSubscriptions?: (callerId: string) => Promise<void>;
}

type ResolvedWorkerdManagerDeps = WorkerdManagerDeps;

/** The canonical regular-worker instance name for a source. Matches the
 *  sanitization that createRegularInstance applies to rawName. */
function canonicalInstanceNameForSource(source: string): string {
  const raw = source.split("/").pop() ?? "worker";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function workerdInspectorEnabled(): boolean {
  return process.env["NATSTACK_PROD"] !== "1" && process.env["NODE_ENV"] !== "production";
}

// ---------------------------------------------------------------------------
// WorkerdManager
// ---------------------------------------------------------------------------

export class WorkerdManager {
  private instances = new Map<string, WorkerInstance>();
  private process: ChildProcess | null = null;
  private configDir: string;
  private port: number | null = null;
  private inspectorPort: number | null = null;
  private deps: ResolvedWorkerdManagerDeps;
  private workerdBinary: string | null = null;
  private lastWorkerdStartupOutput: string[] = [];

  // DO support: shared services (one per source)
  /** Shared DO services — keyed by `${source}:${className}`. Source-scoped: two workers CAN have same className if different source. */
  private doServices = new Map<
    string,
    { buildKey: string; className: string; serviceName: string; source: string }
  >();
  /** Session ID — generated once per WorkerdManager lifetime, used for restart detection in bootstrap. */
  private sessionId = crypto.randomUUID();
  /** Per-manager secret required by the generated router for direct DO dispatch. */
  private readonly dispatchSecret = crypto.randomBytes(32).toString("hex");

  constructor(deps: WorkerdManagerDeps) {
    this.deps = deps;
    this.configDir = path.join(os.tmpdir(), `natstack-workerd-${process.pid}`);
    fs.mkdirSync(this.configDir, { recursive: true });
  }

  private ensureWorkerBearer(callerId: string): string {
    const manager = this.deps.tokenManager as TokenManager & {
      ensureWorkerBearer?: (callerId: string) => string;
    };
    return manager.ensureWorkerBearer?.(callerId) ?? manager.ensureToken(callerId, "worker");
  }

  private revokeWorkerBearer(callerId: string): boolean {
    const manager = this.deps.tokenManager as TokenManager & {
      revokeWorkerBearer?: (callerId: string) => boolean;
    };
    return manager.revokeWorkerBearer?.(callerId) ?? manager.revokeToken(callerId);
  }

  // =========================================================================
  // Binary resolution
  // =========================================================================

  private findWorkerdBinary(): string {
    if (this.workerdBinary) return this.workerdBinary;

    const maybeExeExtension = process.platform === "win32" ? ".exe" : "";
    const platformPackages: Record<string, string> = {
      "darwin arm64 LE": "@cloudflare/workerd-darwin-arm64",
      "darwin x64 LE": "@cloudflare/workerd-darwin-64",
      "linux arm64 LE": "@cloudflare/workerd-linux-arm64",
      "linux x64 LE": "@cloudflare/workerd-linux-64",
      "win32 x64 LE": "@cloudflare/workerd-windows-64",
    };
    const platformKey = `${process.platform} ${os.arch()} ${os.endianness()}`;
    const platformPackage = platformPackages[platformKey];
    const appRoot = process.env["NATSTACK_APP_ROOT"];

    if (platformPackage && appRoot) {
      const packagedCandidate = getPlatformPackageBinaryPath(
        appRoot,
        platformPackage,
        `workerd${maybeExeExtension}`
      );
      if (fs.existsSync(packagedCandidate)) {
        this.workerdBinary = packagedCandidate;
        return packagedCandidate;
      }
    }

    if (platformPackage) {
      try {
        const resolved = require.resolve(`${platformPackage}/bin/workerd${maybeExeExtension}`);
        const physicalResolved = getPhysicalPathForAsarPath(resolved);
        this.workerdBinary = fs.existsSync(physicalResolved) ? physicalResolved : resolved;
        return this.workerdBinary;
      } catch {
        // Fall through to local candidate paths and PATH lookup below.
      }
    }

    // Avoid the `node_modules/.bin/workerd` shim: it shells out to the real
    // binary with execFileSync(), which leaves the actual child process outside
    // our process tree and breaks restart/shutdown determinism.
    const candidates = [
      path.join(
        process.cwd(),
        "node_modules",
        "@cloudflare",
        "workerd-linux-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        process.cwd(),
        "node_modules",
        "@cloudflare",
        "workerd-linux-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        process.cwd(),
        "node_modules",
        "@cloudflare",
        "workerd-darwin-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        process.cwd(),
        "node_modules",
        "@cloudflare",
        "workerd-darwin-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        process.cwd(),
        "node_modules",
        "@cloudflare",
        "workerd-windows-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        __dirname,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-linux-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        __dirname,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-linux-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        __dirname,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-darwin-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        __dirname,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-darwin-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        __dirname,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-windows-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
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

  /**
   * Ensure a DO class is registered with workerd and return the targetId +
   * effectiveVersion that the runtime service will record on the entity row.
   *
   * Does NOT write an entity row — that's runtimeService.createEntity's job.
   */
  async ensureDurableObjectEntity(args: {
    source: string;
    ref?: string;
    className: string;
    key: string;
    contextId: string;
  }): Promise<{ targetId: string; effectiveVersion: string }> {
    await this.ensureDOClass(args.source, args.className);
    const serviceKey = `${args.source}:${args.className}`;
    const svc = this.doServices.get(serviceKey);
    if (!svc) {
      throw new Error(
        `ensureDurableObjectEntity: DO class ${serviceKey} missing from doServices after ensureDOClass`
      );
    }
    const targetId = canonicalEntityId({
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
    });
    return { targetId, effectiveVersion: svc.buildKey };
  }

  /**
   * Bring up a worker process for an entity managed by the runtime service.
   *
   * Wraps the regular worker creation path but uses an entity-scoped callerId
   * for token minting and bearer binding. Does not write an entity row.
   */
  async startWorker(args: {
    source: string;
    ref?: string;
    key: string;
    contextId: string;
    stateArgs?: unknown;
    env?: Record<string, string>;
  }): Promise<{ targetId: string; effectiveVersion: string }> {
    const targetId = canonicalEntityId({ kind: "worker", source: args.source, key: args.key });
    const name = args.key.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (this.instances.has(name)) {
      throw new Error(`Worker instance "${name}" already exists`);
    }

    const callerId = targetId;
    const token = this.ensureWorkerBearer(callerId);

    const stateArgs =
      args.stateArgs && typeof args.stateArgs === "object" && !Array.isArray(args.stateArgs)
        ? (args.stateArgs as Record<string, unknown>)
        : undefined;

    const instance: WorkerInstance = {
      name,
      source: args.source,
      contextId: args.contextId,
      callerId,
      token,
      env: args.env ?? {},
      bindings: {},
      stateArgs,
      ref: args.ref,
      status: "building",
    };

    this.instances.set(name, instance);

    try {
      const buildResult = await this.deps.getBuild(args.source, args.ref);
      instance.buildKey = buildResult.metadata.ev;
      instance.status = "starting";

      await this.restartWorkerd();

      instance.status = "running";
      log.info(`Worker entity "${targetId}" started (source: ${args.source})`);

      if (this.deps.routeRegistry && this.deps.getManifestRoutes) {
        const canonical = canonicalInstanceNameForSource(args.source);
        if (name === canonical) {
          const routes = this.deps.getManifestRoutes(args.source);
          if (routes.length > 0) {
            this.deps.routeRegistry.registerWorkerRoutes(args.source, name, Array.from(routes));
          }
        }
      }

      return { targetId, effectiveVersion: buildResult.metadata.ev };
    } catch (error) {
      instance.status = "error";
      this.instances.delete(name);
      this.revokeWorkerBearer(callerId);
      log.error(`Failed to start worker entity "${targetId}":`, error);
      throw error;
    }
  }

  /**
   * Idempotent worker teardown invoked by the runtime-service retire hook.
   * Revokes the bearer token, drops the worker instance, runs handle/webhook
   * cleanup, and restarts (or stops) workerd as appropriate.
   */
  async stopWorker(callerId: string): Promise<void> {
    let foundInstance: WorkerInstance | null = null;
    let foundName: string | null = null;
    for (const [name, instance] of this.instances) {
      if (instance.callerId === callerId) {
        foundInstance = instance;
        foundName = name;
        break;
      }
    }

    this.revokeWorkerBearer(callerId);
    this.deps.fsService.closeHandlesForCaller(callerId);
    await this.deps.cleanupWebhookSubscriptions?.(callerId);

    if (!foundInstance || !foundName) return;

    if (this.deps.routeRegistry) {
      const canonical = canonicalInstanceNameForSource(foundInstance.source);
      if (foundInstance.name === canonical) {
        this.deps.routeRegistry.unregisterWorkerRoutes(foundInstance.source);
      }
    }

    foundInstance.status = "stopped";
    this.instances.delete(foundName);

    if (this.instances.size > 0 || this.doServices.size > 0) {
      await this.restartWorkerd();
    } else {
      await this.stopWorkerd();
    }

    log.info(`Worker entity "${callerId}" stopped`);
  }

  /**
   * Idempotent DO-entity teardown invoked by the runtime-service retire hook.
   * The concrete-instance row lives in WorkspaceDO (durable); workerd does
   * its own lazy GC of the DO instance, so this is a best-effort cleanup of
   * Node-side resources keyed by the targetId.
   */
  async destroyDOEntity(targetId: string): Promise<void> {
    this.revokeWorkerBearer(targetId);
    this.deps.fsService.closeHandlesForCaller(targetId);
    await this.deps.cleanupWebhookSubscriptions?.(targetId);
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
    const token = this.ensureWorkerBearer(callerId);

    const instance: WorkerInstance = {
      name,
      source: options.source,
      contextId,
      callerId,
      parentId: options.parentId,
      parentEntityId: options.parentEntityId,
      parentKind: options.parentKind,
      token,
      env: options.env ?? {},
      bindings: options.bindings ?? {},
      stateArgs: options.stateArgs,
      ref: options.ref,
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
            this.deps.routeRegistry.registerWorkerRoutes(options.source, name, Array.from(routes));
          }
        }
      }
    } catch (error) {
      // Rollback: clean up token, context registration, and instance map entry
      instance.status = "error";
      this.instances.delete(name);
      this.revokeWorkerBearer(callerId);
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
    this.revokeWorkerBearer(instance.callerId);
    this.deps.fsService.closeHandlesForCaller(instance.callerId);
    await this.deps.cleanupWebhookSubscriptions?.(instance.callerId);
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
      await this.stopWorkerd();
    }

    log.info(`Worker instance "${name}" destroyed`);
  }

  async updateInstance(
    name: string,
    updates: Partial<WorkerCreateOptions>
  ): Promise<WorkerInstance> {
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

  getInspectorUrl(): string | null {
    if (!this.process || !this.inspectorPort) return null;
    return `http://127.0.0.1:${this.inspectorPort}`;
  }

  getWorkerInspectorUrl(nameOrSource: string): string | null {
    const hasInstance = [...this.instances.values()].some(
      (instance) =>
        instance.name === nameOrSource ||
        instance.source === nameOrSource ||
        instance.callerId === nameOrSource
    );
    return hasInstance ? this.getInspectorUrl() : null;
  }

  getWorkerdGatewayToken(): string {
    return this.deps.getWorkerdGatewayToken();
  }

  getDispatchSecret(): string {
    return this.dispatchSecret;
  }

  getDoCodeIdentity(
    source: string,
    className: string
  ): { repoPath: string; effectiveVersion: string } | null {
    const service = this.doServices.get(`${source}:${className}`);
    if (!service) {
      return null;
    }
    return {
      repoPath: service.source,
      effectiveVersion: service.buildKey,
    };
  }

  // =========================================================================
  // Config generation
  // =========================================================================

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
        if (isInternalDOSource(doService.source)) {
          const buildResult = getInternalDOBundle();
          bundleContent = buildResult.bundle;
          doService.buildKey = buildResult.buildKey;
        } else {
          const buildResult = await this.deps.getBuild(doService.source);
          bundleContent = primaryTextArtifactContent(buildResult);
          doService.buildKey = buildResult.metadata.ev;
        }
      } catch (err) {
        log.warn(`Skipping DO service "${serviceKey}" — build not available:`, err);
        continue;
      }

      doServiceNames.add(doService.serviceName);

      // Service-level auth token — shared by all DO instances of this source:className.
      // Created once when the service is first built, revoked only when the last instance is destroyed.
      // NOT tied to any individual instance's lifecycle.
      //
      // NOTE: `do-service:*` here is a WORKERD-SIDE bearer-token key, NOT an
      // entity id. There is no `entities` row for it; the runtime-entity
      // model only tracks concrete DO instances (`do:<source>:<cls>:<key>`).
      // Don't grep this string expecting to find a registered principal.
      const serviceCallerId = `do-service:${serviceKey}`;
      const serviceToken = this.ensureWorkerBearer(serviceCallerId);

      const serviceCaller = createVerifiedCaller(serviceCallerId, "worker", {
        callerId: serviceCallerId,
        callerKind: "worker",
        repoPath: doService.source,
        effectiveVersion: doService.buildKey,
      });
      const bindings: object[] = [
        { name: "RPC_AUTH_TOKEN", text: serviceToken },
        // Source-scoped class identity
        { name: "WORKER_SOURCE", text: doService.source },
        { name: "WORKER_CLASS_NAME", text: className },
        // Session ID for restart detection (changes on each WorkerdManager lifetime)
        { name: "WORKERD_SESSION_ID", text: this.sessionId },
      ];

      // Gateway URL for RPC bridge (DOs use HttpRpcBridge via POST /rpc)
      bindings.push({ name: "GATEWAY_URL", text: this.deps.getServerUrl() });
      const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
      if (gatewayAliases.length > 0) {
        bindings.push({ name: "GATEWAY_URL_ALIASES", json: JSON.stringify(gatewayAliases) });
      }

      // DO storage: create a disk service and reference it by name
      const diskServiceName = `${doService.serviceName}_disk`;
      const doStoragePath = path.join(this.deps.statePath, ".databases", "workerd-do");
      fs.mkdirSync(doStoragePath, { recursive: true });

      const networkServiceName = `${doService.serviceName}_network`;
      const proxyPort = await this.deps.getProxyPort(serviceCaller);
      if (!proxyPort) {
        throw new Error("Egress proxy port not available");
      }

      const workerDef: Record<string, unknown> = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2025-12-01",
        // `nodejs_compat` gives worker DOs access to the Node-compatible
        // subset workerd ships (buffer, util, events, etc.). Required by
        // `@earendil-works/pi-agent-core` and the harness image / pi-ai code
        // paths that assume a Node-ish runtime.
        compatibilityFlags: ["nodejs_compat"],
        globalOutbound: networkServiceName,
        durableObjectNamespaces: [
          {
            className,
            uniqueKey: `${doService.source.replace(/\//g, "_")}:${className}`,
            enableSql: true,
          },
        ],
        durableObjectStorage: {
          localDisk: diskServiceName,
        },
      };

      services.push({ name: doService.serviceName, worker: workerDef });
      services.push({ name: diskServiceName, disk: { path: doStoragePath, writable: true } });
      services.push({
        name: networkServiceName,
        external: {
          address: `127.0.0.1:${proxyPort}`,
          http: { forwardedProtoHeader: "X-Forwarded-Proto" },
        },
      });
    }

    // ── Regular (non-durable) worker services ──
    for (const [name, instance] of this.instances) {
      // Get the build for this instance (content-addressed — ref builds are cached).
      let bundleContent: string;
      try {
        const buildResult = await this.deps.getBuild(instance.source, instance.ref);
        bundleContent = primaryTextArtifactContent(buildResult);
        instance.buildKey = buildResult.metadata.ev;
      } catch (err) {
        log.warn(`Skipping worker "${name}" — build not available:`, err);
        continue;
      }

      instanceNames.push(name);

      // Build bindings array
      const bindings: object[] = [
        { name: "RPC_AUTH_TOKEN", text: instance.token },
        { name: "WORKER_ID", text: instance.name },
        { name: "WORKER_SOURCE", text: instance.source },
        { name: "CONTEXT_ID", text: instance.contextId },
        { name: "GATEWAY_URL", text: this.deps.getServerUrl() },
      ];
      if (instance.parentId) {
        bindings.push({ name: "PARENT_ID", text: instance.parentId });
      }
      if (instance.parentEntityId) {
        bindings.push({ name: "PARENT_ENTITY_ID", text: instance.parentEntityId });
      }
      if (instance.parentKind) {
        bindings.push({ name: "PARENT_KIND", text: instance.parentKind });
      }
      const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
      if (gatewayAliases.length > 0) {
        bindings.push({ name: "GATEWAY_URL_ALIASES", json: JSON.stringify(gatewayAliases) });
      }
      // Inject stateArgs as a JSON binding so workers can access initial state
      if (instance.stateArgs && Object.keys(instance.stateArgs).length > 0) {
        bindings.push({ name: "STATE_ARGS", json: JSON.stringify(instance.stateArgs) });
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

      const networkServiceName = `${name}_network`;
      const workerCaller = createVerifiedCaller(instance.callerId, "worker", {
        callerId: instance.callerId,
        callerKind: "worker",
        repoPath: instance.source,
        effectiveVersion: instance.buildKey ?? "unknown",
      });
      const proxyPort = await this.deps.getProxyPort(workerCaller);
      if (!proxyPort) {
        throw new Error("Egress proxy port not available");
      }

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
      services.push({
        name: networkServiceName,
        external: {
          address: `127.0.0.1:${proxyPort}`,
          http: { forwardedProtoHeader: "X-Forwarded-Proto" },
        },
      });
    }

    // Collect DO class info for router generation (only those whose service was successfully built).
    // Each entry carries both the actual className (for workerd namespace binding) and the source
    // (for the /_w/ lookup key, so same-named classes from different sources don't collide).
    const doClassNames = Array.from(this.doServices.entries())
      .filter(([, svc]) => doServiceNames.has(svc.serviceName))
      .map(([, svc]) => ({
        className: svc.className,
        source: svc.source,
        serviceName: svc.serviceName,
      }));

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
      routerBindings.push({
        name: "WORKERD_GATEWAY_TOKEN",
        text: this.deps.getWorkerdGatewayToken(),
      });
      routerBindings.push({
        name: "WORKERD_DISPATCH_SECRET",
        text: this.dispatchSecret,
      });

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
      const worker = (svc as Record<string, unknown>)["worker"] as
        | Record<string, unknown>
        | undefined;
      if (worker?.["durableObjectNamespaces"]) {
        (worker["bindings"] as object[]).push({
          name: "WORKERD_URL",
          text: `http://127.0.0.1:${this.port}`,
        });
      }
    }

    return {
      services,
      sockets: hasAnyService
        ? [
            {
              name: "http",
              address: `127.0.0.1:${this.port}`,
              http: {},
              service: { name: "router" },
            },
          ]
        : [],
    };
  }

  private generateRouterCode(
    instanceNames: string[],
    doClassNames: { className: string; source: string; serviceName: string }[] = []
  ): string {
    const cases = instanceNames.map((name) => {
      const bindingName = `worker_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      return `    if (prefix === ${JSON.stringify(name)}) return env.${bindingName}.fetch(new Request(newUrl, strippedRequest));`;
    });

    // Build DO lookup map: "source:className" → binding name.
    // The lookup key combines source + className so same-named classes from different sources
    // dispatch to different workerd services.
    const doLookupEntries = doClassNames.map(({ className, source }) => {
      const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const lookupKey = `${source}:${className}`;
      return `      ${JSON.stringify(lookupKey)}: env.${bindingName}`;
    });

    // Generate DO routing block for /_w/{...source}/{className}/{objectKey}/{method...}.
    // Source paths may have arbitrary depth. The router disambiguates by matching
    // generated source:className keys rather than assuming a fixed segment count.
    let doBlock = "";
    if (doClassNames.length > 0) {
      doBlock = `
    // /_w/{...source}/{className}/{objectKey}/{...method} — source-scoped DO routes
    if (prefix === "_w") {
      if (parts.length < 5) {
        return new Response("Usage: /_w/{...source}/{className}/{objectKey}/{method}", { status: 400 });
      }
      const doLookup = {
${doLookupEntries.join(",\n")}
      };
      for (let classIndex = 2; classIndex <= parts.length - 3; classIndex++) {
        const source = parts.slice(1, classIndex).map(decodeURIComponent).join("/");
        const doClass = decodeURIComponent(parts[classIndex] || "");
        const objectKey = decodeURIComponent(parts[classIndex + 1] || "");
        const doRest = parts.slice(classIndex + 2);
        if (!source || !doClass || !objectKey) continue;
        const ns = doLookup[source + ":" + doClass];
        if (!ns) continue;
        const id = ns.idFromName(objectKey);
        const stub = ns.get(id);
        const doUrl = new URL("/" + encodeURIComponent(objectKey) + (doRest.length ? "/" + doRest.join("/") : ""), url.origin);
        doUrl.search = url.search;
        return stub.fetch(new Request(doUrl, strippedRequest));
      }
      return new Response("DO class not found for route: " + parts.slice(1).join("/"), { status: 404 });
    }
`;
    }

    return `export default {
  async fetch(request, env) {
    const expectedAuth = "Bearer " + env.WORKERD_GATEWAY_TOKEN;
    if (request.headers.get("Authorization") !== expectedAuth) {
      return new Response("Unauthorized", { status: 401 });
    }
    const strippedHeaders = new Headers(request.headers);
    strippedHeaders.delete("Authorization");
    for (const name of Array.from(strippedHeaders.keys())) {
      if (name.toLowerCase().startsWith("x-internal-")) strippedHeaders.delete(name);
    }
    const strippedRequest = new Request(request, { headers: strippedHeaders });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const prefix = parts[0] || "";
    if (prefix === "__natstack_workerd_ready") {
      return new Response(null, { status: 204 });
    }
    if (prefix === "_w" && request.headers.get("X-NatStack-Dispatch-Secret") !== env.WORKERD_DISPATCH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
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

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.startWorkerdOnce();
        return;
      } catch (err) {
        lastError = err;
        const detail = this.formatWorkerdStartupError(err);
        if (attempt < 3) {
          log.warn(
            `workerd startup attempt ${attempt} did not become ready; retrying with a fresh port. ${detail}`
          );
        } else {
          log.warn(`workerd startup attempt ${attempt} failed. ${detail}`);
        }
        await this.stopWorkerd();
      }
    }

    throw lastError instanceof Error ? lastError : new Error("workerd failed to start");
  }

  private async startWorkerdOnce(): Promise<void> {
    const config = await this.generateConfig();
    const configPath = path.join(this.configDir, "config.capnp");
    const capnpText = this.toCapnpText(config as Record<string, unknown>);
    fs.writeFileSync(configPath, capnpText);

    const binary = this.findWorkerdBinary();
    if (!this.inspectorPort && workerdInspectorEnabled()) {
      const { findServicePort } = await import("@natstack/port-utils");
      this.inspectorPort = await findServicePort("workerdInspector");
    }
    const args = [
      "serve",
      ...(this.inspectorPort ? [`--inspector-addr=127.0.0.1:${this.inspectorPort}`] : []),
      configPath,
    ];

    this.process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.lastWorkerdStartupOutput = [];

    this.process.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.rememberWorkerdStartupOutput(`stdout: ${line}`);
        log.info(`[workerd] ${line}`);
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.rememberWorkerdStartupOutput(`stderr: ${line}`);
        log.warn(`[workerd] ${line}`);
      }
    });

    // Wait for startup readiness, detecting early failures (ENOENT, bind
    // conflicts, crashes, etc.). A surviving process is not enough: workerd
    // may print a fatal bind error and exit just after spawn, and DO dispatch
    // must not race ahead until the router accepts HTTP.
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onExit = (code: number | null, signal: string | null) => {
        log.info(`workerd exited (code=${code}, signal=${signal})`);
        this.process = null;
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `workerd exited before accepting HTTP (code=${code}, signal=${signal})${this.recentWorkerdOutputSuffix()}`
            )
          );
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

      assertPresent(this.process).on("exit", onExit);
      assertPresent(this.process).on("error", onError);

      this.waitForHttpReady(
        this.deps.workerdStartupReadyTimeoutMs ?? DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS
      ).then(
        () => {
          if (settled) return;
          settled = true;
          // Keep the exit/error handlers for ongoing monitoring, but replace
          // them with non-rejecting versions since the promise is settled.
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
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(
            new Error(
              `${errorMessage(err)}. binary=${binary} port=${this.port} config=${configPath}${this.recentWorkerdOutputSuffix()}`
            )
          );
        }
      );
    });

    log.info(`workerd started on port ${this.port} with ${this.instances.size} worker(s)`);
  }

  private rememberWorkerdStartupOutput(line: string): void {
    this.lastWorkerdStartupOutput.push(line);
    if (this.lastWorkerdStartupOutput.length > WORKERD_STARTUP_OUTPUT_LINES) {
      this.lastWorkerdStartupOutput.splice(
        0,
        this.lastWorkerdStartupOutput.length - WORKERD_STARTUP_OUTPUT_LINES
      );
    }
  }

  private recentWorkerdOutputSuffix(): string {
    if (this.lastWorkerdStartupOutput.length === 0) return "";
    return `; recent workerd output:\n${this.lastWorkerdStartupOutput.join("\n")}`;
  }

  private formatWorkerdStartupError(err: unknown): string {
    return errorMessage(err).replace(/\s+/gu, " ").slice(0, 1200);
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
        const onExit = () => {
          exited = true;
          resolve();
        };
        proc.once("exit", onExit);
        setTimeout(() => {
          proc.removeListener("exit", onExit);
          resolve();
        }, 3000);
      });
      if (!exited) {
        // SIGTERM timed out — force reap so the socket can be reclaimed.
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        await new Promise<void>((resolve) => {
          const onExit = () => resolve();
          proc.once("exit", onExit);
          setTimeout(() => {
            proc.removeListener("exit", onExit);
            resolve();
          }, 1000);
        });
      }
    }
    // Release the pinned port so restartWorkerd re-probes via findServicePort.
    // findServicePort skips EADDRINUSE ports, which sidesteps the race where
    // the kernel has not finished releasing our previous bind yet.
    if (this.port) {
      const { releaseServicePort } = await import("@natstack/port-utils");
      releaseServicePort("workerd", this.port);
    }
    this.port = null;
    if (this.inspectorPort) {
      const { releaseServicePort } = await import("@natstack/port-utils");
      releaseServicePort("workerdInspector", this.inspectorPort);
    }
    this.inspectorPort = null;
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
    doClasses: Array<{ source: string; className: string }>
  ): Promise<void> {
    let added = false;
    for (const { source, className } of doClasses) {
      const serviceKey = `${source}:${className}`;
      if (this.doServices.has(serviceKey)) continue;

      try {
        const buildKey = isInternalDOSource(source)
          ? getInternalDOBundle().buildKey
          : (await this.deps.getBuild(source)).metadata.ev;
        const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
        const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        this.doServices.set(serviceKey, {
          buildKey,
          className,
          serviceName,
          source,
        });
        if (!isInternalDOSource(source)) this.registerRoutesForDoClass(source, className);
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
    if (!this.deps.routeRegistry || !this.deps.getManifestRoutes || !this.deps.singletonRegistry)
      return;
    const routes = this.deps.getManifestRoutes(source);
    if (routes.length === 0) return;
    this.deps.routeRegistry.registerDoRoutes(
      source,
      className,
      Array.from(routes),
      this.deps.singletonRegistry
    );
  }

  /**
   * Ensure a DO class is registered and workerd is running. Does NOT bootstrap any instance.
   * Use for infrastructure DOs that don't need DOIdentity.
   */
  async ensureDOClass(source: string, className: string): Promise<void> {
    const serviceKey = `${source}:${className}`;
    if (!this.doServices.has(serviceKey)) {
      const sourceSegments = source.split("/").filter(Boolean);
      if (!isInternalDOSource(source) && sourceSegments.length !== 2) {
        throw new Error(`DO source path must be exactly 2 segments, got: "${source}"`);
      }
      const buildKey = isInternalDOSource(source)
        ? getInternalDOBundle().buildKey
        : (await this.deps.getBuild(source)).metadata.ev;
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      this.doServices.set(serviceKey, {
        buildKey,
        className,
        serviceName,
        source,
      });
      if (!isInternalDOSource(source)) this.registerRoutesForDoClass(source, className);
      await this.restartWorkerd();
    }

    if (!this.process || this.process.exitCode !== null) {
      await this.restartWorkerd();
      return;
    }

    try {
      await this.waitForHttpReady(2_000);
    } catch (err) {
      log.warn(
        `workerd process is present but not accepting HTTP; restarting before DO dispatch:`,
        err
      );
      await this.restartWorkerd();
    }
  }

  /**
   * Ensure a Durable Object class is registered and workerd is running.
   * DOs self-bootstrap from env bindings on first request — no external bootstrap call needed.
   * Used by the unified RPC relay retry path when a DO class is missing after
   * a rebuild/restart race.
   */
  async ensureDO(source: string, className: string, _objectKey: string): Promise<void> {
    await this.ensureDOClass(source, className);
  }

  private async waitForHttpReady(timeoutMs = 5_000): Promise<void> {
    if (!this.port) {
      throw new Error("workerd has no assigned port");
    }
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/__natstack_workerd_ready`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.deps.getWorkerdGatewayToken()}`,
          },
        });
        await response.arrayBuffer().catch(() => undefined);
        if (response.ok) return;
        lastError = new Error(`workerd readiness returned HTTP ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `workerd did not accept HTTP on port ${this.port} within ${timeoutMs}ms; last readiness error: ${
        lastError ? errorMessage(lastError) : "none"
      }`
    );
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
      throw new Error(
        `Source DO storage not found: ${ref.className}/${ref.objectKey} (expected ${sourceFile})`
      );
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
      try {
        fs.unlinkSync(base + suffix);
      } catch (err: unknown) {
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
      this.revokeWorkerBearer(instance.callerId);
      this.deps.fsService.closeHandlesForCaller(instance.callerId);
    }
    this.instances.clear();

    // Cleanup DO tracking — revoke service-level tokens
    for (const [serviceKey] of this.doServices) {
      this.revokeWorkerBearer(`do-service:${serviceKey}`);
    }
    this.doServices.clear();

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
        this.revokeWorkerBearer(`do-service:${serviceKey}`);
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
    if (this.deps.routeRegistry && this.deps.getManifestRoutes && this.deps.singletonRegistry) {
      const newRoutes = this.deps.getManifestRoutes(source);
      const liveDoClasses = new Set<string>();
      for (const svc of this.doServices.values()) {
        if (svc.source === source) liveDoClasses.add(svc.className);
      }
      const canonical = canonicalInstanceNameForSource(source);
      const hasCanonicalInstance =
        this.instances.has(canonical) &&
        assertPresent(this.instances.get(canonical)).source === source;
      this.deps.routeRegistry.reconcileWorkerRoutes(
        source,
        Array.from(newRoutes),
        liveDoClasses,
        hasCanonicalInstance ? canonical : null,
        this.deps.singletonRegistry
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
