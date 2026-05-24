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
import { createParentHandle } from "../shared/handles.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch, type GatewayFetch } from "../shared/gatewayFetch.js";
import { listUserlandApprovals, requestUserlandApproval, revokeUserlandApproval, type UserlandApprovalChoice, type UserlandApprovalGrant, type UserlandApprovalRequest, } from "../approvals.js";
import { GitClient, createBearerHttpClient, createRoutingHttpClient } from "@natstack/git";
import type { ParentHandle } from "../core/index.js";
import type { WorkerEnv } from "./types.js";
import type { RuntimeFs } from "../types.js";
export type { WorkerEnv, ExecutionContext } from "./types.js";
export type { ClientConfigStatus, CredentialClient, StoredCredentialSummary, StoreUrlBoundCredentialRequest, ConfigureClientRequest, ConnectCredentialRequest, DeleteClientConfigRequest, RequestCredentialInputRequest, GitHttpClient, } from "../shared/credentials.js";
export type { CreateWebhookIngressSubscriptionRequest, RotateWebhookIngressSecretRequest, RotateWebhookIngressSecretResult, WebhookIngressClient, WebhookIngressSubscriptionSummary, WebhookTarget, WebhookVerifierConfig, } from "../shared/webhooks.js";
export type { NotificationClient } from "../shared/notifications.js";
export { doTargetId, createDurableObjectServiceClient } from "../shared/workerd.js";
export type { DurableObjectServiceClient, ResolvedUserlandService, UserlandServiceInfo } from "../shared/workerd.js";
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
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
} from "../shared/extensions.js";
export type * from "../shared/gad.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
export { fs } from "./fs.js";
export { createGatewayFetch } from "../shared/gatewayFetch.js";
export type { GatewayFetch } from "../shared/gatewayFetch.js";
export type { UserlandApprovalChoice, UserlandApprovalGrant, UserlandApprovalOption, UserlandApprovalRequest, UserlandApprovalSubject, } from "../approvals.js";
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
    setSharedRemote(repoPath: string, remote: GitRemoteSpec): Promise<Record<string, unknown> | undefined>;
    removeSharedRemote(repoPath: string, remoteName: string): Promise<Record<string, unknown> | undefined>;
    syncRepoToContexts(repoPath: string): Promise<{ synced: string }>;
    client(options?: {
        credentialId?: string;
    }): GitClient;
}
// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;
export interface WorkerRuntime {
  readonly id: string;
  readonly rpc: RpcBridge;
  readonly fs: RuntimeFs;
  readonly doTargetId: typeof doTargetId;
  readonly createDurableObjectServiceClient: (
    query: string,
    objectKey?: string | null,
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
  readonly gitConfig: { serverUrl: string; token: string; internalOrigins?: readonly string[] } | null;
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
  getParent(): ParentHandle | null;
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
  const rpc = createHttpRpcBridge({
    selfId,
    serverUrl,
    authToken: env.RPC_AUTH_TOKEN,
  });

  const runtimeFs = _initFsWithRpc(rpc);
  const workers = helpfulNamespace("workers", createWorkerdClient(rpc));
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
    completeWorkspaceDependencies(options: { credentialId?: string } = {}): Promise<CompleteWorkspaceDependenciesResult> {
      return callMain("git.completeWorkspaceDependencies", options);
    },
    setSharedRemote(repoPath: string, remote: GitRemoteSpec): Promise<Record<string, unknown> | undefined> {
      return callMain("git.setSharedRemote", repoPath, remote);
    },
    removeSharedRemote(repoPath: string, remoteName: string): Promise<Record<string, unknown> | undefined> {
      return callMain("git.removeSharedRemote", repoPath, remoteName);
    },
    syncRepoToContexts(repoPath: string): Promise<{ synced: string }> {
      return callMain("git.syncRepoToContexts", repoPath);
    },
    client(options: { credentialId?: string } = {}) {
      if (!gitConfig) {
        return new GitClient(runtimeFs, { http: credentials.gitHttp({ credentialId: options.credentialId }) });
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

  const parentId = (env.PARENT_ID as string) || null;

  const callMain = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", method, args);

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
    openExternal: (url: string, options?: OpenExternalOptions) => callMain<OpenExternalResult>("externalOpen.openExternal", url, options),
    getWorkspaceTree: () => callMain<unknown>("git.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<unknown[]>("git.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<unknown[]>("git.listCommits", repoPath, ref, limit),
    requestApproval: (req: UserlandApprovalRequest) => requestUserlandApproval(rpc, req),
    revokeApproval: (subjectId: string) => revokeUserlandApproval(rpc, subjectId),
    listApprovals: () => listUserlandApprovals(rpc),
    exposeMethod: rpc.exposeMethod.bind(rpc),
    getParent: () => createParentHandle({ rpc, parentId }),
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

function parseGatewayAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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
export function handleWorkerRpc(runtime: WorkerRuntime, request: Request): Promise<Response> | null {
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
