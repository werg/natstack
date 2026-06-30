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
import type { RuntimeImageBinding, StateAdvancedEvent } from "./buildV2/index.js";
import { validateBuildRef } from "./buildV2/refs.js";
import type { RouteRegistry, ManifestRouteDecl } from "./routeRegistry.js";
import type { SingletonRegistry } from "@natstack/shared/workspace/singletonRegistry";
import { createDevLogger } from "@natstack/dev-log";
import {
  getPhysicalPathForAsarPath,
  getPlatformPackageBinaryPath,
} from "@natstack/shared/runtimePaths";
import { getInternalDOBundle, isInternalDOSource } from "./internalDOs/internalDoLoader.js";
import { encodeUniversalKey } from "./doDispatch.js";
import { assertPresent } from "../lintHelpers";
import { RuntimeImageStore, type RuntimeImageRecord } from "./runtimeImageStore.js";

const log = createDevLogger("WorkerdManager");
/** uniqueKey of the single static namespace that hosts all userland DO facets.
 *  workerd stores its facet SQLite under `<disk>/<this>/<hostHash>.*`. */
const UNIVERSAL_DO_UNIQUE_KEY = "natstack:universal-do";
const DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS = 15_000;
const WORKERD_STARTUP_OUTPUT_LINES = 40;
declare const __filename: string | undefined;
declare const __dirname: string | undefined;

export class RuntimeImageWarmingError extends Error {
  readonly code = "RUNTIME_IMAGE_WARMING" as const;
}

export class RuntimeImageUnavailableError extends Error {
  readonly code = "RUNTIME_IMAGE_UNAVAILABLE" as const;
}

function explicitScopeRef(explicitRef?: string): string | undefined {
  return explicitRef && explicitRef.length > 0
    ? assertPresent(validateBuildRef(explicitRef))
    : undefined;
}

function scopeTracksHead(scopeRef: string | undefined, head: string): boolean {
  const normalized = scopeRef && scopeRef.length > 0 ? scopeRef : "main";
  return normalized === head;
}

function isBootstrapMainBoundDo(source: string, className: string): boolean {
  return source === "workers/gad-store" && className === "GadWorkspaceDO";
}

// This file is bundled as both ESM (standalone server) and CJS (Electron
// utility process). build.mjs injects __filename into the ESM bundle, while
// CJS provides it natively. Avoid spelling import.meta here: esbuild warns
// whenever import.meta appears in CJS output, even behind typeof guards.
const requireFromUrl: string =
  typeof __filename !== "undefined" && __filename
    ? pathToFileURL(__filename).href
    : pathToFileURL(process.cwd() + "/").href;
const moduleDir: string = typeof __dirname !== "undefined" && __dirname ? __dirname : process.cwd();

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

interface DOService {
  buildKey: string;
  className: string;
  imageId?: string;
  serviceName: string;
  source: string;
  /** Class-level/default follower scope. Object-specific scopes live in doObjectBuilds. */
  scopeRef?: string;
}

interface DOObjectBuild {
  buildKey: string;
  imageId: string;
  scopeRef?: string;
}

function doServiceKey(source: string, className: string): string {
  return `${source}:${className}`;
}

function doObjectBuildKey(source: string, className: string, objectKey: string): string {
  return `${source}:${className}/${objectKey}`;
}

export interface RestartBeginEvent {
  correlationId: string;
  generation: number;
  reason: string;
}

export interface RestartReadyEvent extends RestartBeginEvent {
  previousGeneration: number | null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Worker→worker calls go through the RPC relay, not a live workerd capability,
// so there is no `service` binding — only serializable data bindings.
export type WorkerBinding = { type: "text"; value: string } | { type: "json"; value: unknown };

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
  /** Explicit build ref. Omit to track main; use "ctx:<id>" only when selecting a real VCS head. */
  ref?: string;
}

export interface WorkerInstance {
  /** Public lifecycle handle. Use this for status/update/destroy calls. */
  id: string;
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
  /** Signed effective version of the bound image — the identity egress/approval
   *  scoping must use (buildKey is the artifact key, not the signed EV). */
  effectiveVersion?: string;
  runtimeImageId: string;
  /** Head/state this instance follows. The loader never resolves it. */
  scopeRef?: string;
  /** Monotonic version bumped on every create/update. The dynamic worker host
   *  keys its loader cache on `${name}@${codeVersion}`, so any change to code,
   *  env, bindings, ref, or stateArgs forces a fresh isolate (old ones idle out).
   *  This is what lets worker update/rebuild take effect with no workerd restart. */
  codeVersion: number;
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
  bindRuntimeImage: (unitPath: string, ref?: string) => Promise<RuntimeImageBinding>;
  getBuildByKey: (key: string) => BuildResult | null;
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
  /** Shared attributed-by-header egress listener port for the dynamic worker
   *  host. Identity travels in the `X-NatStack-Egress-Caller` header (stamped
   *  by the host's EgressGateway from non-forgeable props), gated by
   *  `egressSecret`. Distinct from `getProxyPort` (per-caller ports, still used
   *  by static DO services). */
  getSharedEgressPort: () => Promise<number>;
  /** Register/unregister a live worker's VerifiedCaller so the shared egress
   *  listener can resolve the header id → full caller for attribution. */
  registerEgressCaller: (callerId: string, caller: VerifiedCaller) => void;
  unregisterEgressCaller: (callerId: string) => void;
  getWorkerdGatewayToken: () => string;
  /** Override for tests; production uses the default router readiness window. */
  workerdStartupReadyTimeoutMs?: number;
  cleanupWebhookSubscriptions?: (callerId: string) => Promise<void>;
  /**
   * Structured lifecycle sink (start/stop/update/failure per worker). The
   * server feeds this into the runtime-diagnostics store so worker startup
   * failures are queryable via `workspace.units.diagnostics` instead of
   * living only in the server console.
   */
  recordLifecycleEvent?: (event: {
    source: string;
    callerId: string;
    level: "info" | "error";
    message: string;
    fields?: Record<string, unknown>;
  }) => void;
}

type ResolvedWorkerdManagerDeps = WorkerdManagerDeps;

/** The canonical regular-worker instance name for a source. Matches the
 *  sanitization that startWorker applies to the entity key. */
function canonicalInstanceNameForSource(source: string): string {
  const raw = source.split("/").pop() ?? "worker";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function workerdInspectorEnabled(): boolean {
  // Always on by default: NatStack is a continuous-development system, and
  // userland profiling (workerdInspector service) depends on the inspector.
  // The socket binds 127.0.0.1 and is only reachable from userland through
  // the token-authenticated, approval-gated inspector bridge.
  return process.env["NATSTACK_DISABLE_WORKERD_INSPECTOR"] !== "1";
}

const EXPECTED_EVAL_IDLE_EVICTION_ABORT =
  "EvalDO: idle eviction (reclaim memory; SQLite preserved)";

export function isExpectedEvalIdleEvictionWorkerdStderr(text: string): boolean {
  return text.includes(EXPECTED_EVAL_IDLE_EVICTION_ABORT);
}

// ---------------------------------------------------------------------------
// WorkerdManager
// ---------------------------------------------------------------------------

export class WorkerdManager {
  private instances = new Map<string, WorkerInstance>();
  // Most recent startup/update failure per worker source. Survives the
  // instance row (which is deleted on failed start) so `units.list` can
  // report lastError for workers that never came up.
  private lastWorkerErrors = new Map<string, { message: string; timestamp: number }>();
  private process: ChildProcess | null = null;
  // Restart coalescing: callers mutate doServices/instances then call
  // restartWorkerd(). `requestedEpoch` increments per call; `appliedEpoch` is the
  // highest config epoch a completed restart has applied. Concurrent callers
  // within one restart window share it; a config change made during a restart
  // triggers at most one follow-up restart. Prevents the un-coalesced restart
  // storm (N failed relays ⇒ N racing restarts) that fed the server OOM.
  private requestedEpoch = 0;
  private appliedEpoch = 0;
  private restartRunning: Promise<void> | null = null;
  private configDir: string;
  private port: number | null = null;
  private inspectorPort: number | null = null;
  private deps: ResolvedWorkerdManagerDeps;
  private readonly runtimeImages: RuntimeImageStore;
  private readonly runtimeImageRebinds = new Map<string, Promise<void>>();
  private workerdBinary: string | null = null;
  private lastWorkerdStartupOutput: string[] = [];
  private workerdStartedAtMs: number | null = null;
  private workerdMemorySampleTimer: ReturnType<typeof setInterval> | null = null;
  private lastWorkerdRssBytes: number | null = null;
  private suppressNextExpectedWorkerdStack = false;

  // DO support: shared services (one per source)
  /** Shared DO services — keyed by `${source}:${className}`. Source-scoped: two workers CAN have same className if different source. */
  private doServices = new Map<string, DOService>();
  /** Userland DO object-specific code refs — keyed by `${source}:${className}/${objectKey}`. */
  private doObjectBuilds = new Map<string, DOObjectBuild>();
  /** Session ID — generated once per WorkerdManager lifetime, used for restart detection in bootstrap. */
  private sessionId = crypto.randomUUID();
  private bootGeneration: number;
  private pendingBootGeneration: number | null = null;
  private readonly bootGenerationFile: string;
  private restartBeginHooks = new Set<(event: RestartBeginEvent) => Promise<void> | void>();
  private restartReadyHooks = new Set<(event: RestartReadyEvent) => Promise<void> | void>();
  /** Per-manager secret required by the generated router for direct DO dispatch. */
  private readonly dispatchSecret = crypto.randomBytes(32).toString("hex");
  /** Per-process secret gating the loopback `/_workercode` + `/_workerversion`
   *  endpoints. Bound only into the static worker-host service, so worker code +
   *  per-instance env (RPC tokens, STATE_ARGS) are unreachable with ordinary
   *  panel/worker credentials. */
  private readonly loaderSecret = crypto.randomBytes(32).toString("hex");
  /** Per-process secret the host's EgressGateway stamps on forwarded egress so
   *  the shared egress listener trusts the `X-NatStack-Egress-Caller` header. */
  private readonly egressSecret = crypto.randomBytes(32).toString("hex");
  /** Resolved shared egress listener port (memoized after first start). */
  private sharedEgressPort: number | null = null;

  constructor(deps: WorkerdManagerDeps) {
    this.deps = deps;
    this.runtimeImages = new RuntimeImageStore(deps.statePath);
    this.configDir = path.join(os.tmpdir(), `natstack-workerd-${process.pid}`);
    fs.mkdirSync(this.configDir, { recursive: true });
    this.bootGenerationFile = path.join(this.deps.statePath, ".boot-generation");
    this.bootGeneration = this.readBootGeneration();
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

  private async bindRuntimeImage(
    imageId: string,
    source: string,
    scopeRef?: string
  ): Promise<RuntimeImageRecord> {
    const binding = await this.deps.bindRuntimeImage(source, scopeRef);
    return this.persistRuntimeImage(imageId, binding, scopeRef);
  }

  private persistRuntimeImage(
    imageId: string,
    binding: RuntimeImageBinding,
    scopeRef?: string
  ): RuntimeImageRecord {
    return this.runtimeImages.upsert({
      id: imageId,
      source: binding.source,
      unitName: binding.unitName,
      stateHash: binding.stateHash,
      buildKey: binding.buildKey,
      effectiveVersion: binding.effectiveVersion,
      ...(scopeRef ? { scopeRef } : {}),
    });
  }

  private advanceWorkerCodeVersion(instance: WorkerInstance, generation?: number): void {
    instance.codeVersion = Math.max(instance.codeVersion + 1, generation ?? 0);
  }

  private getRuntimeImageBuild(
    imageId: string,
    onRebound?: (record: RuntimeImageRecord) => void
  ): { image: RuntimeImageRecord; build: BuildResult } {
    const image = this.runtimeImages.get(imageId);
    if (!image) {
      throw new RuntimeImageWarmingError(`Runtime image is not bound yet: ${imageId}`);
    }
    const build = this.deps.getBuildByKey(image.buildKey);
    if (build) return { image, build };
    if (image.error) {
      throw new RuntimeImageUnavailableError(
        `Runtime image ${imageId} is unavailable: ${image.error.message}`
      );
    }

    this.scheduleRuntimeImageRebind(image, onRebound);
    throw new RuntimeImageWarmingError(
      `Runtime image ${imageId} points at missing artifact ${image.buildKey}; warming`
    );
  }

  private scheduleRuntimeImageRebind(
    image: RuntimeImageRecord,
    onRebound?: (record: RuntimeImageRecord) => void
  ): void {
    if (this.runtimeImageRebinds.has(image.id)) return;
    const flight = this.bindRuntimeImage(image.id, image.source, image.scopeRef)
      .then(
        (record) => {
          onRebound?.(record);
        },
        (error) => {
          const message = errorMessage(error);
          this.runtimeImages.markError(image.id, {
            code: "rebind_failed",
            message,
          });
          log.warn(`Runtime image rebind failed for ${image.id}:`, error);
        }
      )
      .finally(() => {
        this.runtimeImageRebinds.delete(image.id);
      });
    this.runtimeImageRebinds.set(image.id, flight);
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
        moduleDir,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-linux-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        moduleDir,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-linux-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        moduleDir,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-darwin-64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        moduleDir,
        "..",
        "..",
        "node_modules",
        "@cloudflare",
        "workerd-darwin-arm64",
        "bin",
        `workerd${maybeExeExtension}`
      ),
      path.join(
        moduleDir,
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
    const targetId = canonicalEntityId({
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
    });
    const explicitRef = explicitScopeRef(args.ref);
    const bootstrapMainBound = isBootstrapMainBoundDo(args.source, args.className);
    const scopeRef = bootstrapMainBound ? args.ref : explicitRef;
    await this.ensureDOClass(args.source, args.className, {
      scopeRef,
      objectKey: args.key,
      imageId: targetId,
    });
    const serviceKey = doServiceKey(args.source, args.className);
    const svc = this.doServices.get(serviceKey);
    if (!svc) {
      throw new Error(
        `ensureDurableObjectEntity: DO class ${serviceKey} missing from doServices after ensureDOClass`
      );
    }
    const image =
      this.runtimeImages.get(targetId) ??
      (svc.imageId ? this.runtimeImages.get(svc.imageId) : null);
    return { targetId, effectiveVersion: image?.effectiveVersion ?? svc.buildKey };
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
    parent?: { parentId: string; parentEntityId: string; parentKind?: "panel" | "worker" | "do" };
  }): Promise<{ targetId: string; effectiveVersion: string }> {
    const targetId = canonicalEntityId({ kind: "worker", source: args.source, key: args.key });
    const name = args.key.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Idempotent re-attach: `canonicalEntityId` is context-free, so the same
    // (source, key) maps to the same targetId/name in any context. If a live
    // instance already matches this identity (same source AND contextId), return
    // it as a no-op — this covers spawn retries/races where the entity create is
    // replayed. A different identity colliding on the sanitized name (a different
    // source, or the same source in another context — workers are NOT
    // context-isolated until their canonical id includes contextId) is a genuine
    // collision and throws rather than silently reusing the wrong worker.
    const existingInstance = this.instances.get(name);
    if (existingInstance) {
      // Reattach ONLY on a FULL-identity match: the canonical targetId
      // (`runtimeImageId` = worker:source:key) AND the contextId. targetId is
      // context-free, so both checks are needed — the targetId guards distinct
      // raw keys that sanitize to the same `name` (e.g. `a:b`/`a_b`), and the
      // contextId prevents silently handing a launch a worker running in a
      // DIFFERENT context (same source+key in another context maps to the same
      // targetId). Workers are not context-isolated until their canonical id
      // includes contextId — callers must use context-unique keys; anything
      // short of a full match is a genuine collision and throws.
      if (
        existingInstance.runtimeImageId === targetId &&
        existingInstance.contextId === args.contextId
      ) {
        return {
          targetId,
          effectiveVersion: existingInstance.effectiveVersion ?? existingInstance.buildKey ?? "",
        };
      }
      throw new Error(
        `Worker instance "${name}" already exists with a different identity ` +
          `(existing targetId=${existingInstance.runtimeImageId} source=${existingInstance.source} ` +
          `context=${existingInstance.contextId}; requested targetId=${targetId} ` +
          `source=${args.source} context=${args.contextId})`
      );
    }

    const callerId = targetId;
    const token = this.ensureWorkerBearer(callerId);
    const explicitRef = explicitScopeRef(args.ref);
    const scopeRef = explicitRef;

    const stateArgs =
      args.stateArgs && typeof args.stateArgs === "object" && !Array.isArray(args.stateArgs)
        ? (args.stateArgs as Record<string, unknown>)
        : undefined;

    const instance: WorkerInstance = {
      id: callerId,
      name,
      source: args.source,
      contextId: args.contextId,
      callerId,
      token,
      env: args.env ?? {},
      bindings: {},
      stateArgs,
      runtimeImageId: targetId,
      scopeRef,
      codeVersion: 1,
      status: "building",
      // Launch parent (from the verified caller) → PARENT_* env (built later from
      // these fields), so an entity-created worker's `parent` resolves like a
      // `workers.create` one.
      parentId: args.parent?.parentId,
      parentEntityId: args.parent?.parentEntityId,
      parentKind: args.parent?.parentKind,
    };

    this.instances.set(name, instance);

    try {
      instance.status = "starting";
      const [image] = await Promise.all([
        this.bindRuntimeImage(targetId, args.source, scopeRef),
        this.ensureWorkerdRunning(),
      ]);
      instance.scopeRef = image.scopeRef;
      instance.buildKey = image.buildKey;
      instance.effectiveVersion = image.effectiveVersion;
      this.advanceWorkerCodeVersion(instance, image.generation);
      // Register egress AFTER bind so the caller carries the signed effective
      // version (not "unknown"/an artifact key) for version-scoped approvals/audit.
      this.registerEgressCaller(instance);

      instance.status = "running";
      this.lastWorkerErrors.delete(args.source);
      this.deps.recordLifecycleEvent?.({
        source: args.source,
        callerId,
        level: "info",
        message: `Worker started (build ${image.buildKey})`,
        fields: {
          event: "worker-started",
          buildKey: image.buildKey,
          generation: image.generation,
          effectiveVersion: image.effectiveVersion,
        },
      });
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

      return { targetId, effectiveVersion: image.effectiveVersion };
    } catch (error) {
      instance.status = "error";
      this.instances.delete(name);
      this.runtimeImages.delete(targetId);
      this.deps.unregisterEgressCaller(callerId);
      this.revokeWorkerBearer(callerId);
      const message = error instanceof Error ? error.message : String(error);
      this.lastWorkerErrors.set(args.source, { message, timestamp: Date.now() });
      this.deps.recordLifecycleEvent?.({
        source: args.source,
        callerId,
        level: "error",
        message: `Worker failed to start: ${message}`,
        fields: { event: "worker-start-failed" },
      });
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

    this.deps.unregisterEgressCaller(callerId);
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
    this.runtimeImages.delete(foundInstance.runtimeImageId);

    // No restart: the worker host is static and loads code on demand, so a
    // destroyed worker simply stops being addressable (its `/_workerversion`
    // 404s and its cached isolate idles out). Only stop workerd when nothing
    // is left to serve.
    await this.stopWorkerdIfIdle();

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
    this.runtimeImages.delete(targetId);
    for (const [key, objectBuild] of Array.from(this.doObjectBuilds.entries())) {
      if (objectBuild.imageId === targetId) this.doObjectBuilds.delete(key);
    }
  }

  /**
   * Build a VerifiedCaller for a live worker instance and register it for
   * attributed egress through the shared listener. Called on create; matched by
   * `unregisterEgressCaller(callerId)` on destroy.
   */
  private registerEgressCaller(instance: WorkerInstance): void {
    const caller = createVerifiedCaller(instance.callerId, "worker", {
      callerId: instance.callerId,
      callerKind: "worker",
      repoPath: instance.source,
      effectiveVersion: instance.effectiveVersion ?? instance.buildKey ?? "unknown",
    });
    this.deps.registerEgressCaller(instance.callerId, caller);
  }

  /**
   * Start workerd if it isn't already running. Idempotent. Unlike
   * `restartWorkerd`, this never tears down a live process — the worker host and
   * router are static, so worker lifecycle never needs a restart.
   */
  private async ensureWorkerdRunning(): Promise<void> {
    if (this.process && this.process.exitCode === null) return;
    await this.restartWorkerd();
  }

  /** Stop workerd only when no workers and no DO services remain to serve. */
  private async stopWorkerdIfIdle(): Promise<void> {
    if (this.instances.size === 0 && this.doServices.size === 0) {
      await this.stopWorkerd("idle");
    }
  }

  async updateInstance(
    name: string,
    updates: Partial<WorkerCreateOptions>
  ): Promise<WorkerInstance> {
    const resolvedName = this.resolveInstanceName(name);
    const instance = resolvedName ? this.instances.get(resolvedName) : undefined;
    if (!instance) {
      throw new Error(`Worker instance "${name}" not found`);
    }

    if (updates.env) instance.env = updates.env;
    if (updates.bindings) instance.bindings = updates.bindings;
    if (updates.stateArgs !== undefined) instance.stateArgs = updates.stateArgs;
    if (updates.ref !== undefined) {
      instance.scopeRef = explicitScopeRef(updates.ref);
      const image = await this.bindRuntimeImage(
        instance.runtimeImageId,
        instance.source,
        instance.scopeRef
      );
      instance.buildKey = image.buildKey;
      instance.effectiveVersion = image.effectiveVersion;
      this.advanceWorkerCodeVersion(instance, image.generation);
      this.registerEgressCaller(instance); // refresh egress EV after a rebind
    }

    // Bump the loader-cache version so the host reloads fresh code+env on the
    // next request. No workerd restart — the host is static.
    if (updates.ref === undefined) this.advanceWorkerCodeVersion(instance);

    this.deps.recordLifecycleEvent?.({
      source: instance.source,
      callerId: instance.callerId,
      level: "info",
      message: `Worker updated (codeVersion ${instance.codeVersion})`,
      fields: { event: "worker-updated", codeVersion: instance.codeVersion },
    });
    log.info(`Worker instance "${resolvedName}" updated (codeVersion ${instance.codeVersion})`);
    return instance;
  }

  /** Most recent startup/update failure for a worker source, if any. */
  getLastWorkerError(source: string): { message: string; timestamp: number } | null {
    return this.lastWorkerErrors.get(source) ?? null;
  }

  listInstances(): Omit<WorkerInstance, "token">[] {
    return Array.from(this.instances.values()).map(({ token: _token, ...rest }) => rest);
  }

  private resolveInstanceName(idOrName: string): string | null {
    if (this.instances.has(idOrName)) return idOrName;
    for (const [name, instance] of this.instances) {
      if (
        instance.id === idOrName ||
        instance.callerId === idOrName ||
        instance.runtimeImageId === idOrName
      ) {
        return name;
      }
    }
    return null;
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

  getBootGeneration(): number {
    return this.bootGeneration;
  }

  onRestartBegin(fn: (event: RestartBeginEvent) => Promise<void> | void): () => void {
    this.restartBeginHooks.add(fn);
    return () => this.restartBeginHooks.delete(fn);
  }

  onRestartReady(fn: (event: RestartReadyEvent) => Promise<void> | void): () => void {
    this.restartReadyHooks.add(fn);
    return () => this.restartReadyHooks.delete(fn);
  }

  getDispatchSecret(): string {
    return this.dispatchSecret;
  }

  /** Secret gating `/_workercode` + `/_workerversion`. The gateway validates
   *  the inbound `X-NatStack-Loader-Secret` header against this. */
  getLoaderSecret(): string {
    return this.loaderSecret;
  }

  /** Secret the shared egress listener requires on attributed requests. */
  getEgressSecret(): string {
    return this.egressSecret;
  }

  /**
   * Current loader-cache version for a worker instance, or null if no such
   * instance exists. Served by `GET /_workerversion/{name}`; the host keys its
   * loader id on `${name}@${version}` so update/rebuild forces a fresh isolate.
   */
  getWorkerVersion(name: string): number | null {
    return this.instances.get(name)?.codeVersion ?? null;
  }

  /**
   * Serializable code + env for a worker instance, for the dynamic worker host.
   * Carries only data — capability bindings (globalOutbound) are attached by the
   * host at load time. Returns null if no such instance exists.
   */
  async getWorkerCode(name: string): Promise<{
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: Record<string, string>;
    env: Record<string, unknown>;
    callerId: string;
  } | null> {
    const instance = this.instances.get(name);
    if (!instance) return null;

    const { image, build: buildResult } = this.getRuntimeImageBuild(
      instance.runtimeImageId,
      (record) => {
        instance.buildKey = record.buildKey;
        instance.effectiveVersion = record.effectiveVersion;
        this.advanceWorkerCodeVersion(instance, record.generation);
        this.registerEgressCaller(instance);
      }
    );
    instance.buildKey = image.buildKey;
    instance.effectiveVersion = image.effectiveVersion;
    const bundleContent = primaryTextArtifactContent(buildResult);

    // WorkerCode `env` (unlike the old capnp config) supports non-string values
    // natively — so `json` bindings / STATE_ARGS / aliases keep their PARSED
    // (object/array) shape, exactly as the old workerd `json` bindings exposed
    // them. The /_workercode JSON round-trips them losslessly.
    const env: Record<string, unknown> = {
      RPC_AUTH_TOKEN: instance.token,
      WORKER_ID: instance.name,
      WORKER_SOURCE: instance.source,
      CONTEXT_ID: instance.contextId,
      GATEWAY_URL: this.deps.getServerUrl(),
      WORKERD_BOOT_GENERATION: String(this.configBootGeneration()),
    };
    if (process.env["NATSTACK_TEST_MODE"]) {
      env["NATSTACK_TEST_MODE"] = process.env["NATSTACK_TEST_MODE"];
    }
    if (instance.parentId) env["PARENT_ID"] = instance.parentId;
    if (instance.parentEntityId) env["PARENT_ENTITY_ID"] = instance.parentEntityId;
    if (instance.parentKind) env["PARENT_KIND"] = instance.parentKind;
    const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
    if (gatewayAliases.length > 0) {
      env["GATEWAY_URL_ALIASES"] = [...gatewayAliases];
    }
    if (instance.stateArgs && Object.keys(instance.stateArgs).length > 0) {
      env["STATE_ARGS"] = instance.stateArgs;
    }
    // User-defined env (text only).
    for (const [key, value] of Object.entries(instance.env)) {
      env[key] = value;
    }
    // Typed bindings are serializable data only — `text` is a string, `json`
    // keeps its parsed object value; both pass through as-is.
    for (const [key, binding] of Object.entries(instance.bindings)) {
      env[key] = binding.value;
    }

    return {
      compatibilityDate: "2024-01-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: { "worker.js": bundleContent },
      env,
      callerId: instance.callerId,
    };
  }

  getDoCodeIdentity(
    source: string,
    className: string
  ): { repoPath: string; effectiveVersion: string } | null {
    const service = this.doServices.get(doServiceKey(source, className));
    if (!service) {
      return null;
    }
    const image = service.imageId ? this.runtimeImages.get(service.imageId) : null;
    return {
      repoPath: service.source,
      effectiveVersion: image?.effectiveVersion ?? service.buildKey,
    };
  }

  /**
   * Current loader-cache version for a userland DO class (its build's effective
   * version), or null if the class isn't registered. Served by
   * `GET /_doversion/{source}/{className}?objectKey=...`; the UniversalDO host
   * keys its loader id on `source:className/objectKey@version` so a rebuild
   * forces a fresh isolate for that object/ref binding.
   */
  getDoVersion(source: string, className: string, objectKey?: string): string | null {
    if (objectKey) {
      const objectBuild = this.doObjectBuilds.get(doObjectBuildKey(source, className, objectKey));
      if (objectBuild) {
        const image = this.runtimeImages.get(objectBuild.imageId);
        if (image) return String(image.generation);
        return objectBuild.buildKey;
      }
    }
    const svc = this.doServices.get(doServiceKey(source, className));
    if (!svc || isInternalDOSource(source)) return null;
    const image = svc.imageId ? this.runtimeImages.get(svc.imageId) : null;
    return image ? String(image.generation) : svc.buildKey;
  }

  /**
   * Serializable code + env for a userland DO class, for the UniversalDO facet
   * host. Mirrors the per-class DO service bindings the old static config
   * generated. Capability bindings (globalOutbound) are attached by the host.
   * Returns null if the class isn't a registered userland DO.
   */
  async getDoCode(
    source: string,
    className: string,
    objectKey?: string
  ): Promise<{
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: Record<string, string>;
    /** Extra pre-compiled wasm modules, base64 (e.g. terminal/Ink `yoga.wasm`).
     *  The UniversalDO host decodes these to ArrayBuffers for the loader. */
    wasmModules?: Record<string, string>;
    env: Record<string, string>;
  } | null> {
    const serviceKey = doServiceKey(source, className);
    const svc = this.doServices.get(serviceKey);
    if (!svc || isInternalDOSource(source)) return null;

    const objectBuildKey = objectKey ? doObjectBuildKey(source, className, objectKey) : null;
    const objectBuild = objectBuildKey ? this.doObjectBuilds.get(objectBuildKey) : undefined;
    const imageId = objectBuild?.imageId ?? svc.imageId;
    if (!imageId) return null;
    const { image, build: buildResult } = this.getRuntimeImageBuild(imageId, (record) => {
      if (objectBuildKey && objectBuild) {
        this.doObjectBuilds.set(objectBuildKey, {
          ...objectBuild,
          buildKey: record.buildKey,
        });
      } else {
        svc.buildKey = record.buildKey;
      }
      this.registerDoEgressCaller(source, className, record.effectiveVersion);
    });
    if (objectBuildKey && objectBuild) {
      this.doObjectBuilds.set(objectBuildKey, {
        ...objectBuild,
        buildKey: image.buildKey,
      });
    } else {
      svc.buildKey = image.buildKey;
    }
    const bundleContent = primaryTextArtifactContent(buildResult);
    // Terminal (Ink) DOs import a pre-compiled `yoga.wasm` module — it must be
    // loaded alongside the JS bundle (the only way to run WASM in workerd).
    const wasmModules: Record<string, string> = {};
    for (const artifact of buildResult.artifacts) {
      if (artifact.role === "wasm") wasmModules[artifact.path] = artifact.content;
    }

    // Service-level token shared by all instances of this source:className —
    // matches the old `do-service:*` workerd bearer (NOT an entity id).
    const serviceCallerId = `do-service:${serviceKey}`;
    const serviceToken = this.ensureWorkerBearer(serviceCallerId);
    // Keep the egress attribution registered for this class identity.
    this.registerDoEgressCaller(source, className, image.effectiveVersion);

    const env: Record<string, string> = {
      RPC_AUTH_TOKEN: serviceToken,
      WORKER_SOURCE: source,
      WORKER_CLASS_NAME: className,
      WORKERD_SESSION_ID: this.sessionId,
      WORKERD_BOOT_GENERATION: String(this.configBootGeneration()),
      GATEWAY_URL: this.deps.getServerUrl(),
    };
    if (process.env["NATSTACK_TEST_MODE"]) {
      env["NATSTACK_TEST_MODE"] = process.env["NATSTACK_TEST_MODE"];
    }
    if (this.port) env["WORKERD_URL"] = `http://127.0.0.1:${this.port}`;
    const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
    if (gatewayAliases.length > 0) {
      env["GATEWAY_URL_ALIASES"] = JSON.stringify(gatewayAliases);
    }

    return {
      compatibilityDate: "2025-12-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: { "worker.js": bundleContent },
      ...(Object.keys(wasmModules).length > 0 ? { wasmModules } : {}),
      env,
    };
  }

  /** Register a userland DO class's identity (`source:className`) for attributed
   *  egress through the shared listener. The UniversalDO host stamps this id. */
  private registerDoEgressCaller(source: string, className: string, buildKey: string): void {
    const identity = `${source}:${className}`;
    const caller = createVerifiedCaller(`do-service:${identity}`, "worker", {
      callerId: `do-service:${identity}`,
      callerKind: "worker",
      repoPath: source,
      effectiveVersion: buildKey,
    });
    this.deps.registerEgressCaller(identity, caller);
  }

  // =========================================================================
  // Config generation
  // =========================================================================

  private async generateConfig(): Promise<object> {
    const services: object[] = [];

    // Collect DO service names that have been emitted (to avoid duplicating in regular loop)
    const doServiceNames = new Set<string>();

    // ── Internal DO services (one workerd service per source:className) ──
    // Userland DO classes do NOT get per-class services — they load
    // dynamically into the static `universal-do` facet host (built below), so a
    // new userland DO class needs no config change and no workerd restart.
    // Internal DOs (WorkspaceDO, EvalDO, …) stay static (foundational).
    for (const [serviceKey, doService] of this.doServices) {
      if (!isInternalDOSource(doService.source)) continue;
      const { className } = doService;
      // Internal DOs ship as a single pre-built bundle (no wasm artifacts).
      const internalBundle = getInternalDOBundle();
      const bundleContent = internalBundle.bundle;
      doService.buildKey = internalBundle.buildKey;

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
        { name: "WORKERD_BOOT_GENERATION", text: String(this.configBootGeneration()) },
      ];

      // Gateway URL for RPC bridge (DOs use HttpRpcBridge via POST /rpc)
      bindings.push({ name: "GATEWAY_URL", text: this.deps.getServerUrl() });
      const gatewayAliases = this.deps.getServerAliasUrls?.() ?? [];
      if (gatewayAliases.length > 0) {
        bindings.push({ name: "GATEWAY_URL_ALIASES", json: JSON.stringify(gatewayAliases) });
      }

      // EvalDO runs sandboxed agent code and needs the workerd UnsafeEval API
      // (`new Function` is blocked in workerd isolates). `--experimental` is already
      // passed at spawn. `unsafeEval` is a Void union member in workerd's schema, so
      // it must render as `unsafeEval = void` — `null` triggers that in capnpValue
      // (an empty struct `{}` would emit `()`, which workerd rejects: "expected Void").
      if (className === "EvalDO") {
        bindings.push({ name: "UNSAFE_EVAL", unsafeEval: null });
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
            // Pin EvalDO in memory (workerd skips the ~10s idle eviction) so warm eval
            // scope/db survive idle gaps. Namespace-wide — applies only to EvalDO's namespace.
            ...(className === "EvalDO" ? { preventEviction: true } : {}),
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

    // Regular (non-durable) workers are NOT services anymore. They load
    // dynamically into the static `worker-host` service (built below) via
    // `env.LOADER`, so worker create/update/destroy never regenerates config
    // or restarts workerd. Per-instance code+env is served by `/_workercode`.

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

    // Auto-generate router worker + the static dynamic-worker host.
    const hasUserlandDOs = Array.from(this.doServices.values()).some(
      (svc) => !isInternalDOSource(svc.source)
    );
    const hasAnyService = this.instances.size > 0 || doClassNames.length > 0 || hasUserlandDOs;
    if (hasAnyService) {
      // ── Static `worker-host` service: loads regular workers dynamically ──
      // Always present whenever workerd runs, so worker create/destroy never
      // restarts. Reached via the router's WORKER_HOST service binding.
      const gatewayHost = new URL(this.deps.getServerUrl()).host;
      const sharedEgressPort = await this.deps.getSharedEgressPort();
      services.push({
        name: "worker-host",
        worker: {
          modules: [{ name: "host.js", esModule: this.generateWorkerHostCode() }],
          // `experimental` is required for `env.LOADER` (workerLoader) and
          // `ctx.exports`. The host MUST carry it; loaded workers must NOT.
          compatibilityFlags: ["nodejs_compat", "experimental"],
          compatibilityDate: "2025-12-01",
          bindings: [
            { name: "LOADER", workerLoader: { id: "workers" } },
            { name: "GATEWAY", service: { name: "worker-host-gateway" } },
            { name: "EGRESS", service: { name: "worker-host-egress" } },
            { name: "WORKERD_LOADER_SECRET", text: this.loaderSecret },
            { name: "WORKERD_EGRESS_SECRET", text: this.egressSecret },
          ],
        },
      });
      services.push({
        name: "worker-host-gateway",
        external: { address: gatewayHost, http: {} },
      });
      services.push({
        name: "worker-host-egress",
        external: {
          address: `127.0.0.1:${sharedEgressPort}`,
          http: { forwardedProtoHeader: "X-Forwarded-Proto" },
        },
      });

      // ── Static `universal-do` service: hosts ALL userland DO classes as
      // durable facets, loaded dynamically via `env.LOADER`. A new userland DO
      // class needs no config change and no workerd restart — just `/_docode`.
      // Reuses the worker-host gateway + egress external services.
      const universalDoStoragePath = path.join(
        this.deps.statePath,
        ".databases",
        "workerd-universal-do"
      );
      fs.mkdirSync(universalDoStoragePath, { recursive: true });
      services.push({
        name: "universal-do",
        worker: {
          modules: [{ name: "udo.js", esModule: this.generateUniversalDOCode() }],
          compatibilityFlags: ["nodejs_compat", "experimental"],
          compatibilityDate: "2025-12-01",
          bindings: [
            { name: "LOADER", workerLoader: { id: "userland-dos" } },
            { name: "GATEWAY", service: { name: "worker-host-gateway" } },
            { name: "EGRESS", service: { name: "worker-host-egress" } },
            { name: "WORKERD_LOADER_SECRET", text: this.loaderSecret },
            { name: "WORKERD_EGRESS_SECRET", text: this.egressSecret },
          ],
          durableObjectNamespaces: [
            { className: "UniversalDO", uniqueKey: UNIVERSAL_DO_UNIQUE_KEY, enableSql: true },
          ],
          durableObjectStorage: { localDisk: "universal-do-disk" },
        },
      });
      services.push({
        name: "universal-do-disk",
        disk: { path: universalDoStoragePath, writable: true },
      });

      const routerBindings: object[] = [
        { name: "WORKER_HOST", service: { name: "worker-host" } },
        {
          name: "UNIVERSAL_DO",
          durableObjectNamespace: { className: "UniversalDO", serviceName: "universal-do" },
        },
      ];

      // Add DO namespace bindings for the router (durableObjectNamespace, not service).
      // Binding names are source-scoped to match the generated router lookup.
      for (const { className, source, serviceName } of doClassNames) {
        const bindingName = `do_${source.replace(/[^a-zA-Z0-9_]/g, "_")}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        routerBindings.push({
          name: bindingName,
          durableObjectNamespace: { className, serviceName },
        });
      }

      const routerCode = this.generateRouterCode(doClassNames);
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
    doClassNames: { className: string; source: string; serviceName: string }[] = []
  ): string {
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

    // /_u/{encodedKey}/{...method} — userland DO via the UniversalDO facet host.
    // encodedKey already packs source|className|userKey (encoded by doDispatch),
    // so there is no arbitrary-depth ambiguity here. The host decodes it.
    const universalBlock = `
    if (prefix === "_u") {
      const encodedKey = parts[1] ? decodeURIComponent(parts[1]) : "";
      if (!encodedKey) return new Response("Usage: /_u/{key}/{method}", { status: 400 });
      const id = env.UNIVERSAL_DO.idFromName(encodedKey);
      const stub = env.UNIVERSAL_DO.get(id);
      const doRest = parts.slice(2);
      const doUrl = new URL("/" + encodeURIComponent(encodedKey) + (doRest.length ? "/" + doRest.join("/") : ""), url.origin);
      doUrl.search = url.search;
      return stub.fetch(new Request(doUrl, strippedRequest));
    }
`;

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
    if ((prefix === "_w" || prefix === "_u") && request.headers.get("X-NatStack-Dispatch-Secret") !== env.WORKERD_DISPATCH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
${doBlock}${universalBlock}
    // All non-DO traffic → the static worker host, which loads the named
    // worker dynamically. The host parses parts[0] as the instance name, so
    // forward the full path (auth already stripped).
    return env.WORKER_HOST.fetch(strippedRequest);
  }
};
`;
  }

  /**
   * Generate the static `worker-host` module. It loads regular workers
   * dynamically via `env.LOADER` (Cloudflare Worker Loaders), keyed on
   * `${name}@${version}` so updates/rebuilds force a fresh isolate without a
   * workerd restart. It attaches non-forgeable per-load egress identity via the
   * `ctx.exports.EgressGateway` loopback binding (the dynamic worker never sees
   * the props), and forwards outbound traffic through the shared attributed
   * egress listener.
   *
   * This code is constant (no per-instance interpolation) — the only thing that
   * changes per worker is the data served by `/_workercode` + `/_workerversion`.
   */
  private generateWorkerHostCode(): string {
    return `import { WorkerEntrypoint } from "cloudflare:workers";

// Static egress gateway. Identity arrives via non-forgeable per-load props and
// is stamped onto every outbound subrequest; the dynamic worker cannot forge it
// (its own ctx.props is empty). Forwards to the shared attributed egress proxy.
export class EgressGateway extends WorkerEntrypoint {
  async fetch(request) {
    const id = (this.ctx.props && this.ctx.props.id) || "";
    const headers = new Headers(request.headers);
    headers.set("X-NatStack-Egress-Caller", id);
    headers.set("X-NatStack-Egress-Secret", this.env.WORKERD_EGRESS_SECRET);
    return this.env.EGRESS.fetch(new Request(request, { headers }));
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const name = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!name) return new Response("worker-host: missing instance name", { status: 400 });

    const loaderHeaders = { "X-NatStack-Loader-Secret": env.WORKERD_LOADER_SECRET };

    // Current loader-cache version (tiny). 404 → no such worker (destroyed or
    // never created); a stale isolate, if any, is simply never re-addressed.
    const vres = await env.GATEWAY.fetch(
      new Request("http://gateway/_workerversion/" + encodeURIComponent(name), { headers: loaderHeaders })
    );
    if (vres.status === 404) return new Response("Worker not found: " + name, { status: 404 });
    if (vres.status === 503) return new Response("worker-host: code warming", { status: 503, headers: { "Retry-After": "1" } });
    if (!vres.ok) return new Response("worker-host: version lookup failed (" + vres.status + ")", { status: 502 });
    const version = (await vres.json()).version;

    const stub = env.LOADER.get(name + "@" + version, async () => {
      const cres = await env.GATEWAY.fetch(
        new Request("http://gateway/_workercode/" + encodeURIComponent(name), { headers: loaderHeaders })
      );
      if (!cres.ok) throw new Error("worker-host: code fetch failed (" + cres.status + ")");
      const code = await cres.json();
      return {
        compatibilityDate: code.compatibilityDate,
        compatibilityFlags: code.compatibilityFlags,
        mainModule: code.mainModule,
        modules: code.modules,
        env: code.env,
        globalOutbound: ctx.exports.EgressGateway({ props: { id: code.callerId } }),
      };
    });

    // Strip the instance-name prefix so the loaded worker sees /__rpc etc.
    const rest = "/" + parts.slice(1).join("/");
    const fwdUrl = new URL(rest, url.origin);
    fwdUrl.search = url.search;
    try {
      return await stub.getEntrypoint().fetch(new Request(fwdUrl, request));
    } catch (err) {
      if (String((err && err.message) || err).includes("(503)")) {
        return new Response("worker-host: code warming", { status: 503, headers: { "Retry-After": "1" } });
      }
      throw err;
    }
  }
};
`;
  }

  /**
   * Generate the static `universal-do` module. It hosts ALL userland DO classes
   * as durable facets: per request it decodes `source|className|userKey` from
   * the object key, dynamically loads the inner DO class via `env.LOADER`
   * (keyed `source:className@version` for reload-on-change), runs it as a
   * `ctx.facets` facet, and forwards the inner DO's existing `fetch` handler.
   * One host object per `(source,className,userKey)` → one facet → 1:1 identity
   * (alarms/websockets/storage). Egress is attributed per `source:className`
   * via the `ctx.exports.EgressGateway` loopback (non-forgeable props).
   */
  private generateUniversalDOCode(): string {
    return `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class EgressGateway extends WorkerEntrypoint {
  async fetch(request) {
    const id = (this.ctx.props && this.ctx.props.id) || "";
    const headers = new Headers(request.headers);
    headers.set("X-NatStack-Egress-Caller", id);
    headers.set("X-NatStack-Egress-Secret", this.env.WORKERD_EGRESS_SECRET);
    return this.env.EGRESS.fetch(new Request(request, { headers }));
  }
}

function decodeKey(encoded) {
  const p = encoded.split("|");
  return {
    source: decodeURIComponent(p[0] || ""),
    className: decodeURIComponent(p[1] || ""),
    userKey: decodeURIComponent(p[2] || ""),
  };
}

export class UniversalDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const encodedKey = parts[0] ? decodeURIComponent(parts[0]) : "";
    if (!encodedKey) return new Response("universal-do: missing key", { status: 400 });
    const { source, className, userKey } = decodeKey(encodedKey);
    if (!source || !className) return new Response("universal-do: bad key", { status: 400 });

    const ctx = this.ctx;
    const env = this.env;
    const identity = source + ":" + className;
    const loaderHeaders = { "X-NatStack-Loader-Secret": env.WORKERD_LOADER_SECRET };

    const vres = await env.GATEWAY.fetch(new Request(
      "http://gateway/_doversion/" + encodeURIComponent(source) + "/" + encodeURIComponent(className) +
        "?objectKey=" + encodeURIComponent(userKey),
      { headers: loaderHeaders }
    ));
    if (vres.status === 404) return new Response("DO class not found: " + identity, { status: 404 });
    if (vres.status === 503) return new Response("universal-do: code warming", { status: 503, headers: { "Retry-After": "1" } });
    if (!vres.ok) return new Response("universal-do: version lookup failed (" + vres.status + ")", { status: 502 });
    const version = (await vres.json()).version;

    // Constant facet name (one logical DO per host object → 1:1). Keeping it
    // constant makes the on-disk facet layout portable across host objects,
    // which is what lets cloneDO/destroyDO copy/delete facet storage by host
    // hash. The host object id already encodes (source,className,userKey).
    const facet = this.ctx.facets.get("do", async () => {
      // _doversion already incorporates object-specific builds. Do not include
      // userKey in the loader cache key, or every DO object loads a duplicate
      // copy of the same module graph.
      const worker = env.LOADER.get(identity + "@" + version, async () => {
        const cres = await env.GATEWAY.fetch(new Request(
          "http://gateway/_docode/" + encodeURIComponent(source) + "/" + encodeURIComponent(className) +
            "?objectKey=" + encodeURIComponent(userKey),
          { headers: loaderHeaders }
        ));
        if (!cres.ok) throw new Error("universal-do: code fetch failed (" + cres.status + ")");
        const code = await cres.json();
        const modules = { ...code.modules };
        // Decode any base64 wasm modules (e.g. terminal/Ink yoga.wasm) into the
        // ArrayBuffer module shape the loader expects.
        if (code.wasmModules) {
          for (const name of Object.keys(code.wasmModules)) {
            const bin = atob(code.wasmModules[name]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            modules[name] = { wasm: bytes.buffer };
          }
        }
        return {
          compatibilityDate: code.compatibilityDate,
          compatibilityFlags: code.compatibilityFlags,
          mainModule: code.mainModule,
          modules: modules,
          env: code.env,
          globalOutbound: ctx.exports.EgressGateway({ props: { id: identity } }),
        };
      });
      return { class: worker.getDurableObjectClass(className) };
    });

    // Forward to the inner DO's existing fetch handler, which parses its own
    // objectKey from the first path segment: /{userKey}/{method}.
    const innerRest = parts.slice(1);
    const innerUrl = new URL(
      "/" + encodeURIComponent(userKey) + (innerRest.length ? "/" + innerRest.join("/") : ""),
      url.origin
    );
    innerUrl.search = url.search;
    try {
      return await facet.fetch(new Request(innerUrl, request));
    } catch (err) {
      if (String((err && err.message) || err).includes("(503)")) {
        return new Response("universal-do: code warming", { status: 503, headers: { "Retry-After": "1" } });
      }
      throw err;
    }
  }
}

export default { fetch() { return new Response("universal-do host"); } };
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
    this.pendingConfigWrites = [];
    const body = this.capnpValue(config, 1);
    return `using Workerd = import "/workerd/workerd.capnp";\n\nconst config :Workerd.Config = ${body};\n`;
  }

  /**
   * Flush bundle/wasm files collected during `toCapnpText` to disk asynchronously.
   * (Serialization stays sync for the recursion; the heavy IO is async so it
   * never blocks the relay event loop during a (re)start.)
   */
  private async flushConfigWrites(): Promise<void> {
    const writes = this.pendingConfigWrites;
    this.pendingConfigWrites = [];
    await Promise.all(
      writes.map((w) => fs.promises.writeFile(path.join(this.configDir, w.filename), w.content))
    );
  }

  private bundleFileCounter = 0;
  private pendingConfigWrites: Array<{ filename: string; content: string | Buffer }> = [];

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
        // esModule bundles: collect for async flush, reference via embed.
        if (k === "esModule" && typeof v === "string") {
          const filename = `bundle-${this.bundleFileCounter++}.js`;
          this.pendingConfigWrites.push({ filename, content: v });
          return `${indent}${k} = embed "${filename}",`;
        }
        // wasm module bindings: value is base64; decode to binary + embed.
        if (k === "wasm" && typeof v === "string") {
          const filename = `module-${this.bundleFileCounter++}.wasm`;
          this.pendingConfigWrites.push({ filename, content: Buffer.from(v, "base64") });
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

  /**
   * Coalesced restart. Concurrent callers share one in-flight restart; a config
   * change made during a restart triggers at most one follow-up. Errors
   * propagate to all current waiters (no infinite retry loop).
   */
  private restartWorkerd(): Promise<void> {
    const myEpoch = ++this.requestedEpoch;
    return this.ensureRestartAtLeast(myEpoch);
  }

  private async ensureRestartAtLeast(epoch: number): Promise<void> {
    while (this.appliedEpoch < epoch) {
      if (this.restartRunning) {
        await this.restartRunning;
        continue;
      }
      // Snapshot the highest requested epoch; the config generated below reads
      // the latest doServices/instances, so it covers at least this epoch.
      const applying = this.requestedEpoch;
      this.restartRunning = this._restartWorkerdInner();
      try {
        await this.restartRunning;
      } finally {
        this.restartRunning = null;
      }
      this.appliedEpoch = Math.max(this.appliedEpoch, applying);
    }
  }

  private async _restartWorkerdInner(): Promise<void> {
    const correlationId = crypto.randomUUID();
    const previousGeneration = this.bootGeneration === 0 ? null : this.bootGeneration;
    const nextGeneration = this.bootGeneration + 1;
    const hadRunningProcess = this.process !== null;
    if (hadRunningProcess) {
      await this.emitRestartBegin({
        correlationId,
        generation: nextGeneration,
        reason: "planned",
      });
    }
    await this.stopWorkerd("planned-restart");

    if (this.instances.size === 0 && this.doServices.size === 0) return;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.pendingBootGeneration = nextGeneration;
        await this.startWorkerdOnce();
        this.bootGeneration = nextGeneration;
        this.pendingBootGeneration = null;
        this.writeBootGeneration(this.bootGeneration);
        if (hadRunningProcess) {
          await this.emitRestartReady({
            correlationId,
            generation: this.bootGeneration,
            previousGeneration,
            reason: "planned",
          });
        }
        return;
      } catch (err) {
        lastError = err;
        this.pendingBootGeneration = null;
        const detail = this.formatWorkerdStartupError(err);
        if (attempt < 3) {
          log.warn(
            `workerd startup attempt ${attempt} did not become ready; retrying with a fresh port. ${detail}`
          );
        } else {
          log.warn(`workerd startup attempt ${attempt} failed. ${detail}`);
        }
        await this.stopWorkerd("startup-retry");
      }
    }

    throw lastError instanceof Error ? lastError : new Error("workerd failed to start");
  }

  private configBootGeneration(): number {
    return this.pendingBootGeneration ?? this.bootGeneration;
  }

  private readBootGeneration(): number {
    try {
      const text = fs.readFileSync(this.bootGenerationFile, "utf8").trim();
      const parsed = Number.parseInt(text, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Failed to read workerd boot generation:", err);
      }
      return 0;
    }
  }

  private writeBootGeneration(generation: number): void {
    fs.mkdirSync(path.dirname(this.bootGenerationFile), { recursive: true });
    fs.writeFileSync(this.bootGenerationFile, `${generation}\n`);
  }

  private async emitRestartBegin(event: RestartBeginEvent): Promise<void> {
    for (const hook of this.restartBeginHooks) {
      try {
        await hook(event);
      } catch (err) {
        log.warn("restart begin hook failed:", err);
      }
    }
  }

  private async emitRestartReady(event: RestartReadyEvent): Promise<void> {
    for (const hook of this.restartReadyHooks) {
      try {
        await hook(event);
      } catch (err) {
        log.warn("restart ready hook failed:", err);
      }
    }
  }

  private async startWorkerdOnce(): Promise<void> {
    const config = await this.generateConfig();
    const configPath = path.join(this.configDir, "config.capnp");
    const capnpText = this.toCapnpText(config as Record<string, unknown>);
    await this.flushConfigWrites();
    await fs.promises.writeFile(configPath, capnpText);

    const binary = this.findWorkerdBinary();
    if (!this.inspectorPort && workerdInspectorEnabled()) {
      const { findServicePort } = await import("@natstack/port-utils");
      this.inspectorPort = await findServicePort("workerdInspector");
    }
    const args = [
      "serve",
      // Required: the static worker-host uses `workerLoader` (env.LOADER) and
      // `ctx.exports`, both gated behind workerd's experimental features.
      "--experimental",
      ...(this.inspectorPort ? [`--inspector-addr=127.0.0.1:${this.inspectorPort}`] : []),
      configPath,
    ];

    this.process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    const spawnedProcess = this.process;
    const spawnedPid = spawnedProcess.pid;
    this.workerdStartedAtMs = Date.now();
    this.lastWorkerdRssBytes = null;
    this.startWorkerdMemorySampling(spawnedPid);
    this.lastWorkerdStartupOutput = [];

    spawnedProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.rememberWorkerdStartupOutput(`stdout: ${line}`);
        log.info(`[workerd] ${line}`);
      }
    });

    spawnedProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        if (this.shouldSuppressWorkerdStderr(line)) return;
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
        this.logWorkerdExit(code, signal, spawnedPid);
        if (this.process === spawnedProcess) this.process = null;
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
        if (this.process === spawnedProcess) this.process = null;
        if (!settled) {
          settled = true;
          reject(new Error(`workerd failed to start: ${err.message}`));
        }
      };

      spawnedProcess.on("exit", onExit);
      spawnedProcess.on("error", onError);

      this.waitForHttpReady(
        this.deps.workerdStartupReadyTimeoutMs ?? DEFAULT_WORKERD_STARTUP_READY_TIMEOUT_MS
      ).then(
        () => {
          if (settled) return;
          settled = true;
          // Keep the exit/error handlers for ongoing monitoring, but replace
          // them with non-rejecting versions since the promise is settled.
          spawnedProcess.removeListener("exit", onExit);
          spawnedProcess.removeListener("error", onError);
          spawnedProcess.on("exit", (code, signal) => {
            this.logWorkerdExit(code, signal, spawnedPid);
            if (this.process === spawnedProcess) this.process = null;
          });
          spawnedProcess.on("error", (err) => {
            log.error("workerd process error:", err);
            if (this.process === spawnedProcess) this.process = null;
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

  private startWorkerdMemorySampling(pid: number | undefined): void {
    if (this.workerdMemorySampleTimer) {
      clearInterval(this.workerdMemorySampleTimer);
      this.workerdMemorySampleTimer = null;
    }
    if (!pid || process.platform !== "linux") return;
    this.lastWorkerdRssBytes = this.readProcessRssBytes(pid);
    this.workerdMemorySampleTimer = setInterval(() => {
      const rss = this.readProcessRssBytes(pid);
      if (rss !== null) this.lastWorkerdRssBytes = rss;
    }, 5_000);
    this.workerdMemorySampleTimer.unref?.();
  }

  private stopWorkerdMemorySampling(): void {
    if (!this.workerdMemorySampleTimer) return;
    clearInterval(this.workerdMemorySampleTimer);
    this.workerdMemorySampleTimer = null;
  }

  private readProcessRssBytes(pid: number): number | null {
    if (process.platform !== "linux") return null;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    } catch {
      return null;
    }
  }

  private logWorkerdExit(
    code: number | null,
    signal: string | null,
    pid: number | undefined
  ): void {
    log.info(
      `workerd exited (code=${code}, signal=${signal}); diagnostics=${JSON.stringify(
        this.workerdDiagnostics(pid)
      )}`
    );
    this.stopWorkerdMemorySampling();
  }

  private workerdDiagnostics(pid: number | undefined): Record<string, unknown> {
    const currentRssBytes = pid ? this.readProcessRssBytes(pid) : null;
    if (currentRssBytes !== null) this.lastWorkerdRssBytes = currentRssBytes;
    return {
      pid: pid ?? null,
      port: this.port,
      uptimeMs: this.workerdStartedAtMs ? Date.now() - this.workerdStartedAtMs : null,
      rssBytes: currentRssBytes,
      lastRssBytes: this.lastWorkerdRssBytes,
      regularWorkers: this.instances.size,
      doServices: this.doServices.size,
      doObjectBuilds: this.doObjectBuilds.size,
      runtimeImages: this.runtimeImages.list().length,
      runtimeImageRebinds: this.runtimeImageRebinds.size,
      bootGeneration: this.bootGeneration,
      pendingBootGeneration: this.pendingBootGeneration,
    };
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

  private shouldSuppressWorkerdStderr(line: string): boolean {
    if (isExpectedEvalIdleEvictionWorkerdStderr(line)) {
      this.suppressNextExpectedWorkerdStack = !line.includes("\nstack:");
      return true;
    }
    if (this.suppressNextExpectedWorkerdStack) {
      this.suppressNextExpectedWorkerdStack = false;
      if (line.startsWith("stack:")) return true;
    }
    return false;
  }

  private recentWorkerdOutputSuffix(): string {
    if (this.lastWorkerdStartupOutput.length === 0) return "";
    return `; recent workerd output:\n${this.lastWorkerdStartupOutput.join("\n")}`;
  }

  private formatWorkerdStartupError(err: unknown): string {
    return errorMessage(err).replace(/\s+/gu, " ").slice(0, 1200);
  }

  private async stopWorkerd(reason = "unspecified"): Promise<void> {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      log.info(
        `stopping workerd (${reason}); diagnostics=${JSON.stringify(
          this.workerdDiagnostics(proc.pid)
        )}`
      );
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
          log.warn(
            `workerd did not exit after SIGTERM (${reason}); sending SIGKILL; diagnostics=${JSON.stringify(
              this.workerdDiagnostics(proc.pid)
            )}`
          );
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

  /**
   * Register a batch of DO classes. Internal DO classes are static workerd
   * services and trigger a single restart when new. Userland DO classes load
   * through universal-do; startup should prefer route metadata + lazy
   * ensureDORoute unless an explicit prewarm is required.
   */
  async registerAllDOClasses(
    doClasses: Array<{ source: string; className: string }>
  ): Promise<void> {
    let internalAdded = false;
    for (const { source, className } of doClasses) {
      const serviceKey = doServiceKey(source, className);
      if (this.doServices.has(serviceKey)) continue;

      try {
        const imageId = `do-service:${serviceKey}`;
        const image = isInternalDOSource(source)
          ? null
          : await this.bindRuntimeImage(imageId, source, undefined);
        const buildKey = isInternalDOSource(source)
          ? getInternalDOBundle().buildKey
          : assertPresent(image).buildKey;
        const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
        const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        this.doServices.set(serviceKey, {
          buildKey,
          className,
          ...(image ? { imageId: image.id } : {}),
          serviceName,
          source,
        });
        if (!isInternalDOSource(source)) {
          this.registerRoutesForDoClass(source, className);
          this.registerDoEgressCaller(source, className, assertPresent(image).effectiveVersion);
        } else {
          internalAdded = true;
        }
      } catch (err) {
        log.warn(`Skipping DO class ${source}:${className} — build failed:`, err);
      }
    }

    // Only INTERNAL DO classes change the static config (and need a restart);
    // userland classes load on demand into the static universal-do host.
    if (internalAdded) {
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
  async ensureDOClass(
    source: string,
    className: string,
    opts: {
      scopeRef?: string;
      objectKey?: string;
      imageId?: string;
    } = {}
  ): Promise<string | undefined> {
    const serviceKey = doServiceKey(source, className);
    const isNew = !this.doServices.has(serviceKey);
    let buildKey: string | undefined;
    let image: RuntimeImageRecord | null = null;
    if (isNew) {
      const sourceSegments = source.split("/").filter(Boolean);
      if (!isInternalDOSource(source) && sourceSegments.length !== 2) {
        throw new Error(`DO source path must be exactly 2 segments, got: "${source}"`);
      }
      if (isInternalDOSource(source)) {
        buildKey = getInternalDOBundle().buildKey;
      } else {
        image = await this.bindRuntimeImage(`do-service:${serviceKey}`, source, opts.scopeRef);
        buildKey = image.buildKey;
      }
      const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
      const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      this.doServices.set(serviceKey, {
        buildKey,
        className,
        ...(image ? { imageId: image.id } : {}),
        serviceName,
        source,
        scopeRef: image?.scopeRef ?? opts.scopeRef,
      });
      if (!isInternalDOSource(source)) {
        this.registerRoutesForDoClass(source, className);
        this.registerDoEgressCaller(source, className, assertPresent(image).effectiveVersion);
      }
    }

    const serviceScopeRef =
      image?.scopeRef ?? this.doServices.get(serviceKey)?.scopeRef ?? opts.scopeRef;
    if (!isInternalDOSource(source) && serviceScopeRef && opts.objectKey) {
      const imageId =
        opts.imageId ?? canonicalEntityId({ kind: "do", source, className, key: opts.objectKey });
      image = await this.bindRuntimeImage(imageId, source, serviceScopeRef);
      buildKey = image.buildKey;
    }

    if (!isInternalDOSource(source) && serviceScopeRef && opts.objectKey && image) {
      this.doObjectBuilds.set(doObjectBuildKey(source, className, opts.objectKey), {
        imageId: image.id,
        scopeRef: serviceScopeRef,
        buildKey: image.buildKey,
      });
    }

    // Userland DO classes load dynamically into the static `universal-do` facet
    // host — registering one needs NO config change and NO restart. Just make
    // sure workerd is up so the host is serving.
    if (!isInternalDOSource(source)) {
      await this.ensureWorkerdRunning();
      return buildKey;
    }

    // Internal DOs are static workerd services: a new one requires a config
    // regeneration + restart (startup-rare, foundational classes only).
    if (isNew) {
      await this.restartWorkerd();
    } else if (!this.process || this.process.exitCode !== null) {
      await this.restartWorkerd();
    }
    // Do NOT probe-and-restart a live workerd (false positives killed all DOs
    // and fed the relay/restart cascade). The relay path retries transients.
    return buildKey;
  }

  /**
   * Ensure a Durable Object class is registered and workerd is running.
   * DOs self-bootstrap from env bindings on first request — no external bootstrap call needed.
   * Used by the unified RPC relay retry path when a DO class is missing after
   * a rebuild/restart race.
   */
  async ensureDO(
    source: string,
    className: string,
    objectKey: string,
    opts: { contextId?: string; ref?: string } = {}
  ): Promise<void> {
    const explicitRef = explicitScopeRef(opts.ref);
    const bootstrapMainBound = isBootstrapMainBoundDo(source, className);
    const scopeRef = bootstrapMainBound ? opts.ref : explicitRef;
    await this.ensureDOClass(source, className, { scopeRef, objectKey });
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

  /** Directory holding the UniversalDO facet storage (per-host-object files). */
  private universalDoStorageDir(): string {
    return path.join(
      this.deps.statePath,
      ".databases",
      "workerd-universal-do",
      UNIVERSAL_DO_UNIQUE_KEY
    );
  }

  /** workerd host-object storage hash for a userland DO ref (its facet lives in
   *  `<dir>/<hash>.1.sqlite`, with `<hash>.sqlite`/`.facets` siblings). */
  private universalHostHash(ref: DORef): string {
    return computeWorkerdObjectIdHash(UNIVERSAL_DO_UNIQUE_KEY, encodeUniversalKey(ref));
  }

  /**
   * Clone a DO's storage to a new object key. The clone starts with identical
   * state. Used for channel forking.
   *
   * Userland DOs run as facets of the static UniversalDO host: each host object
   * owns one facet whose storage is the set of files prefixed by the host's id
   * hash (`<hash>.sqlite`, `<hash>.1.sqlite`, `<hash>.facets`, + WAL/SHM). The
   * facet name is constant, so the layout is portable across host objects —
   * cloning copies every `<srcHash>.*` file to `<tgtHash>.*` (WAL/SHM included
   * for a consistent snapshot).
   */
  async cloneDO(ref: DORef, newObjectKey: string): Promise<DORef> {
    if (isInternalDOSource(ref.source)) {
      throw new Error(`cloneDO is not supported for internal DO source "${ref.source}"`);
    }
    const dir = this.universalDoStorageDir();
    const srcHash = this.universalHostHash(ref);
    const tgtHash = this.universalHostHash({ ...ref, objectKey: newObjectKey });

    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    const srcFiles = files.filter((f) => f.startsWith(`${srcHash}.`));
    if (srcFiles.length === 0) {
      throw new Error(
        `Source DO storage not found: ${ref.className}/${ref.objectKey} (no facet storage for host ${srcHash} under ${dir})`
      );
    }
    await Promise.all(
      srcFiles.map((f) =>
        fs.promises.copyFile(
          path.join(dir, f),
          path.join(dir, `${tgtHash}${f.slice(srcHash.length)}`)
        )
      )
    );
    return { source: ref.source, className: ref.className, objectKey: newObjectKey };
  }

  /**
   * Destroy a userland DO's facet storage — every file prefixed by the host id
   * hash (main + facet + index + WAL/SHM). Used to clean up orphaned clones on
   * fork failure.
   */
  async destroyDO(ref: DORef): Promise<void> {
    if (isInternalDOSource(ref.source)) {
      throw new Error(`destroyDO is not supported for internal DO source "${ref.source}"`);
    }
    const dir = this.universalDoStorageDir();
    const hash = this.universalHostHash(ref);
    const files = await fs.promises.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      files
        .filter((f) => f.startsWith(`${hash}.`))
        .map((f) =>
          fs.promises.unlink(path.join(dir, f)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
          })
        )
    );
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdown(): Promise<void> {
    await this.stopWorkerd("shutdown");

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
    this.doObjectBuilds.clear();

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
  async onSourceRebuilt(
    source: string,
    doClasses?: Array<{ className: string }>,
    trigger?: StateAdvancedEvent,
    completedBuildKey?: string
  ): Promise<void> {
    const head = trigger?.head ?? "main";
    // Dynamic loading makes a rebuild a loader-cache eviction, NOT a restart:
    // runtime image generations advance, so the next request loads fresh code.
    // No workerd restart — concurrent agents keep running.

    const completed = completedBuildKey ? this.deps.getBuildByKey(completedBuildKey) : null;
    const updateImageFromCompleted = (
      imageId: string,
      scopeRef: string | undefined
    ): RuntimeImageRecord | null => {
      if (!completedBuildKey || !trigger || !completed) return null;
      return this.runtimeImages.upsert({
        id: imageId,
        source,
        unitName: completed.metadata.name,
        stateHash: trigger.stateHash,
        buildKey: completedBuildKey,
        effectiveVersion: completed.metadata.ev,
        ...(scopeRef ? { scopeRef } : {}),
      });
    };

    // Workers tracking this head reload on their next request.
    for (const instance of this.instances.values()) {
      if (instance.source === source && scopeTracksHead(instance.scopeRef, head)) {
        const image = updateImageFromCompleted(instance.runtimeImageId, instance.scopeRef);
        if (image) {
          instance.buildKey = image.buildKey;
          instance.effectiveVersion = image.effectiveVersion;
          this.advanceWorkerCodeVersion(instance, image.generation);
          this.registerEgressCaller(instance);
        }
      }
    }

    // Refresh the build version for this source's userland DO classes so their
    // facets reload. (Internal DOs aren't rebuilt through this push path.)
    const trackedServices = Array.from(this.doServices.values()).filter(
      (s) => s.source === source && scopeTracksHead(s.scopeRef, head)
    );
    const trackedObjects = Array.from(this.doObjectBuilds.entries()).filter(
      ([key, build]) => key.startsWith(`${source}:`) && scopeTracksHead(build.scopeRef, head)
    );
    for (const svc of trackedServices) {
      if (!svc.imageId) continue;
      const image = updateImageFromCompleted(svc.imageId, svc.scopeRef);
      if (image) {
        svc.buildKey = image.buildKey;
        this.registerDoEgressCaller(svc.source, svc.className, image.effectiveVersion);
      }
    }
    for (const [key, objectBuild] of trackedObjects) {
      const image = updateImageFromCompleted(objectBuild.imageId, objectBuild.scopeRef);
      if (image) {
        this.doObjectBuilds.set(key, { ...objectBuild, buildKey: image.buildKey });
      }
    }

    // Reconcile DO classes for this source against the new manifest — add new,
    // drop removed. All loader-cache changes; no restart.
    if (doClasses && head === "main") {
      const newClassNames = new Set(doClasses.map((c) => c.className));
      for (const [serviceKey, svc] of Array.from(this.doServices.entries())) {
        if (svc.source !== source || newClassNames.has(svc.className)) continue;
        this.revokeWorkerBearer(`do-service:${serviceKey}`);
        this.deps.unregisterEgressCaller(`${svc.source}:${svc.className}`);
        this.doServices.delete(serviceKey);
        if (svc.imageId) this.runtimeImages.delete(svc.imageId);
        for (const key of Array.from(this.doObjectBuilds.keys())) {
          if (key.startsWith(`${source}:${svc.className}/`)) {
            const objectBuild = this.doObjectBuilds.get(key);
            if (objectBuild) this.runtimeImages.delete(objectBuild.imageId);
            this.doObjectBuilds.delete(key);
          }
        }
        this.deps.routeRegistry?.unregisterDoRoutes(source, svc.className);
        log.info(`Unregistered stale DO class ${serviceKey} after manifest change`);
      }
      for (const { className } of doClasses) {
        const serviceKey = `${source}:${className}`;
        if (this.doServices.has(serviceKey)) continue;
        const imageId = `do-service:${serviceKey}`;
        const image = updateImageFromCompleted(imageId, undefined);
        if (!image) continue;
        const sourceSanitized = source.replace(/[^a-zA-Z0-9_]/g, "_");
        const serviceName = `do_${sourceSanitized}_${className.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        this.doServices.set(serviceKey, {
          buildKey: image.buildKey,
          className,
          imageId,
          serviceName,
          source,
        });
        this.registerRoutesForDoClass(source, className);
        this.registerDoEgressCaller(source, className, image.effectiveVersion);
        log.info(`Registered new DO class ${source}:${className} from push (no restart)`);
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
      if (doClasses && head === "main") {
        for (const { className } of doClasses) {
          liveDoClasses.add(className);
        }
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
  }
}
