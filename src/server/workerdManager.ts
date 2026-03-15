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
import type { TokenManager } from "../shared/tokenManager.js";
import type { FsService } from "../shared/fsService.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerdManager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerBinding =
  | { type: "service"; worker: string }
  | { type: "text"; value: string }
  | { type: "json"; value: unknown };

/** workerd resource limits (passed directly to worker config). */
export interface WorkerLimits {
  /** CPU time limit per request in milliseconds. */
  cpuMs: number;
  /** Maximum subrequests (outbound fetches) per invocation. */
  subrequests?: number;
}

export interface WorkerCreateOptions {
  source: string;
  contextId: string;
  /** Resource limits enforced by workerd per request. Required. */
  limits: WorkerLimits;
  name?: string;
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
  token: string;
  env: Record<string, string>;
  bindings: Record<string, WorkerBinding>;
  stateArgs?: Record<string, unknown>;
  limits?: WorkerLimits;
  buildKey?: string;
  /** Git ref this instance is built at (branch, tag, or commit SHA). */
  ref?: string;
  status: "building" | "starting" | "running" | "stopped" | "error";
}

export interface WorkerdManagerDeps {
  tokenManager: TokenManager;
  fsService: FsService;
  rpcPort: number;
  getBuild: (unitPath: string, ref?: string) => Promise<BuildResult>;
  /** Workspace root path — used for DO storage (localDisk). */
  workspacePath: string;
  /** PubSub HTTP base URL — injected as PUBSUB_URL binding for DOs */
  pubsubUrl?: string;
  /** Server HTTP base URL (for harness API) — injected as SERVER_URL binding for DOs */
  serverUrl?: string;
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
  /** Session ID — generated once per WorkerdManager lifetime, used for restart detection in bootstrap. */
  private sessionId = crypto.randomUUID();

  constructor(deps: WorkerdManagerDeps) {
    this.deps = deps;
    this.configDir = path.join(os.tmpdir(), `natstack-workerd-${process.pid}`);
    fs.mkdirSync(this.configDir, { recursive: true });
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
      limits: options.limits,  // mandatory — always present
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
    } catch (error) {
      // Rollback: clean up token, context registration, and instance map entry
      instance.status = "error";
      this.instances.delete(name);
      this.deps.tokenManager.revokeToken(callerId);
      this.deps.fsService.unregisterCallerContext(callerId);
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
    this.instances.delete(name);

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
    if (updates.limits !== undefined) instance.limits = updates.limits;
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

      const bindings: object[] = [
        { name: "RPC_WS_URL", text: `ws://127.0.0.1:${this.deps.rpcPort}` },
        { name: "RPC_AUTH_TOKEN", text: serviceToken },
        // Source-scoped class identity
        { name: "WORKER_SOURCE", text: doService.source },
        { name: "WORKER_CLASS_NAME", text: className },
      ];

      // PubSub and Server URLs for direct DO communication
      if (this.deps.pubsubUrl) {
        bindings.push({ name: "PUBSUB_URL", text: this.deps.pubsubUrl });
      }
      if (this.deps.serverUrl) {
        bindings.push({ name: "SERVER_URL", text: this.deps.serverUrl });
      }

      // DO storage: create a disk service and reference it by name
      const diskServiceName = `${doService.serviceName}_disk`;
      const doStoragePath = path.join(this.deps.workspacePath, ".databases", "workerd-do");
      fs.mkdirSync(doStoragePath, { recursive: true });

      // Network service for outbound fetch (PubSub HTTP, Server harness API).
      // DOs are autonomous — they make direct HTTP calls to localhost services.
      const networkServiceName = `${doService.serviceName}_network`;

      const workerDef: Record<string, unknown> = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2025-12-01",
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
      services.push({ name: networkServiceName, network: { allow: ["public", "local"], deny: [] } });
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

      // Build bindings array
      const bindings: object[] = [
        { name: "RPC_WS_URL", text: `ws://127.0.0.1:${this.deps.rpcPort}` },
        { name: "RPC_AUTH_TOKEN", text: instance.token },
        { name: "WORKER_ID", text: instance.name },
        { name: "CONTEXT_ID", text: instance.contextId },
      ];

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

      // Build workerd service config
      const workerDef: {
        modules: object[];
        bindings: object[];
        compatibilityDate: string;
        limits?: { cpuMs?: number; subrequests?: number };
      } = {
        modules: [{ name: "worker.js", esModule: bundleContent }],
        bindings,
        compatibilityDate: "2024-01-01",
      };

      // Apply resource limits
      if (instance.limits) {
        const { cpuMs, subrequests } = instance.limits;
        const limitsObj: { cpuMs?: number; subrequests?: number } = {};
        if (cpuMs != null) limitsObj.cpuMs = cpuMs;
        if (subrequests != null) limitsObj.subrequests = subrequests;
        if (Object.keys(limitsObj).length > 0) workerDef.limits = limitsObj;
      }

      services.push({ name, worker: workerDef });
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

    return {
      services,
      sockets: hasAnyService
        ? [{
            name: "http",
            address: `*:${this.port}`,
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
    let doBlock = "";
    if (doClassNames.length > 0) {
      doBlock = `
    // /_w/{source0}/{source1}/{className}/{objectKey}/{...method} — source-scoped DO routes
    if (prefix === "_w") {
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
        const doUrl = new URL("/" + doRest.join("/"), url.origin);
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
    this.stopWorkerd();

    if (this.instances.size === 0 && this.doServices.size === 0) return;

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

  private stopWorkerd(): void {
    if (this.process) {
      const proc = this.process;
      this.process = null;
      proc.kill("SIGTERM");
      // Give the process a moment to release its port
      // (restartWorkerd awaits 500ms anyway, so this is mostly for shutdown)
    }
  }

  async restartAll(): Promise<void> {
    await this.restartWorkerd();
  }

  /**
   * Ensure a Durable Object is reachable: service registered, process alive, identity bootstrapped.
   * Idempotent — always safe to call. The single codepath for making a DO available.
   */
  async ensureDO(source: string, className: string, objectKey: string): Promise<void> {
    // Ensure service class is registered (idempotent)
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
      await this.restartWorkerd();
    }

    // Ensure workerd process is alive (may have crashed since service was registered)
    if (!this.process || this.process.exitCode !== null) {
      await this.restartWorkerd();
    }

    // Bootstrap identity (idempotent — same sessionId = no-op for cleanup)
    await this.bootstrapDO(source, className, objectKey);
  }

  /**
   * Bootstrap a DO with its identity. Called by ensureDO after service registration.
   * The DO stores doRef + sessionId in SQLite for restart detection.
   * Same sessionId = no cleanup (idempotent). Different sessionId = restart detected.
   */
  private async bootstrapDO(source: string, className: string, objectKey: string): Promise<void> {
    if (!this.port) {
      throw new Error(`Cannot bootstrap DO ${source}:${className}/${objectKey}: workerd port not available`);
    }

    const doRef = { source, className, objectKey };
    const basePath = `/_w/${source}/${encodeURIComponent(className)}/${encodeURIComponent(objectKey)}`;
    const url = `http://127.0.0.1:${this.port}${basePath}/bootstrap`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([doRef, this.sessionId]),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`DO bootstrap failed (${resp.status}): ${body}`);
    }
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  async shutdown(): Promise<void> {
    this.stopWorkerd();

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
   */
  async onSourceRebuilt(source: string): Promise<void> {
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
