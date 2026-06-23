// Buffer polyfill for browser environments - must be first to ensure availability
// for bundled dependencies that expect a Node-compatible Buffer global.
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}
import { createPanelTransport } from "./transport.js";
import { fs } from "./fs.js"; // RPC-backed fs (server-side per-context folders)
import { initRuntime } from "../setup/initRuntime.js";
import { helpfulNamespace } from "../shared/helpfulNamespace.js";
import { createGatewayFetch } from "../shared/gatewayFetch.js";
import { createHostedRuntime, type RuntimeHost } from "../shared/hostedRuntime.js";

// --- Portable authoring helpers (z, defineContract, Rpc, path/context helpers,
// buildPanelLink, createGatewayFetch) — identical on panel · worker · eval. ---
export * from "../shared/portable.js";

// --- Type re-exports ---
export type { ThemeAppearance, ThemeConfig, PaletteCommand, RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";
export type {
  DurableObjectServiceClient,
  ResolvedUserlandService,
  UserlandServiceInfo,
} from "../shared/workerd.js";
export type * from "../shared/gad.js";
export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "../approvals.js";
export type * from "../core/types.js";
export type { Runtime } from "../setup/createRuntime.js";

// Initialize runtime with panel-specific providers (side effects: stateArgs
// bridge, agentApi registration, transport bring-up).
const { runtime, config } = initRuntime({
  createTransport: createPanelTransport,
  fs,
});

const _entityId = config.entityId;
const _slotId = config.slotId ?? config.entityId;
const _env = config.env;
export const id = config.entityId;
const gatewayConfig = config.gatewayConfig;
const gatewayFetch = createGatewayFetch(gatewayConfig);
const {
  parentId: runtimeParentId,
  parentEntityId: runtimeParentEntityId,
  rpc,
  contextId,
} = runtime;

// --- Panel handle bridge: openPanel/listPanels/getPanelHandle/panelTree/
// openExternal/onChildCreated all resolve through this singleton. ---
import { _initPanelHandleBridge } from "./handle.js";
_initPanelHandleBridge(rpc, {
  selfId: _slotId,
  selfRpcTargetId: _entityId,
  parentId: runtimeParentId,
  parentRpcTargetId: runtimeParentEntityId,
  effectiveVersion: config.effectiveVersion,
});
import {
  openExternal as _hostOpenExternal,
  openPanel as _hostOpenPanel,
  listPanels as _hostListPanels,
  getPanelHandle as _hostGetPanelHandle,
  panelTree as _hostPanelTree,
  onChildCreated as _onChildCreated,
} from "./handle.js";
export type { PanelHandle } from "./handle.js";

// --- The portable runtime surface — derived ONCE here (identical to worker +
// eval) from the panel's host ports. ---
const _panelHost: RuntimeHost = {
  id,
  contextId,
  rpc,
  fs,
  gatewayConfig,
  gatewayFetch,
  panelRuntime: {
    openPanel: _hostOpenPanel,
    listPanels: _hostListPanels,
    getPanelHandle: _hostGetPanelHandle,
    panelTree: _hostPanelTree,
  },
  workers: runtime.workers,
  openExternal: _hostOpenExternal,
  resolveParent: runtime.resolveParent,
};
const _core = createHostedRuntime(_panelHost);

// Credentials still seeds the `@workspace/runtime/panel/credentials` singleton.
import { initPanelCredentials } from "./credentials.js";
initPanelCredentials(rpc);

// Portable top-level surface (callMain/parent/getParent/getParentWithContract +
// every rpc-mediated namespace + panel-tree affordances) — sourced from _core so
// panel ≡ worker ≡ eval.
export const {
  callMain,
  parent,
  getParent,
  getParentWithContract,
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
  doTargetId,
  createDurableObjectServiceClient,
  openExternal,
  openPanel,
  listPanels,
  getPanelHandle,
  panelTree,
} = _core;
export { rpc, fs, contextId, gatewayConfig, gatewayFetch };
export const workers = helpfulNamespace("workers", _core.workers);

// --- Namespace type re-exports (unchanged) ---
export type {
  WorkspaceClient,
  WorkspaceEntry,
  WorkspaceConfig,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
  WorkspaceUnitsClient,
} from "../shared/workspace.js";
export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialClient,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  ManagedCredentialSummary,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  GrantUrlBoundCredentialRequest,
  ResolveUrlBoundCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
export type {
  GitRemoteSpec,
  ImportProjectRequest,
  ImportedWorkspaceRepo,
  CompleteWorkspaceDependenciesResult,
  RuntimeGitApi,
} from "../shared/gitApi.js";
export type { VcsClient, VcsStatusResult } from "../shared/vcsClient.js";
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
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export type { NotificationClient } from "./notifications.js";
export type { CdpAutomation, CdpEndpoint } from "./cdpAutomation.js";

// --- Panel-only affordances under the `panel` namespace (panel target only) ---
import { getStateArgs, useStateArgs, setStateArgs, setStateArgsForPanel } from "./stateArgs.js";

/**
 * Reopen THIS panel in place under a (possibly new) context + state args — a
 * snapshot replacement, not a child. The canonical way to rebind a panel to a
 * different durable context head (e.g. switching vault → `ctx:vault-<hash>`):
 * unlike `panel.stateArgs.set`, this moves the panel's `contextId`, which fixes
 * which `ctx:` vcs head every subsequent `vcs.*` / agent spawn resolves to.
 * Defaults `source` to the current panel's source.
 */
async function reopen(
  opts: { source?: string; contextId?: string; stateArgs?: Record<string, unknown> } = {}
): Promise<{ id: string; title: string }> {
  let source = opts.source;
  if (!source) {
    const meta = await rpc.call<{ source?: string } | null>("main", "panelTree.metadata", [
      _slotId,
    ]);
    source = meta?.source ?? undefined;
    if (!source) throw new Error("reopen: could not resolve the current panel source");
  }
  return rpc.call<{ id: string; title: string }>("main", "panelTree.navigate", [
    _slotId,
    source,
    { contextId: opts.contextId, stateArgs: opts.stateArgs },
  ]);
}

export const panel = helpfulNamespace("panel", {
  entityId: _entityId,
  slotId: _slotId,
  parentId: runtimeParentId,
  env: _env,
  getInfo: runtime.getInfo,
  focusPanel: runtime.focusPanel,
  getTheme: runtime.getTheme,
  onThemeChange: runtime.onThemeChange,
  getThemeConfig: runtime.getThemeConfig,
  onThemeConfigChange: runtime.onThemeConfigChange,
  registerPaletteCommands: runtime.registerPaletteCommands,
  unregisterPaletteCommands: runtime.unregisterPaletteCommands,
  onPaletteRun: runtime.onPaletteRun,
  onFocus: runtime.onFocus,
  onConnectionError: runtime.onConnectionError,
  onChildCreated: _onChildCreated,
  reopen,
  stateArgs: helpfulNamespace("panel.stateArgs", {
    get: getStateArgs,
    set: setStateArgs,
    use: useStateArgs,
    setForPanel: setStateArgsForPanel,
  }),
});

// `journal` (panel-operation journaling) is now a portable barrel helper, exported
// via `export * from "../shared/portable.js"` above — available on panel · worker · eval.

// --- Domain namespaces kept top-level (coherent single objects) ---
export { agentApi } from "./agentApi.js";
import { createAdBlockApi } from "./adblock.js";
export type { AdBlockStats, AdBlockApi } from "./adblock.js";
export const adblock = helpfulNamespace("adblock", createAdBlockApi(rpc));

// --- Internal-only diagnostics (NOT part of the public runtime surface) ---
// Wire the panel error-boundary launcher as a side effect; the diagnostic
// helpers themselves live behind `@workspace/runtime/internal/diagnostics`.
import { installPanelErrorDiagnosticLauncher } from "./errorDebugChat.js";
installPanelErrorDiagnosticLauncher({ slotId: _slotId, contextId });
