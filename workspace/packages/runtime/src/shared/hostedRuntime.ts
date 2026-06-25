/**
 * createHostedRuntime — the ONE shared assembly of the portable workspace
 * runtime surface, derived from a per-target `RuntimeHost`. Panel, worker, and
 * eval each build a thin host (the transport behind `rpc`, `fs`, the panel
 * runtime, `workers`, gateway, `openExternal`) and call this; every
 * rpc-mediated feature (`gad`/`workspace`/`credentials`/`vcs`/`git`/`webhooks`/
 * `extensions`/`approvals`/`notifications`) is written once and is real on every
 * target — because `host.rpc` is the same unified `createRpcClient` core
 * everywhere (event push, `vcs.subscribeHead`, `workspace.units.watch` all
 * work on a connectionless DO too).
 *
 * This is pure and DO-safe: it creates NO transport and runs no I/O — it only
 * composes clients over `host.rpc`. The cross-target parity gate executes this
 * function (`Object.keys(createHostedRuntime(fakeHost))`) to prove the three
 * targets expose the identical core surface.
 */

import type { RpcClient } from "@natstack/rpc";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { helpfulNamespace } from "./helpfulNamespace.js";
import { createGadClient, type GadClient } from "./gad.js";
import { createBlobstoreClient, type BlobstoreClient } from "./blobstore.js";
import { createWorkspaceClient, type WorkspaceClient } from "./workspace.js";
import { createCredentialClient, type CredentialClient } from "./credentials.js";
import { createVcsClient, type VcsClient } from "./vcsClient.js";
import { createWebhookIngressClient, type WebhookIngressClient } from "./webhooks.js";
import { createExtensionsClient, type ExtensionsClient } from "./extensions.js";
import { createNotificationClient, type NotificationClient } from "./notifications.js";
import { createApprovalsApi, type ApprovalsApi } from "./approvalsApi.js";
import { createGitApi, type RuntimeGitApi } from "./gitApi.js";
import { createMainCaller, type MainCaller } from "./mainRpc.js";
import { createParentHandleApi, type ParentHandleApi } from "./handles.js";
import {
  createDurableObjectServiceClient,
  doTargetId,
  type DurableObjectServiceClient,
  type WorkerdClient,
} from "./workerd.js";
import type { GatewayConfig } from "./globals.js";
import type { GatewayFetch } from "./gatewayFetch.js";
import type { PanelRuntimeApi, PanelRuntimeTree } from "./panelRuntime.js";
import type { RuntimeFs } from "../types.js";
import type { PanelHandle } from "../core/index.js";

/**
 * The panel-runtime ports `createHostedRuntime` consumes — just the four panel
 * affordances surfaced on the portable runtime. Narrower than `PanelRuntimeApi`
 * so a host can supply a minimal panel facade (the panel barrel composes these
 * from its handle bridge) without the full internal surface.
 */
export interface PanelRuntimePorts {
  openPanel: PanelRuntimeApi["openPanel"];
  listPanels: PanelRuntimeApi["listPanels"];
  getPanelHandle: PanelRuntimeApi["getPanelHandle"];
  panelTree: PanelRuntimeTree;
}

/**
 * Per-target host ports. Everything else on the runtime is DERIVED from these.
 * `expose` is intentionally NOT here — `expose` is not a top-level runtime name
 * on any target; the transport-level `rpc.expose` lives on `host.rpc` and is
 * real everywhere.
 */
export interface RuntimeHost {
  id: string;
  contextId: string;
  rpc: RpcClient;
  fs: RuntimeFs;
  gatewayConfig: GatewayConfig | null;
  gatewayFetch: GatewayFetch;
  panelRuntime: PanelRuntimePorts;
  workers: WorkerdClient;
  openExternal(url: string, options?: OpenExternalOptions): Promise<OpenExternalResult>;
  /**
   * Resolve this runtime's parent PanelHandle from verified launch metadata, or
   * null when there is no parent. Each target builds this closure from its own
   * provenance (panel bootstrap globals, worker `PARENT_*` env, eval `RunArgs`),
   * typically via `createRuntimeParentHandle`. `createHostedRuntime` derives the
   * portable `parent`/`getParent`/`getParentWithContract` from it.
   */
  resolveParent: () => PanelHandle | null;
}

/** The portable runtime surface — identical across panel · worker · eval. */
export interface WorkspaceRuntime {
  readonly id: string;
  readonly contextId: string;
  readonly rpc: RpcClient;
  readonly fs: RuntimeFs;
  /** Call a `main` (server) service method: `callMain("fs.readFile", path)`. */
  readonly callMain: MainCaller;
  /** This runtime's parent panel handle (a no-panel handle when there is none). */
  readonly parent: ParentHandleApi["parent"];
  readonly getParent: ParentHandleApi["getParent"];
  readonly getParentWithContract: ParentHandleApi["getParentWithContract"];
  readonly gad: GadClient;
  /** Per-workspace content-addressable blob store (persist/fetch large artifacts). */
  readonly blobstore: BlobstoreClient;
  readonly workspace: WorkspaceClient;
  readonly credentials: CredentialClient;
  readonly git: RuntimeGitApi;
  readonly vcs: VcsClient;
  readonly webhooks: WebhookIngressClient;
  readonly extensions: ExtensionsClient;
  readonly approvals: ApprovalsApi;
  readonly notifications: NotificationClient;
  readonly workers: WorkerdClient;
  readonly doTargetId: typeof doTargetId;
  readonly createDurableObjectServiceClient: (
    query: string,
    objectKey?: string | null
  ) => DurableObjectServiceClient;
  readonly gatewayConfig: GatewayConfig | null;
  readonly gatewayFetch: GatewayFetch;
  openExternal(url: string, options?: OpenExternalOptions): Promise<OpenExternalResult>;
  openPanel: PanelRuntimeApi["openPanel"];
  listPanels: PanelRuntimeApi["listPanels"];
  getPanelHandle: PanelRuntimeApi["getPanelHandle"];
  readonly panelTree: PanelRuntimeTree;
}

// DO-safe host helpers — re-exported so a connectionless host (EvalDO) can build
// its `RuntimeHost` ports from one import without pulling panel/worker bootstrap.
export { createGatewayFetch } from "./gatewayFetch.js";
export { createWorkerdClient } from "./workerd.js";
export { createRpcFs } from "./rpcFs.js";
export { createPanelRuntime } from "./panelRuntime.js";
export { createRuntimeParentHandle } from "./handles.js";

/**
 * Convenience `services.<name>.<method>(...)` namespace, identical on every
 * target. Non-colliding service names resolve to a client that dispatches via
 * `callMain("<name>.<method>", args)` with no hand-curated list; names that
 * collide with rich runtime bindings intentionally resolve to those ergonomic
 * clients instead.
 *
 * Two layers, composed:
 *  1. ERGONOMIC OVERRIDE — if `<name>` is a real member of the hosted runtime
 *     (`gad`/`fs`/`vcs`/`credentials`/`blobstore`/`workers`/…), `services.<name>`
 *     returns that SAME rich client object, so the curated, typed surface wins.
 *  2. DYNAMIC FALLBACK — otherwise `services.<name>` is a typed proxy whose every
 *     `.<method>(...args)` becomes `rt.callMain("<name>.<method>", ...args)`,
 *     i.e. `rpc.call("main", "<name>.<method>", args)`.
 *
 * SECURITY: the fallback adds NO new access. It routes solely through `callMain`,
 * and the server dispatcher enforces each method's `policy.allowed`
 * (serviceDispatcher.ts `dispatch` → `checkServiceAccess`) at the single choke
 * point — a `do`-denied method still rejects server-side. The proxy is purely
 * ergonomic reach, never an authorization bypass.
 *
 * This is a FUNCTION (not a runtime-surface member): `services` is an eval-only
 * ambient binding, not part of the portable `createHostedRuntime` key-set, so the
 * cross-target parity gate is untouched. Panel/worker can build the identical
 * `services` from the same helper for parity.
 */
export function createServicesProxy(rt: WorkspaceRuntime): Record<string, unknown> {
  const rtRecord = rt as unknown as Record<string, unknown>;
  // Cache per-service fallback clients so repeated `services.foo` access is stable
  // (=== across reads) and a method proxy isn't rebuilt on every property get.
  const fallbackClients = new Map<string, Record<string, unknown>>();

  const fallbackClient = (service: string): Record<string, unknown> => {
    const cached = fallbackClients.get(service);
    if (cached) return cached;
    const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const client = new Proxy(
      {},
      {
        get(_t, method) {
          if (typeof method === "symbol") return undefined;
          const m = String(method);
          let fn = methodCache.get(m);
          if (!fn) {
            fn = (...args: unknown[]) => rt.callMain(`${service}.${m}`, ...args);
            methodCache.set(m, fn);
          }
          return fn;
        },
      }
    ) as Record<string, unknown>;
    fallbackClients.set(service, client);
    return client;
  };

  return new Proxy(
    {},
    {
      get(_t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(rtRecord, prop, receiver);
        const name = String(prop);
        // Layer 1 — ergonomic override: the rich, curated runtime client wins.
        // `in` (not a truthy check) so a falsy-but-present member still overrides.
        if (name in rtRecord) return rtRecord[name];
        // Layer 2 — dynamic fallback: any other registered service, by name.
        return fallbackClient(name);
      },
      // So `name in services` and Reflect.has are honest about the override layer
      // (the fallback is open-ended, so membership there is always "yes").
      has(_t, prop) {
        return typeof prop === "string" ? true : prop in rtRecord;
      },
    }
  );
}

export function createHostedRuntime(host: RuntimeHost): WorkspaceRuntime {
  const rpc = host.rpc;
  const credentials = helpfulNamespace("credentials", createCredentialClient(rpc));
  const gad = helpfulNamespace("gad", createGadClient(rpc));
  const blobstore = helpfulNamespace("blobstore", createBlobstoreClient(rpc));
  const workspace = helpfulNamespace("workspace", createWorkspaceClient(rpc));
  const vcs = helpfulNamespace(
    "vcs",
    createVcsClient(
      <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, args),
      rpc
    )
  );
  const webhooks = helpfulNamespace("webhooks", createWebhookIngressClient(rpc));
  const extensions = helpfulNamespace("extensions", createExtensionsClient(rpc));
  const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));
  const approvals = helpfulNamespace("approvals", createApprovalsApi(rpc));
  const git = helpfulNamespace("git", createGitApi(rpc, credentials.gitHttp));
  const callMain = createMainCaller(rpc);
  const parentApi = createParentHandleApi(host.resolveParent);

  return {
    id: host.id,
    contextId: host.contextId,
    rpc,
    fs: host.fs,
    callMain,
    parent: parentApi.parent,
    getParent: parentApi.getParent,
    getParentWithContract: parentApi.getParentWithContract,
    gad,
    blobstore,
    workspace,
    credentials,
    git,
    vcs,
    webhooks,
    extensions,
    approvals,
    notifications,
    workers: host.workers,
    doTargetId,
    createDurableObjectServiceClient: (query, objectKey) =>
      createDurableObjectServiceClient(rpc, query, objectKey),
    gatewayConfig: host.gatewayConfig,
    gatewayFetch: host.gatewayFetch,
    openExternal: host.openExternal,
    openPanel: host.panelRuntime.openPanel,
    listPanels: host.panelRuntime.listPanels,
    getPanelHandle: host.panelRuntime.getPanelHandle,
    panelTree: host.panelRuntime.panelTree,
  };
}

export type { PanelHandle };
