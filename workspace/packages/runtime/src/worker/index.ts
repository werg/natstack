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
import {
  createConnectionlessRpcClient,
  type ConnectionlessRpcClient,
  type DeferrableRpcClient,
  type RpcEnvelope,
  type RpcRequest,
} from "@natstack/rpc";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { workerLogMethods } from "@natstack/shared/serviceSchemas/workerLog";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { fs, _initFsWithRpc } from "./fs.js";
import type { WebhookIngressClient } from "../shared/webhooks.js";
import {
  createDurableObjectServiceClient,
  createWorkerdClient,
  doTargetId,
  type WorkerdClient,
  type DurableObjectServiceClient,
} from "../shared/workerd.js";
import {
  createNonPanelRuntimeHandle,
  createRuntimeParentHandle,
} from "../shared/handles.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch, type GatewayFetch } from "../shared/gatewayFetch.js";
import { createMainCaller } from "../shared/mainRpc.js";
import {
  createPanelRuntime,
  type OpenPanelOptions,
  type PanelRuntimeApi,
} from "../shared/panelRuntime.js";
import { createHostedRuntime, type RuntimeHost, type WorkspaceRuntime } from "../shared/hostedRuntime.js";
import type { WorkerEnv } from "./types.js";
export type { WorkerEnv, ExecutionContext } from "./types.js";
// Portable authoring helpers (z, defineContract, Rpc, path/context helpers,
// buildPanelLink, createGatewayFetch) — identical on panel · worker · eval.
export * from "../shared/portable.js";
export type * from "../core/types.js";
export type {
  ClientConfigStatus,
  CredentialClient,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  ManagedCredentialSummary,
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
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
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
// `@rpc` exposure decorator — mark a DO method as reachable over RPC (opt-in / default-deny).
export { rpc } from "@natstack/rpc";
export type {
  DurableObjectContext,
  SqlStorage,
  SqlResult,
  DORef,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "./durable-base.js";
export { fs } from "./fs.js";
export { createRpcFs } from "../shared/rpcFs.js";
export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "../approvals.js";
// Git interop types now live in the shared `gitApi` (used by createHostedRuntime).
export type {
  GitRemoteSpec,
  ImportProjectRequest,
  ImportedWorkspaceRepo,
  CompleteWorkspaceDependenciesResult,
  RuntimeGitApi,
} from "../shared/gitApi.js";
export type { WorkspaceRuntime } from "../shared/hostedRuntime.js";
// Note: createTestDO is intentionally NOT exported here because it depends on
// sql.js test-only helpers that should not be bundled into production workers.
// Import directly from "@workspace/runtime/src/worker/durable-test-utils" in tests.
export type RuntimeOpenPanelOptions = OpenPanelOptions;
// Cache runtime per worker ID to avoid creating multiple bridges
let cachedRuntime: WorkerRuntime | null = null;
let cachedWorkerId: string | null = null;
let workerConsoleBridgeInstalled = false;

function installWorkerConsoleBridge(rpc: Pick<DeferrableRpcClient, "call">): void {
  if (workerConsoleBridgeInstalled) return;
  workerConsoleBridgeInstalled = true;
  const workerLogService = createTypedServiceClient("workerLog", workerLogMethods, (svc, m, a) =>
    rpc.call("main", `${svc}.${m}`, a)
  );
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
      // Normal path: forward ONLY via workerLog — don't also print to the local console,
      // or every line double-prints in the server terminal (`[workerd]` + `[workerLog]`).
      // On forward failure (workerLog unreachable), fall back to the original console so
      // the line is never lost. `original.*` is bound pre-override ⇒ no recursion.
      workerLogService.write(level, message, source ? { source } : undefined).catch(() => {
        original[level](...args);
      });
    } finally {
      forwarding = false;
    }
  };
  const source = (globalThis as { __natstackWorkerSource?: string }).__natstackWorkerSource;
  console.log = (...args: unknown[]) => forward("log", args, source);
  console.info = (...args: unknown[]) => forward("info", args, source);
  console.warn = (...args: unknown[]) => forward("warn", args, source);
  console.error = (...args: unknown[]) => forward("error", args, source);
}

/**
 * The worker runtime: the portable `WorkspaceRuntime` (shared with panel + eval
 * via `createHostedRuntime`) plus worker-only target extras.
 */
export interface WorkerRuntime extends WorkspaceRuntime {
  /** Handle an incoming RPC POST body (an `RpcEnvelope`), returning the response payload. */
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

  // The unified connectionless client — same core as panel/eval, envelope-native.
  const connectionless = createConnectionlessRpcClient({
    selfId,
    serverUrl,
    authToken: env.RPC_AUTH_TOKEN,
    callerKind: "worker",
  });
  const rpc = connectionless.client;
  installWorkerConsoleBridge(rpc);

  const runtimeFs = _initFsWithRpc(rpc);
  const workers = helpfulNamespace(
    "workers",
    createWorkerdClient(rpc, {
      parentId: selfId,
      parentEntityId: selfId,
      parentKind: "worker",
    })
  );
  const gatewayAliases = parseGatewayAliases(env.GATEWAY_URL_ALIASES);
  const gatewayConfig = { serverUrl, token: env.RPC_AUTH_TOKEN, aliases: gatewayAliases };
  const gatewayFetch = createGatewayFetch(gatewayConfig);
  const callMain = createMainCaller(rpc);

  let panelRuntime!: PanelRuntimeApi;
  const resolveParent = () =>
    createRuntimeParentHandle(
      (id) => panelRuntime.getPanelHandle(id),
      parentId,
      parentEntityId,
      parentKind
    );

  panelRuntime = createPanelRuntime({
    rpc,
    selfHandle: () =>
      createNonPanelRuntimeHandle({
        id: selfId,
        parentId,
        parent: resolveParent,
      }),
    // Pass our DIRECT parent (any kind). The server resolves it to the nearest panel ANCESTOR that
    // still exists (walking the entity lineage) — so a worker whose direct parent is another worker
    // still nests its panels under the owning panel further up, matching eval. `null` (no parent) ⇒ root.
    defaultOpenParentId: parentId,
    requesterPanelId: parentKind === "panel" ? parentId : null,
    initialMetadata:
      parentKind === "panel" && parentId
        ? [
            {
              id: parentId,
              title: parentId,
              source: parentId,
              kind: "workspace",
              parentId: null,
              rpcTargetId: parentEntityId ?? parentId,
            },
          ]
        : [],
  });

  const host: RuntimeHost = {
    id: workerId,
    contextId: env.CONTEXT_ID,
    rpc,
    fs: runtimeFs,
    gatewayConfig,
    gatewayFetch,
    panelRuntime,
    workers,
    openExternal: (url: string, options?: OpenExternalOptions) =>
      callMain<OpenExternalResult>("externalOpen.openExternal", url, options),
    resolveParent,
  };
  const core = createHostedRuntime(host);

  // Worker-only infra layered on the portable surface (callMain/parent/expose
  // now come from `core` / `rpc.expose`).
  const runtime: WorkerRuntime = {
    ...core,
    handleRpcPost: (body: unknown) => handleInboundWorkerEnvelope(connectionless, body),
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

/**
 * Dispatch an inbound `RpcEnvelope` (POSTed to `/__rpc`) through the converged
 * core: request envelopes return a response envelope; events deliver and ack.
 */
async function handleInboundWorkerEnvelope(
  connectionless: ConnectionlessRpcClient,
  body: unknown
): Promise<unknown> {
  const envelope = body as RpcEnvelope;
  const message = envelope?.message as RpcRequest | undefined;
  if (message?.type !== "request" && message?.type !== "stream-request") {
    connectionless.deliver(envelope);
    return {};
  }
  return (await connectionless.respond(envelope)) ?? {};
}

function parseParentKind(kind: unknown): "panel" | "worker" | "do" | null {
  return kind === "panel" || kind === "worker" || kind === "do" ? kind : null;
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
 * (or other callers) can invoke methods exposed via `runtime.expose()`.
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
