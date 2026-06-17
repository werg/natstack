// Buffer polyfill for browser environments - must be first to ensure availability
// for bundled dependencies that expect a Node-compatible Buffer global.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
import { createPanelTransport, recoveryCoordinator } from "./transport.js";
import { fs } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch } from "../shared/gatewayFetch.js";
import { createGadClient } from "../shared/gad.js";
import {
  createDurableObjectServiceClient as createDurableObjectServiceClientForRpc,
  doTargetId,
} from "../shared/workerd.js";
export type { ThemeAppearance, RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";
export { createGatewayFetch } from "../shared/gatewayFetch.js";
export type {
  DurableObjectServiceClient,
  ResolvedUserlandService,
  UserlandServiceInfo,
} from "../shared/workerd.js";
export type { GatewayFetch, GatewayFetchConfig } from "../shared/gatewayFetch.js";
export type * from "../shared/gad.js";
export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "../approvals.js";
// Initialize runtime with panel-specific providers
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
});
export * as Rpc from "../core/rpc.js";
export { z } from "../core/zod.js";
export { defineContract } from "../core/defineContract.js";
export { buildPanelLink } from "../core/panelLinks.js";
export { parseContextId, isValidContextId, getInstanceId } from "../core/context.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";
export const entityId = config.entityId;
export const id = config.entityId;
export const slotId = config.slotId ?? config.entityId;
const gatewayConfig = config.gatewayConfig;
const gatewayFetch = createGatewayFetch(gatewayConfig);
const env = config.env;
const {
  parentId: runtimeParentId,
  parentEntityId: runtimeParentEntityId,
  rpc,
  parent,
  getParent,
  getParentWithContract,
  onConnectionError,
  getInfo,
  focusPanel,
  getTheme,
  onThemeChange,
  onFocus,
  expose,
  contextId,
} = runtime;
export {
  rpc,
  parent,
  getParent,
  getParentWithContract,
  onConnectionError,
  getInfo,
  focusPanel,
  getTheme,
  onThemeChange,
  onFocus,
  expose,
  contextId,
  recoveryCoordinator,
  runtimeParentId as parentId,
};
const { workers } = runtime;
const helpfulWorkers = helpfulNamespace("workers", workers);
export { fs, gatewayConfig, gatewayFetch, env, helpfulWorkers as workers };
export { doTargetId };
export const createDurableObjectServiceClient = (query: string, objectKey?: string | null) =>
  createDurableObjectServiceClientForRpc(rpc, query, objectKey);
export const gad = helpfulNamespace("gad", createGadClient(rpc));
// Path utilities for cross-platform path handling
export { normalizePath, getFileName, resolvePath } from "../shared/pathUtils.js";
// State args API for panel state management
export { getStateArgs, useStateArgs, setStateArgs, setStateArgsForPanel } from "./stateArgs.js";
/**
 * Reopen THIS panel in place under a (possibly new) context + state args — a
 * snapshot replacement, not a child. The canonical way to rebind a panel to a
 * different durable context head (e.g. switching vault → `ctx:vault-<hash>`):
 * unlike `setStateArgs`, this moves the panel's `contextId`, which fixes which
 * `ctx:` vcs head every subsequent `vcs.*` / agent spawn resolves to. Defaults
 * `source` to the current panel's source.
 */
export async function reopen(
  opts: {
    source?: string;
    contextId?: string;
    stateArgs?: Record<string, unknown>;
  } = {}
): Promise<{ id: string; title: string }> {
  let source = opts.source;
  if (!source) {
    const meta = await rpc.call<{ source?: string } | null>("main", "panelTree.metadata", [slotId]);
    source = meta?.source ?? undefined;
    if (!source) throw new Error("reopen: could not resolve the current panel source");
  }
  return rpc.call<{ id: string; title: string }>("main", "panelTree.navigate", [
    slotId,
    source,
    { contextId: opts.contextId, stateArgs: opts.stateArgs },
  ]);
}
// Panel handle API
import { _initPanelHandleBridge, openPanel as _openPanel } from "./handle.js";
_initPanelHandleBridge(rpc, {
  selfId: slotId,
  selfRpcTargetId: entityId,
  parentId: runtimeParentId,
  parentRpcTargetId: runtimeParentEntityId,
  effectiveVersion: config.effectiveVersion,
});
import { installPanelErrorDiagnosticLauncher } from "./errorDebugChat.js";
installPanelErrorDiagnosticLauncher({ slotId, contextId });
export {
  openExternal,
  onChildCreated,
  openPanel,
  listPanels,
  getPanelHandle,
  panelTree,
} from "./handle.js";
export type { PanelHandle } from "./handle.js";
export {
  buildPanelRenderErrorPrompt,
  installPanelErrorDiagnosticLauncher,
  openPanelErrorDiagnosticChat,
} from "./errorDebugChat.js";
export type {
  PanelErrorDiagnosticChatResult,
  PanelErrorDiagnosticLauncher,
  PanelRenderErrorDiagnosticRequest,
} from "./errorDebugChat.js";
export type { CdpAutomation, CdpEndpoint } from "./cdpAutomation.js";
export { agentApi } from "./agentApi.js";
export { Journal, withJournal, currentJournal } from "./journal.js";
export type { PanelJournalEntry } from "./journal.js";
// Ad blocking programmatic interface
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = helpfulNamespace("adblock", createAdBlockApi(rpc));
// Workspace management.
//
// The panel variant of `workspace` extends the shared WorkspaceClient with
// `openPanel`, which is a panel-only operation (workers have no concept of
// opening a UI panel). Exposing it under `workspace.openPanel` matches the
// natural mental model — "opening a panel is a workspace operation" — and
// is the form most agentic eval code reaches for. Top-level `openPanel` is
// still exported separately for callers that prefer the flat form.
import { createWorkspaceClient, type WorkspaceClient } from "../shared/workspace.js";
export type {
  WorkspaceClient,
  WorkspaceEntry,
  WorkspaceConfig,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
  WorkspaceUnitsClient,
} from "../shared/workspace.js";
const workspaceClientBase = createWorkspaceClient(rpc);
const workspaceClient: WorkspaceClient & {
  openPanel: typeof _openPanel;
} = Object.assign(workspaceClientBase, { openPanel: _openPanel });
export const workspace = helpfulNamespace("workspace", workspaceClient);
// Credential handles + universal outbound proxying for panel fetch().
import {
  configureClient as configureCredentialClient,
  connect as connectCredential,
  deleteClientConfig as deleteCredentialClientConfig,
  fetch as credentialFetch,
  getClientConfigStatus as getCredentialClientConfigStatus,
  gitHttp as credentialGitHttp,
  grantCredential as grantUrlBoundCredential,
  hookForUrl as credentialHookForUrl,
  initPanelCredentials,
  listStoredCredentials as listUrlBoundCredentials,
  requestCredentialInput as requestCredentialSecretInput,
  resolveCredential as resolveUrlBoundCredential,
  revokeCredential as revokeUrlBoundCredential,
  store as storeUrlBoundCredential,
} from "./credentials.js";
export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialClient,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  GrantUrlBoundCredentialRequest,
  ResolveUrlBoundCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
initPanelCredentials(rpc);
const credentialApi = {
  store: storeUrlBoundCredential,
  connect: connectCredential,
  configureClient: configureCredentialClient,
  requestCredentialInput: requestCredentialSecretInput,
  getClientConfigStatus: getCredentialClientConfigStatus,
  deleteClientConfig: deleteCredentialClientConfig,
  listStoredCredentials: listUrlBoundCredentials,
  revokeCredential: revokeUrlBoundCredential,
  grantCredential: grantUrlBoundCredential,
  resolveCredential: resolveUrlBoundCredential,
  fetch: credentialFetch,
  hookForUrl: credentialHookForUrl,
  gitHttp: credentialGitHttp,
};
export const credentials = helpfulNamespace("credentials", credentialApi);
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { gitInteropMethods } from "@natstack/shared/serviceSchemas/gitInterop";
import { createVcsClient } from "../shared/vcsClient.js";
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
const gitInteropService = createTypedServiceClient(
  "gitInterop",
  gitInteropMethods,
  (svc, method, args) => rpc.call("main", `${svc}.${method}`, args)
);
const gitApi = {
  http: credentialGitHttp,
  importProject(request: ImportProjectRequest): Promise<ImportedWorkspaceRepo> {
    return gitInteropService.importProject(request);
  },
  completeWorkspaceDependencies(
    options: {
      credentialId?: string;
    } = {}
  ): Promise<CompleteWorkspaceDependenciesResult> {
    return gitInteropService.completeWorkspaceDependencies(options);
  },
  setSharedRemote(
    repoPath: string,
    remote: GitRemoteSpec
  ): Promise<Record<string, unknown> | undefined> {
    return gitInteropService.setSharedRemote(repoPath, remote);
  },
  removeSharedRemote(
    repoPath: string,
    remoteName: string
  ): Promise<Record<string, unknown> | undefined> {
    return gitInteropService.removeSharedRemote(repoPath, remoteName);
  },
};
export const git = helpfulNamespace("git", gitApi);
// GAD-native workspace version control (commit/status/log/diff).
export const vcs = helpfulNamespace(
  "vcs",
  createVcsClient(
    <T>(method: string, ...vcsArgs: unknown[]) => rpc.call<T>("main", method, vcsArgs),
    rpc
  )
);
export type { VcsClient, VcsStatusResult } from "../shared/vcsClient.js";
// Generic public webhook ingress.
import { createWebhookIngressClient } from "../shared/webhooks.js";
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
export const webhooks = helpfulNamespace("webhooks", createWebhookIngressClient(rpc));
// Extension RPC client.
import { createExtensionsClient } from "../shared/extensions.js";
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export const extensions = helpfulNamespace("extensions", createExtensionsClient(rpc));
// Userland consent approvals.
import {
  listUserlandApprovals,
  requestUserlandApproval,
  revokeUserlandApproval,
} from "../approvals.js";
export const approvals = helpfulNamespace("approvals", {
  request: requestUserlandApproval.bind(null, rpc),
  revoke: revokeUserlandApproval.bind(null, rpc),
  list: listUserlandApprovals.bind(null, rpc),
});
/** @deprecated Use `approvals.request(req)`. */
export const requestApproval = requestUserlandApproval.bind(null, rpc);
/** @deprecated Use `approvals.revoke(subjectId)`. */
export const revokeApproval = revokeUserlandApproval.bind(null, rpc);
/** @deprecated Use `approvals.list()`. */
export const listApprovals = listUserlandApprovals.bind(null, rpc);
// Shell notifications
import { createNotificationClient } from "./notifications.js";
export type { NotificationClient } from "./notifications.js";
export const notifications = helpfulNamespace("notifications", createNotificationClient(rpc));
