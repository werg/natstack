/**
 * WorkerdManager — Process lifecycle for workerd (Cloudflare V8 isolate runtime).
 *
 * Manages:
 * - Locating the workerd binary
 * - Worker instance lifecycle (create, update, destroy)
 * - Context/token provisioning per instance
 * - JSON config generation with auto-generated router worker
 * - workerd child process management (start, restart, stop)
 */

import { spawn, type ChildProcess } from "child_process";
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

    // Restart workerd if there are remaining instances
    if (this.instances.size > 0) {
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

    // Auto-generate router worker
    if (instanceNames.length > 0) {
      const routerBindings = instanceNames.map((name) => ({
        name: `worker_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
        service: { name },
      }));

      const routerCode = this.generateRouterCode(instanceNames);

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
      sockets: instanceNames.length > 0
        ? [{
            name: "http",
            address: `*:${this.port}`,
            http: {},
            service: { name: "router" },
          }]
        : [],
    };
  }

  private generateRouterCode(instanceNames: string[]): string {
    const cases = instanceNames.map((name) => {
      const bindingName = `worker_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      return `    if (prefix === ${JSON.stringify(name)}) return env.${bindingName}.fetch(new Request(newUrl, request));`;
    });

    return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const prefix = parts[0] || "";
    const rest = "/" + parts.slice(1).join("/");
    const newUrl = new URL(rest, url.origin);
    newUrl.search = url.search;
${cases.join("\n")}
    return new Response("Worker not found: " + prefix, { status: 404 });
  }
};
`;
  }

  // =========================================================================
  // Process lifecycle
  // =========================================================================

  private async restartWorkerd(): Promise<void> {
    this.stopWorkerd();

    if (this.instances.size === 0) return;

    const config = await this.generateConfig();
    const configPath = path.join(this.configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const binary = this.findWorkerdBinary();

    this.process = spawn(binary, ["serve", "--experimental-json-config", configPath], {
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

    this.process.on("exit", (code, signal) => {
      log.info(`workerd exited (code=${code}, signal=${signal})`);
      this.process = null;
    });

    this.process.on("error", (err) => {
      log.error("workerd process error:", err);
      this.process = null;
    });

    // Wait briefly for startup
    await new Promise((resolve) => setTimeout(resolve, 500));

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
