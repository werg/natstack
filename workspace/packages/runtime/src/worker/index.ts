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
import { connectViaRpc } from "@natstack/pubsub";
import type { ParticipantMetadata, PubSubClient, RpcConnectOptions } from "@natstack/pubsub";
import { createHttpRpcBridge } from "../shared/httpRpcBridge.js";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { fs, _initFsWithRpc } from "./fs.js";
import { createCredentialClient, type CredentialClient } from "../shared/credentials.js";
import { createWebhookIngressClient, type WebhookIngressClient } from "../shared/webhooks.js";
import { createWorkerdClient, type WorkerdClient } from "../shared/workerd.js";
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
import { createNotificationClient, type NotificationClient } from "../shared/notifications.js";
import { createGadClient, type GadClient } from "../shared/gad.js";
import { createParentHandle } from "../shared/handles.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch, type GatewayFetch } from "../shared/gatewayFetch.js";
import {
  createUserlandApprovalAccessPolicy,
  listUserlandApprovals,
  requestUserlandApproval,
  revokeUserlandApproval,
  type UserlandApprovalAccessPolicyOptions,
  type UserlandApprovalChoice,
  type UserlandApprovalGrant,
  type UserlandApprovalRequest,
} from "../approvals.js";
import { GitClient, createRoutingHttpClient } from "@natstack/git";
import type { HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";
import type { ParentHandle } from "../core/index.js";
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
export type * from "../shared/gad.js";
export { DurableObjectBase } from "./durable-base.js";
export type { DurableObjectContext, SqlStorage, SqlResult, DORef } from "./durable-base.js";
export { fs } from "./fs.js";
export { createGatewayFetch } from "../shared/gatewayFetch.js";
export { getCurrentRpcCaller, type RpcCallerContext } from "../shared/httpRpcBridge.js";
export type { GatewayFetch } from "../shared/gatewayFetch.js";
export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
  UserlandApprovalAccessPolicyOptions,
} from "../approvals.js";
export { createUserlandApprovalAccessPolicy } from "../approvals.js";
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
  skipped: Array<{ path: string; reason: "already-present" | "unsupported-path" }>;
  failed: Array<{ path: string; error: string }>;
}

export interface RuntimeGitApi {
  http: CredentialClient["gitHttp"];
  importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo>;
  completeWorkspaceDependencies(options?: { credentialId?: string }): Promise<CompleteWorkspaceDependenciesResult>;
  setSharedRemote(repoPath: string, remote: GitRemoteSpec): Promise<Record<string, unknown> | undefined>;
  removeSharedRemote(repoPath: string, remoteName: string): Promise<Record<string, unknown> | undefined>;
  client(options?: { credentialId?: string }): GitClient;
}

export type WorkerSubscribeOptions<T extends ParticipantMetadata = ParticipantMetadata> =
  Omit<RpcConnectOptions<T>, "rpc" | "channel" | "serverUrl" | "clientId"> & {
    clientId?: string;
  };

// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;

export interface WorkerRuntime {
  readonly id: string;
  readonly rpc: RpcBridge;
  readonly fs: RuntimeFs;
  readonly workers: WorkerdClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialClient;
  readonly webhooks: WebhookIngressClient;
  readonly notifications: NotificationClient;
  readonly contextId: string;
  readonly gatewayConfig: { serverUrl: string; token?: string };
  readonly gatewayFetch: GatewayFetch;
  readonly gitConfig: { serverUrl: string; token?: string } | null;
  readonly git: RuntimeGitApi;
  readonly gad: GadClient;
  readonly pubsubConfig: null;
  readonly subscribe: <T extends ParticipantMetadata = ParticipantMetadata>(channel: string, options?: WorkerSubscribeOptions<T>) => PubSubClient<T>;

  /** Call a server-side service method via RPC. */
  callMain<T>(method: string, ...args: unknown[]): Promise<T>;
  openExternal(url: string, options?: OpenExternalOptions): Promise<OpenExternalResult>;
  getWorkspaceTree(): Promise<unknown>;
  listBranches(repoPath: string): Promise<unknown[]>;
  listCommits(repoPath: string, ref?: string, limit?: number): Promise<unknown[]>;
  requestApproval(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
  approvalAccessPolicy(options: UserlandApprovalAccessPolicyOptions): import("@natstack/rpc").RpcAccessPolicy;
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
  });

  const runtimeFs = _initFsWithRpc(rpc);
  const workers = helpfulNamespace("workers", createWorkerdClient(rpc));
  const workspaceApi = helpfulNamespace("workspace", createWorkspaceClient(rpc));
  const credentials = helpfulNamespace("credentials", createCredentialClient(rpc));
  const gatewayConfig = { serverUrl };
  const gatewayFetch = createGatewayFetch(gatewayConfig);
  const gitConfig = { serverUrl: `${serverUrl}/_git` };
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
    client(options: { credentialId?: string } = {}) {
      if (!gitConfig) {
        return new GitClient(runtimeFs, { http: credentials.gitHttp({ credentialId: options.credentialId }) });
      }
      return new GitClient(runtimeFs, {
        serverUrl: gitConfig.serverUrl,
        http: createRoutingHttpClient({
          internalOrigin: gitConfig.serverUrl,
        internal: createFetchHttpClient(),
        external: credentials.gitHttp({ credentialId: options.credentialId }),
      }),
    });
  },
  });
  const webhooks = helpfulNamespace("webhooks", createWebhookIngressClient(rpc));
  const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));
  const gad = helpfulNamespace("gad", createGadClient(rpc));

  const parentId = (env.PARENT_ID as string) || null;

  const callMain = <T>(method: string, ...args: unknown[]) =>
    rpc.call<T>("main", method, ...args);
  const subscribe = <T extends ParticipantMetadata = ParticipantMetadata>(
    channel: string,
    options: WorkerSubscribeOptions<T> = {},
  ): PubSubClient<T> => connectViaRpc<T>({
    ...options,
    rpc,
    channel,
    clientId: options.clientId ?? selfId,
  });

  const runtime: WorkerRuntime = {
    id: workerId,
    rpc,
    fs: runtimeFs,
    workers,
    workspace: workspaceApi,
    credentials,
    git,
    gad,
    webhooks,
    notifications,
    contextId: env.CONTEXT_ID,
    gatewayConfig,
    gatewayFetch,
    gitConfig,
    pubsubConfig: null,
    subscribe,

    callMain,
    openExternal: (url: string, options?: OpenExternalOptions) => callMain<OpenExternalResult>("externalOpen.openExternal", url, options),
    getWorkspaceTree: () => callMain<unknown>("git.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<unknown[]>("git.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<unknown[]>("git.listCommits", repoPath, ref, limit),
    requestApproval: (req: UserlandApprovalRequest) => requestUserlandApproval(rpc, req),
    approvalAccessPolicy: (options: UserlandApprovalAccessPolicyOptions) =>
      createUserlandApprovalAccessPolicy(rpc, options),
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

function createFetchHttpClient(): HttpClient {
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const { url, method = "GET", headers = {}, body } = request;
      const requestBody = body ? await collectGitBody(body) : undefined;
      const response = await fetch(url, {
        method,
        headers,
        body: requestBody as BodyInit | undefined,
      });
      return {
        url: response.url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: response.body ? toAsyncIterable(response.body) : emptyAsyncIterable(),
      };
    },
  };
}

async function collectGitBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function* toAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function* emptyAsyncIterable(): AsyncIterableIterator<Uint8Array> {}

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
