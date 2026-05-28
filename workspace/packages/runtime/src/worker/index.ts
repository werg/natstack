/**
 * Worker runtime entry point for workerd workers.
 *
 * Usage:
 * ```typescript
 * import { createWorkerRuntime, handleWorkerRpc } from "@workspace/runtime/worker";
 * import type { WorkerEnv } from "@workspace/runtime/worker";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
 *     const runtime = createWorkerRuntime(env);
 *
 *     // Handle incoming RPC calls from other callers
 *     const rpcResponse = handleWorkerRpc(runtime, request);
 *     if (rpcResponse) return rpcResponse;
 *
 *     const content = await runtime.fs.readFile("/src/index.ts", "utf8");
 *     return new Response(content);
 *   },
 * };
 * ```
 */
// Buffer polyfill for non-Node environments
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as any).Buffer = Buffer;
}
import type { RpcBridge } from "@natstack/rpc";
import { createHttpRpcBridge } from "../shared/httpRpcBridge.js";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { fs, _initFsWithRpc } from "./fs.js";
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createWebhookIngressClient, type WebhookIngressClient } from "../shared/webhooks.js";
import {
  createDurableObjectServiceClient,
  createWorkerdClient,
  doTargetId,
  type WorkerdClient,
  type DurableObjectServiceClient,
} from "../shared/workerd.js";
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
import { createExtensionsClient, type ExtensionsClient } from "../shared/extensions.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { createGadClient, type GadClient } from "../shared/gad.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "../shared/handles.js";
import { createCdpAutomation } from "../panel/cdpAutomation.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch, type GatewayFetch } from "../shared/gatewayFetch.js";
import {
  listUserlandApprovals,
  requestUserlandApproval,
  revokeUserlandApproval,
  type UserlandApprovalChoice,
  type UserlandApprovalGrant,
  type UserlandApprovalRequest,
} from "../approvals.js";
import { GitClient, createBearerHttpClient, createRoutingHttpClient } from "@natstack/git";
import type { PanelHandle } from "../core/index.js";
import type { WorkerEnv } from "./types.js";
import type { RuntimeFs } from "../types.js";
export type { WorkerEnv, ExecutionContext } from "./types.js";
export type {
  ClientConfigStatus,
  CredentialClient,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
export type { NotificationClient } from "../shared/notifications.js";
export { doTargetId, createDurableObjectServiceClient } from "../shared/workerd.js";
export type {
  DurableObjectServiceClient,
  ResolvedUserlandService,
  UserlandServiceInfo,
} from "../shared/workerd.js";
export type {
  WorkspaceClient,
  WorkspaceConfig,
  WorkspaceEntry,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
  WorkspaceUnitsClient,
} from "../shared/workspace.js";
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export type * from "../shared/gad.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
export { fs } from "./fs.js";
export { createGatewayFetch } from "../shared/gatewayFetch.js";
export type { GatewayFetch } from "../shared/gatewayFetch.js";
export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "../approvals.js";
// Note: createTestDO is intentionally NOT exported here because it depends on
// sql.js test-only helpers that should not be bundled into production workers.
// Import directly from "@workspace/runtime/src/worker/durable-test-utils" in tests.
export interface GitRemoteSpec {
  name: string;
  url: string;
}
export interface ImportProjectRequest {
  path: string;
  remote: GitRemoteSpec;
  credentialId?: string;
}
export interface ImportedWorkspaceRepo {
  path: string;
  remote: GitRemoteSpec;
}
export interface CompleteWorkspaceDependenciesResult {
  imported: ImportedWorkspaceRepo[];
  skipped: Array<{
    path: string;
    reason: "already-present" | "unsupported-path";
  }>;
  failed: Array<{
    path: string;
    error: string;
  }>;
}
export interface RuntimeGitApi {
  http: CredentialClient["gitHttp"];
  importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo>;
  completeWorkspaceDependencies(options?: {
    credentialId?: string;
  }): Promise<CompleteWorkspaceDependenciesResult>;
  setSharedRemote(
    repoPath: string,
    remote: GitRemoteSpec
  ): Promise<Record<string, unknown> | undefined>;
  removeSharedRemote(
    repoPath: string,
    remoteName: string
  ): Promise<Record<string, unknown> | undefined>;
  syncRepoToContexts(repoPath: string): Promise<{ synced: string }>;
  client(options?: { credentialId?: string }): GitClient;
}
// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;
let workerConsoleBridgeInstalled = false;

function installWorkerConsoleBridge(rpc: RpcBridge): void {
  if (workerConsoleBridgeInstalled) return;
  workerConsoleBridgeInstalled = true;
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  let forwarding = false;
  const forward = (
    level: "log" | "info" | "warn" | "error",
    args: unknown[],
    source?: string
  ): void => {
    if (forwarding) return;
    forwarding = true;
    try {
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      rpc.call("main", "workerLog.write", [level, message, source ? { source } : undefined]).catch((err) => {
        original.warn("[console-bridge] forward failed:", err);
      });
    } finally {
      forwarding = false;
    }
  };
  const source = (globalThis as { __natstackWorkerSource?: string }).__natstackWorkerSource;
  console.log = (...args: unknown[]) => {
    original.log(...args);
    forward("log", args, source);
  };
  console.info = (...args: unknown[]) => {
    original.info(...args);
    forward("info", args, source);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    forward("warn", args, source);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    forward("error", args, source);
  };
}
export interface WorkerRuntime {
  readonly id: string;
  readonly rpc: RpcBridge;
  readonly fs: RuntimeFs;
  readonly doTargetId: typeof doTargetId;
  readonly createDurableObjectServiceClient: (
    query: string,
    objectKey?: string | null
  ) => DurableObjectServiceClient;
  readonly workers: WorkerdClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialClient;
  readonly webhooks: WebhookIngressClient;
  readonly notifications: NotificationClient;
  readonly extensions: ExtensionsClient;
  readonly approvals: {
    request(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
    revoke(subjectId: string): Promise<boolean>;
    list(): Promise<UserlandApprovalGrant[]>;
  };
  readonly contextId: string;
  readonly gatewayConfig: { serverUrl: string; token: string; aliases?: readonly string[] };
  readonly gatewayFetch: GatewayFetch;
  readonly gitConfig: {
    serverUrl: string;
    token: string;
    internalOrigins?: readonly string[];
  } | null;
  readonly git: RuntimeGitApi;
  readonly gad: GadClient;

  /** Call a server-side service method via RPC. */
  callMain<T>(method: string, ...args: unknown[]): Promise<T>;
  openExternal(url: string, options?: OpenExternalOptions): Promise<OpenExternalResult>;
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown[]>;
  listCommits(repoPath: string, ref?: string, limit?: number): Promise<unknown[]>;
  requestApproval(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
  revokeApproval(subjectId: string): Promise<boolean>;
  listApprovals(): Promise<UserlandApprovalGrant[]>;
  /** Expose a method callable by other callers (panels, workers, server). */
  exposeMethod: RpcBridge["exposeMethod"];
  /** Get a handle to the parent panel/worker (null if no parent). */
  getParent(): PanelHandle | null;
  /** Tree handles for panels visible to this runtime. */
  readonly panelTree: {
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
  };
  /** Handle an incoming RPC POST body, returning the response payload. */
  handleRpcPost(body: unknown): Promise<unknown>;
  destroy(): void;
}
/**
 * Create or retrieve the worker runtime for the given environment.
 *
 * The runtime is cached per worker instance (same WORKER_ID returns same runtime).
 * This is important because workerd may call fetch() multiple times on the same
 * isolate, and we want to reuse the HTTP RPC bridge.
 */
export function createWorkerRuntime(env: WorkerEnv): WorkerRuntime {
  const workerId = env.WORKER_ID;

  // Return cached runtime if same worker
  if (cachedRuntime && cachedWorkerId === workerId) {
    return cachedRuntime;
  }

  const serverUrl = env.GATEWAY_URL;
  if (!serverUrl) {
    throw new Error("Worker env must provide GATEWAY_URL");
  }

  const selfId = `worker:${workerId}`;
  (globalThis as { __natstackWorkerSource?: string }).__natstackWorkerSource =
    typeof env["WORKER_SOURCE"] === "string" ? env["WORKER_SOURCE"] : undefined;
  const parentId = (env.PARENT_ID as string) || null;
  const parentEntityId = (env.PARENT_ENTITY_ID as string) || parentId;
  const parentKind = parseParentKind(env.PARENT_KIND);
  const rpc = createHttpRpcBridge({
    selfId,
    serverUrl,
    authToken: env.RPC_AUTH_TOKEN,
  });
  installWorkerConsoleBridge(rpc);

  const runtimeFs = _initFsWithRpc(rpc);
  const workers = helpfulNamespace("workers", createWorkerdClient(rpc, {
    parentId: selfId,
    parentEntityId: selfId,
    parentKind: "worker",
  }));
  const workspaceApi = helpfulNamespace("workspace", createWorkspaceClient(rpc));
  const credentials = helpfulNamespace("credentials", createCredentialClient(rpc));
  const gatewayAliases = parseGatewayAliases(env.GATEWAY_URL_ALIASES);
  const gatewayConfig = { serverUrl, token: env.RPC_AUTH_TOKEN, aliases: gatewayAliases };
  const gatewayFetch = createGatewayFetch(gatewayConfig);
  const gitConfig = {
    serverUrl: `${serverUrl}/_git`,
    token: env.RPC_AUTH_TOKEN,
    internalOrigins: gatewayAliases.map((url) => `${url.replace(/\/$/, "")}/_git`),
  };
  const git = helpfulNamespace("git", {
    http: credentials.gitHttp,
    importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo> {
      return callMain("git.importProject", request);
    },
    completeWorkspaceDependencies(
      options: { credentialId?: string } = {}
    ): Promise<CompleteWorkspaceDependenciesResult> {
      return callMain("git.completeWorkspaceDependencies", options);
    },
    setSharedRemote(
      repoPath: string,
      remote: GitRemoteSpec
    ): Promise<Record<string, unknown> | undefined> {
      return callMain("git.setSharedRemote", repoPath, remote);
    },
    removeSharedRemote(
      repoPath: string,
      remoteName: string
    ): Promise<Record<string, unknown> | undefined> {
      return callMain("git.removeSharedRemote", repoPath, remoteName);
    },
    syncRepoToContexts(repoPath: string): Promise<{ synced: string }> {
      return callMain("git.syncRepoToContexts", repoPath);
    },
    client(options: { credentialId?: string } = {}) {
      if (!gitConfig) {
        return new GitClient(runtimeFs, {
          http: credentials.gitHttp({ credentialId: options.credentialId }),
        });
      }
      return new GitClient(runtimeFs, {
        serverUrl: gitConfig.serverUrl,
        http: createRoutingHttpClient({
          internalOrigin: gitConfig.serverUrl,
          internalOrigins: gitConfig.internalOrigins,
          internal: createBearerHttpClient(gitConfig.token),
          external: credentials.gitHttp({ credentialId: options.credentialId }),
        }),
      });
    },
  });
  const webhooks = helpfulNamespace("webhooks", createWebhookIngressClient(rpc));
  const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));
  const extensions = helpfulNamespace("extensions", createExtensionsClient(rpc));
  const approvals = helpfulNamespace("approvals", {
    request: (req: UserlandApprovalRequest) => requestUserlandApproval(rpc, req),
    revoke: (subjectId: string) => revokeUserlandApproval(rpc, subjectId),
    list: () => listUserlandApprovals(rpc),
  });
  const gad = helpfulNamespace("gad", createGadClient(rpc));

  const callMain = <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, args);
  const panelTree = createWorkerPanelTree(rpc, selfId, parentId, parentEntityId, parentKind);

  const runtime: WorkerRuntime = {
    id: workerId,
    rpc,
    fs: runtimeFs,
    doTargetId,
    createDurableObjectServiceClient: (query, objectKey) =>
      createDurableObjectServiceClient(rpc, query, objectKey),
    workers,
    workspace: workspaceApi,
    credentials,
    git,
    gad,
    webhooks,
    notifications,
    extensions,
    approvals,
    contextId: env.CONTEXT_ID,
    gatewayConfig,
    gatewayFetch,
    gitConfig,

    callMain,
    openExternal: (url: string, options?: OpenExternalOptions) =>
      callMain<OpenExternalResult>("externalOpen.openExternal", url, options),
    getWorkspaceTree: () => callMain<unknown>("git.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<unknown[]>("git.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<unknown[]>("git.listCommits", repoPath, ref, limit),
    requestApproval: (req: UserlandApprovalRequest) => requestUserlandApproval(rpc, req),
    revokeApproval: (subjectId: string) => revokeUserlandApproval(rpc, subjectId),
    listApprovals: () => listUserlandApprovals(rpc),
    exposeMethod: rpc.exposeMethod.bind(rpc),
    getParent: () => createWorkerParentPanelHandle(panelTree, parentId, parentEntityId, parentKind),
    panelTree,
    handleRpcPost: (body: unknown) => rpc.handleIncomingPost(body),
    destroy: () => {
      if (cachedWorkerId === workerId) {
        cachedRuntime = null;
        cachedWorkerId = null;
      }
    },
  };

  cachedRuntime = runtime;
  cachedWorkerId = workerId;

  return runtime;
}

function createWorkerPanelTree(
  rpc: RpcBridge,
  selfId: string,
  parentId: string | null,
  parentEntityId: string | null,
  parentKind: "panel" | "worker" | "do" | null
): WorkerRuntime["panelTree"] {
  type PanelListItem = {
    panelId: string;
    title: string;
    source: string;
    kind: "workspace" | "browser";
    parentId: string | null;
    contextId: string;
    runtimeEntityId?: string | null;
    children?: PanelListItem[];
  };
  type PanelMetadataResult = {
    id?: string;
    title?: string;
    source?: string;
    kind?: "workspace" | "browser";
    parentId?: string | null;
    runtimeEntityId?: string | null;
  };
  const callPanel = <T>(method: string, args: unknown[]) =>
    rpc.call<T>("main", `panelTree.${method}`, args);
  const metadataCache = new Map<string, PanelHandleMetadata>();
  const rememberMetadata = (metadata: PanelHandleMetadata): PanelHandleMetadata => {
    const next = { ...(metadataCache.get(metadata.id) ?? {}), ...metadata };
    metadataCache.set(metadata.id, next);
    return next;
  };
  const toMetadata = (item: PanelListItem): PanelHandleMetadata =>
    rememberMetadata({
      id: item.panelId,
      title: item.title,
      source: item.source,
      kind: item.kind,
      parentId: item.parentId,
      rpcTargetId: item.runtimeEntityId ?? item.panelId,
    });
  const metadataForId = (id: string): PanelHandleMetadata =>
    rememberMetadata({
      id,
      title: id,
      source: id,
      kind: "workspace",
      parentId: null,
      ...(metadataCache.get(id) ?? {}),
    });
  const metadataFromResult = (id: string, meta: PanelMetadataResult): PanelHandleMetadata => ({
    id,
    title: meta.title,
    source: meta.source,
    kind: meta.kind,
    parentId: meta.parentId,
    rpcTargetId: meta.runtimeEntityId ?? meta.id ?? id,
  });
  rememberMetadata({ id: selfId, title: selfId, source: selfId, kind: "workspace", parentId });
  if (parentKind === "panel" && parentId) {
    rememberMetadata({
      id: parentId,
      title: parentId,
      source: parentId,
      kind: "workspace",
      parentId: null,
      rpcTargetId: parentEntityId ?? parentId,
    });
  }
  const ops: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await callPanel<PanelMetadataResult | null>("metadata", [id]);
      return meta ? rememberMetadata(metadataFromResult(id, meta)) : metadataForId(id);
    },
    children: (id) => panelTree.children(id),
    parent: (id, parentId) => {
      const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    ensureLoaded: (id) => callPanel("ensureLoaded", [id]),
    isLoaded: async (id) => {
      try {
        const lease = await callPanel<{ leased?: boolean } | null>("getRuntimeLease", [id]);
        return Boolean(lease?.leased);
      } catch {
        return false;
      }
    },
    reload: (id) => callPanel("reload", [id]),
    close: (id) => callPanel("close", [id]),
    archive: (id) => callPanel("archive", [id]),
    unload: (id) => callPanel("unload", [id]),
    movePanel: (id, newParentId, targetPosition) =>
      callPanel("movePanel", [{ panelId: id, newParentId, targetPosition }]),
    takeOver: (id) => callPanel("takeOver", [id]),
    openDevTools: (id, mode) => callPanel("openDevTools", [id, mode]),
    rebuildPanel: (id) => callPanel("rebuildPanel", [id]),
    updatePanelState: (id, state) => callPanel("updatePanelState", [id, state]),
    focus: (id) => callPanel("focus", [id]),
    stateArgs: {
      get: (id) => callPanel("getStateArgs", [id]),
      set: (id, updates) => callPanel("setStateArgs", [id, updates]),
    },
    snapshot: (id) => callPanel("snapshot", [id]),
    callAgent: (id, method, args) => callPanel("callAgent", [id, method, args]),
  };
  const hydrate = (item: PanelListItem): PanelHandle =>
    createPanelHandle({
      rpc,
      metadata: toMetadata(item),
      cdp: createCdpAutomation(rpc, item.panelId),
      ops,
    });
  const flatten = (items: PanelListItem[]): PanelListItem[] => {
    const out: PanelListItem[] = [];
    const visit = (item: PanelListItem) => {
      out.push(item);
      for (const child of item.children ?? []) visit(child);
    };
    for (const item of items) visit(item);
    return out;
  };
  const panelTree: WorkerRuntime["panelTree"] = {
    self: () =>
      createNonPanelRuntimeHandle({
        id: selfId,
        parentId,
        parent: () => createWorkerParentPanelHandle(panelTree, parentId, parentEntityId, parentKind),
      }),
    get: (id) =>
      createPanelHandle({
        rpc,
        metadata: metadataForId(id),
        cdp: createCdpAutomation(rpc, id),
        ops,
      }),
    async list() {
      return flatten(await callPanel<PanelListItem[]>("list", [null])).map(hydrate);
    },
    async roots() {
      return (await callPanel<PanelListItem[]>("roots", [])).map(hydrate);
    },
    async children(id) {
      return (await callPanel<PanelListItem[]>("list", [id])).map(hydrate);
    },
    parent: (id) => {
      const resolvedParentId =
        id === selfId ? (parentId ?? metadataCache.get(id)?.parentId) : metadataCache.get(id)?.parentId;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    async open(source, options) {
      const targetParentId = options?.parentId ?? (parentKind === "panel" ? parentId : null);
      const result = await callPanel<{
        id: string;
        title: string;
        kind: "workspace" | "browser";
        runtimeEntityId?: string | null;
      }>("create", [source, { ...options, parentId: targetParentId }]);
      return hydrate({
        panelId: result.id,
        title: result.title,
        source: result.kind === "browser" ? `browser:${source}` : source,
        kind: result.kind,
        parentId: targetParentId,
        contextId: "",
        runtimeEntityId: result.runtimeEntityId ?? result.id,
      });
    },
  };
  return panelTree;
}

function parseParentKind(kind: unknown): "panel" | "worker" | "do" | null {
  return kind === "panel" || kind === "worker" || kind === "do" ? kind : null;
}

function createWorkerParentPanelHandle(
  panelTree: WorkerRuntime["panelTree"],
  parentId: string | null,
  parentEntityId: string | null,
  parentKind: "panel" | "worker" | "do" | null
): PanelHandle | null {
  if (!parentId) return null;
  if (parentKind === "panel") {
    return panelTree.get(parentId);
  }
  if (parentKind === "worker" || parentKind === "do") {
    return createNonPanelRuntimeHandle({ id: parentEntityId ?? parentId });
  }
  if (parentId.startsWith("worker:") || parentId.startsWith("do:")) {
    return createNonPanelRuntimeHandle({ id: parentId });
  }
  return panelTree.get(parentId);
}

function parseGatewayAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
    }
  } catch {
    // Fall through to comma-separated env syntax.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
/**
 * Handle incoming RPC POST requests for a worker.
 *
 * Workers must wire this into their fetch handler so that the server
 * (or other callers) can invoke methods exposed via `runtime.exposeMethod()`.
 *
 * @returns A Response promise if the request is an RPC call, or null if not.
 */
export function handleWorkerRpc(
  runtime: WorkerRuntime,
  request: Request
): Promise<Response> | null {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/__rpc") && request.method === "POST") {
    return (async () => {
      const body = await request.json();
      const result = await runtime.handleRpcPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    })();
  }
  return null;
}
