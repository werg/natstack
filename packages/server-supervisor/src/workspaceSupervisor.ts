import * as path from "node:path";
import { createDevLogger } from "@natstack/dev-log";
import { createProcessAdapter } from "@natstack/process-adapter";
import { CentralDataManager } from "@natstack/shared/centralData";
import {
  createAndRegisterWorkspace,
  deleteWorkspaceDir,
  resolveWorkspaceTemplateDir,
  validateWorkspaceName,
} from "@natstack/shared/workspace/loader";
import type { WorkspaceEntry } from "@natstack/shared/workspace/types";
import { ManagedServer, type ServerPorts } from "./managedServer.js";

const log = createDevLogger("WorkspaceSupervisor");

export interface WorkspaceSupervisorOptions {
  appRoot: string;
  serverBundlePath?: string;
  publicBaseUrl: string;
  publicBasePath: string;
  maxWorkspaces?: number;
  idleTimeoutMs?: number;
  exposedWorkspaces?: Set<string>;
  requireAuthToColdStart?: boolean;
  logLevel?: string;
  esbuildBinaryPath?: string;
  wsAllowedOrigins?: string;
  crashBackoffMs?: number;
  centralData?: SupervisorCentralData;
  createManagedServer?: (ctx: ManagedServerFactoryContext) => ManagedServerLike;
  createWorkspace?: (
    name: string,
    centralData: SupervisorCentralData,
    opts?: { templateDir?: string }
  ) => WorkspaceEntry;
  deleteWorkspaceDir?: (name: string) => void;
}

export interface SupervisorCentralData {
  listWorkspaces(): WorkspaceEntry[];
  hasWorkspace(name: string): boolean;
  addWorkspace(name: string): void;
  removeWorkspace(name: string): void;
  touchWorkspace(name: string): void;
  getWorkspaceEntry(name: string): WorkspaceEntry | null;
}

export interface ManagedServerLike {
  start(): Promise<ServerPorts>;
  shutdown(): Promise<void>;
  getPorts(): ServerPorts | null;
  getProcessId(): number | undefined;
  getCurrentGatewayUrl(): string | null;
}

export interface ManagedServerFactoryContext {
  name: string;
  env: Record<string, string | undefined>;
  onCrash: (code: number | null) => void;
  onRestart: (ports: ServerPorts) => void;
  onIpcRequest: (
    type: string,
    msg: Record<string, unknown>
  ) => Promise<Record<string, unknown> | null>;
}

export interface WorkspaceEntryState {
  name: string;
  manager: ManagedServerLike;
  ports: ServerPorts | null;
  state: "starting" | "ready" | "stopping" | "crashed";
  lastActivity: number;
  wsConnCount: number;
  inflightHttpCount: number;
  proxySocketCount: number;
  inflight?: Promise<ServerPorts>;
  crashError?: string;
}

export interface WorkspaceSummary {
  name: string;
  state: WorkspaceEntryState["state"];
  pid?: number;
  ports: ServerPorts | null;
  lastActivity: number;
  wsConnCount: number;
  inflightHttpCount: number;
  proxySocketCount: number;
}

export class WorkspaceNotFoundError extends Error {
  readonly statusCode = 404;
}

export class WorkspaceCapacityError extends Error {
  readonly statusCode = 503;
}

export class WorkspaceBackendCrashedError extends Error {
  readonly statusCode = 503;
}

export class ColdStartAuthRequiredError extends Error {
  readonly statusCode = 401;
}

export class WorkspaceSupervisor {
  readonly centralData: SupervisorCentralData;
  private readonly entries = new Map<string, WorkspaceEntryState>();
  private readonly inflightByName = new Map<string, Promise<ServerPorts>>();
  private readonly crashedBackends = new Map<string, { message: string; retryAfter: number }>();
  private readonly maxWorkspaces: number;
  private readonly idleTimeoutMs: number;
  private readonly serverBundlePath: string;
  private startLock: Promise<void> = Promise.resolve();
  private reaper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: WorkspaceSupervisorOptions) {
    this.centralData = opts.centralData ?? new CentralDataManager();
    this.maxWorkspaces = opts.maxWorkspaces ?? 5;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.serverBundlePath = opts.serverBundlePath ?? defaultServerBundlePath();
    if (this.idleTimeoutMs > 0) {
      this.reaper = setInterval(() => void this.reapIdle(), Math.min(this.idleTimeoutMs, 60_000));
      this.reaper.unref?.();
    }
  }

  listRegisteredWorkspaces(): WorkspaceEntry[] {
    return this.centralData.listWorkspaces();
  }

  listActive(): WorkspaceSummary[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      state: entry.state,
      pid: entry.manager.getProcessId(),
      ports: entry.ports,
      lastActivity: entry.lastActivity,
      wsConnCount: entry.wsConnCount,
      inflightHttpCount: entry.inflightHttpCount,
      proxySocketCount: entry.proxySocketCount,
    }));
  }

  getEntry(name: string): WorkspaceEntryState | null {
    validateWorkspaceName(name);
    return this.entries.get(name) ?? null;
  }

  async ensureExisting(
    name: string,
    opts: { operatorAuthenticated?: boolean } = {}
  ): Promise<ServerPorts> {
    validateWorkspaceName(name);
    const crashed = this.crashedBackends.get(name);
    if (crashed) {
      if (Date.now() < crashed.retryAfter) {
        throw new WorkspaceBackendCrashedError(crashed.message);
      }
      this.crashedBackends.delete(name);
    }
    if (this.opts.exposedWorkspaces && !this.opts.exposedWorkspaces.has(name)) {
      throw new WorkspaceNotFoundError(`Workspace "${name}" is not exposed`);
    }
    const existing = this.entries.get(name);
    if (existing?.ports && existing.state === "ready") {
      existing.lastActivity = Date.now();
      return existing.ports;
    }
    const pending = existing?.inflight ?? this.inflightByName.get(name);
    if (pending) return pending;
    if (this.opts.requireAuthToColdStart && !opts.operatorAuthenticated) {
      throw new ColdStartAuthRequiredError("Supervisor operator token required to cold-start");
    }
    if (!this.centralData.hasWorkspace(name)) {
      throw new WorkspaceNotFoundError(`Workspace "${name}" not found`);
    }

    const inflight = (async () => {
      const entry = await this.withStartLock(async () => {
        const ready = this.entries.get(name);
        if (ready?.ports && ready.state === "ready") return ready;
        await this.enforceCapacity(name);
        const manager = this.createManager(name);
        const reserved: WorkspaceEntryState = {
          name,
          manager,
          ports: null,
          state: "starting",
          lastActivity: Date.now(),
          wsConnCount: 0,
          inflightHttpCount: 0,
          proxySocketCount: 0,
        };
        this.entries.set(name, reserved);
        return reserved;
      });
      if (entry.ports && entry.state === "ready") return entry.ports;
      try {
        const ports = await entry.manager.start();
        entry.ports = ports;
        entry.state = "ready";
        entry.inflight = undefined;
        this.centralData.touchWorkspace(name);
        return ports;
      } catch (error) {
        this.entries.delete(name);
        await entry.manager.shutdown().catch(() => undefined);
        this.recordBackendCrash(
          name,
          `Backend "${name}" failed during startup: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        throw error;
      }
    })();
    this.inflightByName.set(name, inflight);
    inflight.finally(() => this.inflightByName.delete(name)).catch(() => undefined);
    return inflight;
  }

  createWorkspace(name: string): WorkspaceEntry {
    validateWorkspaceName(name);
    const templateDir = resolveWorkspaceTemplateDir(this.opts.appRoot) ?? undefined;
    if (this.opts.createWorkspace) {
      return this.opts.createWorkspace(name, this.centralData, { templateDir });
    }
    return createAndRegisterWorkspace(name, this.centralData as CentralDataManager, {
      templateDir,
    });
  }

  async deleteWorkspace(name: string): Promise<void> {
    validateWorkspaceName(name);
    await this.evict(name);
    (this.opts.deleteWorkspaceDir ?? deleteWorkspaceDir)(name);
    this.centralData.removeWorkspace(name);
  }

  trackHttpStart(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.inflightHttpCount += 1;
    entry.lastActivity = Date.now();
  }

  trackHttpFinish(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.inflightHttpCount = Math.max(0, entry.inflightHttpCount - 1);
    entry.lastActivity = Date.now();
  }

  trackProxySocketOpen(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.proxySocketCount += 1;
    entry.lastActivity = Date.now();
  }

  trackProxySocketClose(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.proxySocketCount = Math.max(0, entry.proxySocketCount - 1);
    entry.lastActivity = Date.now();
  }

  trackWsOpen(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.wsConnCount += 1;
    entry.lastActivity = Date.now();
  }

  trackWsClose(name: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.wsConnCount = Math.max(0, entry.wsConnCount - 1);
    entry.lastActivity = Date.now();
  }

  async evict(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.state = "stopping";
    this.entries.delete(name);
    await entry.manager.shutdown();
  }

  async shutdownAll(): Promise<void> {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.manager.shutdown()));
  }

  private createManager(name: string): ManagedServerLike {
    const onCrash = (code: number | null) => {
      this.recordBackendCrash(name, `Backend "${name}" exited repeatedly with code ${code}`);
    };
    const onRestart = (ports: ServerPorts) => {
      const entry = this.entries.get(name);
      if (entry) {
        entry.ports = ports;
        entry.state = "ready";
        entry.lastActivity = Date.now();
      }
    };
    const onIpcRequest = async (type: string) => {
      if (type === "workspace-list-request") {
        return { workspaces: this.centralData.listWorkspaces() };
      }
      if (type === "workspace-active-entry-request") {
        return { entry: this.centralData.getWorkspaceEntry(name) };
      }
      return null;
    };
    const env = this.buildBackendEnv(name);
    if (this.opts.createManagedServer) {
      return this.opts.createManagedServer({ name, env, onCrash, onRestart, onIpcRequest });
    }
    return new ManagedServer({
      spawn: () =>
        createProcessAdapter(this.serverBundlePath, env, {
          preferNode: true,
        }),
      stdioLabel: `server:${name}`,
      stderrLabel: `server:${name}:err`,
      onCrash,
      onRestart,
      onOpenExternal: (url) => {
        log.warn(`Backend "${name}" requested external open, ignored in supervisor: ${url}`);
      },
      onRelaunch: (target) => {
        log.warn(`Backend "${name}" requested workspace relaunch to "${target}", ignored`);
      },
      onIpcRequest,
    });
  }

  private buildBackendEnv(name: string): Record<string, string | undefined> {
    const publicUrl = joinUrlPath(this.opts.publicBaseUrl, `/w/${encodeURIComponent(name)}`);
    const publicBasePath = joinPath(this.opts.publicBasePath, `/w/${encodeURIComponent(name)}`);
    return {
      ...process.env,
      NATSTACK_WORKSPACE: name,
      NATSTACK_APP_ROOT: this.opts.appRoot,
      NATSTACK_PUBLIC_URL: publicUrl,
      NATSTACK_PUBLIC_BASE_PATH: publicBasePath,
      NATSTACK_NO_VPN_DETECT: "1",
      NATSTACK_SUPERVISOR_MODE: "1",
      NATSTACK_BIND_HOST: "127.0.0.1",
      ...(this.opts.wsAllowedOrigins
        ? { NATSTACK_WS_ALLOWED_ORIGINS: this.opts.wsAllowedOrigins }
        : {}),
      ...(this.opts.esbuildBinaryPath ? { ESBUILD_BINARY_PATH: this.opts.esbuildBinaryPath } : {}),
      ...(this.opts.logLevel ? { NATSTACK_LOG_LEVEL: this.opts.logLevel } : {}),
    };
  }

  private async enforceCapacity(incomingName: string): Promise<void> {
    const liveEntries = [...this.entries.values()].filter((entry) => entry.name !== incomingName);
    if (liveEntries.length < this.maxWorkspaces) return;
    const idle = liveEntries
      .filter((entry) => entry.state === "ready" && isIdle(entry))
      .sort((a, b) => a.lastActivity - b.lastActivity)[0];
    if (!idle) {
      throw new WorkspaceCapacityError("Workspace capacity reached and no idle backend can evict");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refreshed = this.entries.get(idle.name);
    if (!refreshed || !isIdle(refreshed)) {
      throw new WorkspaceCapacityError("Workspace capacity reached and idle backend became active");
    }
    await this.evict(idle.name);
  }

  private recordBackendCrash(name: string, message: string): void {
    const entry = this.entries.get(name);
    if (entry) {
      entry.state = "crashed";
      entry.crashError = message;
      this.entries.delete(name);
    }
    this.crashedBackends.set(name, {
      message,
      retryAfter: Date.now() + (this.opts.crashBackoffMs ?? 30_000),
    });
    log.warn(message);
  }

  private async withStartLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.startLock.catch(() => undefined);
    let release!: () => void;
    this.startLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const idleNames = [...this.entries.values()]
      .filter((entry) => entry.state === "ready")
      .filter((entry) => isIdle(entry))
      .filter((entry) => now - entry.lastActivity >= this.idleTimeoutMs)
      .map((entry) => entry.name);
    for (const name of idleNames) {
      await this.evict(name).catch((err) => {
        log.warn(`Failed to evict idle backend "${name}":`, err);
      });
    }
  }
}

function isIdle(entry: WorkspaceEntryState): boolean {
  return entry.wsConnCount === 0 && entry.inflightHttpCount === 0 && entry.proxySocketCount === 0;
}

function joinPath(base: string, suffix: string): string {
  const normalizedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  return `${normalizedBase}${suffix}`;
}

function joinUrlPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  url.pathname = joinPath(url.pathname === "/" ? "" : url.pathname, suffix);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function defaultServerBundlePath(): string {
  return path.resolve(process.cwd(), "dist/server.mjs");
}
