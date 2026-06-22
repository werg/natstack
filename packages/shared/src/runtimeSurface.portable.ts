/**
 * portableRuntimeSurface — the runtime-instance surface that is IDENTICAL on
 * panel · worker · eval, i.e. exactly what `createHostedRuntime` returns. This is
 * the single source of truth for cross-target parity:
 *   - `runtimeSurface.eval.ts` IS this surface (what `import {…} from
 *     "@workspace/runtime"` resolves to inside eval).
 *   - `runtimeSurface.core.ts` is this surface minus the few entries whose
 *     description differs per target (workspace / openPanel / … / panelTree),
 *     which panel & worker then re-add with their own wording.
 *   - the parity test asserts `Object.keys(createHostedRuntime(host))` equals
 *     these keys.
 *
 * Includes `callMain` + `parent`/`getParent`/`getParentWithContract` (portable as
 * of the surface-harmonization). Does NOT include `expose` (use `rpc.expose`) or
 * the old `requestApproval`/`revokeApproval`/`listApprovals` aliases (use
 * `approvals.*`) — both removed everywhere.
 */

import { namespaceEntry, valueEntry, type RuntimeSurfaceEntry } from "./runtimeSurface.js";

// --- shared namespace member arrays (single source of truth) ---
export const WORKERS_MEMBERS = [
  "create",
  "destroy",
  "update",
  "list",
  "status",
  "listInstanceSources",
  "listServices",
  "resolveService",
  "resolveDurableObject",
  "durableObjectService",
  "getPort",
  "restartAll",
  "cloneDO",
  "destroyDO",
];

export const WORKSPACE_MEMBERS = [
  "list",
  "getActive",
  "getActiveEntry",
  "getConfig",
  "create",
  "delete",
  "setInitPanels",
  "setConfigField",
  "switchTo",
  "sourceTree",
  "findUnitForPath",
  "units",
];

export const CREDENTIALS_MEMBERS = [
  "store",
  "connect",
  "configureClient",
  "requestCredentialInput",
  "getClientConfigStatus",
  "deleteClientConfig",
  "listStoredCredentials",
  "revokeCredential",
  "grantCredential",
  "resolveCredential",
  "fetch",
  "hookForUrl",
  "gitHttp",
  "forAudience",
];

export const GIT_MEMBERS = [
  "http",
  "importProject",
  "completeWorkspaceDependencies",
  "setSharedRemote",
  "removeSharedRemote",
];

export const VCS_MEMBERS = [
  "applyEdits",
  "readFile",
  "listFiles",
  "revert",
  "status",
  "unitStatus",
  "log",
  "diff",
  "resolveHead",
  "merge",
  "abortMerge",
  "pendingMerge",
  "publishStatus",
  "publish",
  "recall",
];

export const VCS_DESCRIPTION =
  "Workspace GAD VCS (edit-first): applyEdits commits and projects edits atomically; status reports a head's unpublished changes vs main; diff compares state hashes.";

export const GAD_MEMBERS = [
  "rawSql",
  "query",
  "status",
  "ensureBlob",
  "getTrajectoryBranchHead",
  "appendTrajectoryBatch",
  "listTrajectoryEvents",
  "appendChannelEnvelope",
  "getChannelEnvelope",
  "getTrajectoryForEnvelope",
  "listPublishedEnvelopesForTrajectory",
  "getEnvelopesForTrajectory",
  "getPublishedArtifactsForTurn",
  "getPrivateLineageForPublishedEnvelope",
  "getDownstreamConsumers",
  "getChannelReplayWindow",
  "listChannelEnvelopesAfter",
  "listChannelEnvelopesBefore",
  "getInitialChannelWindow",
  "listChannelEnvelopes",
  "inspectChannelEnvelopes",
  "listStoredValueRefs",
  "inspectStorageDiagnostics",
  "listGadBranchFiles",
  "diffGadStates",
  "readGadFileAtState",
  "getGadStateProducer",
  "validateGadHashes",
  "clearDirtyAfterValidation",
  "checkGadIntegrity",
  "rebuildTrajectoryProjections",
];

export const BLOBSTORE_MEMBERS = [
  "has",
  "stat",
  "putText",
  "getText",
  "getRange",
  "getRangeBytes",
  "grep",
  "putBase64",
  "getBase64",
  "delete",
  "list",
  "pruneUnreferenced",
];

export const WEBHOOKS_MEMBERS = [
  "createSubscription",
  "listSubscriptions",
  "revokeSubscription",
  "rotateSecret",
];

export const EXTENSIONS_MEMBERS = ["use", "invoke", "on", "list", "reload"];
export const APPROVALS_MEMBERS = ["request", "revoke", "list"];
export const NOTIFICATIONS_MEMBERS = ["show", "dismiss"];
export const PANEL_TREE_MEMBERS = ["self", "get", "list", "roots", "children", "parent", "navigate"];

/**
 * The full portable surface — every key `createHostedRuntime` returns. Entries
 * whose description differs per target (workspace / openPanel / listPanels /
 * getPanelHandle / panelTree) carry a neutral default here; panel & worker
 * manifests override those five with target-specific wording.
 */
export const portableExports: Record<string, RuntimeSurfaceEntry> = {
  id: valueEntry(),
  contextId: valueEntry(),
  rpc: valueEntry("Portable RPC client (the full createRpcClient)."),
  fs: valueEntry(),
  callMain: valueEntry("Call a `main` (server) service method: callMain(\"fs.readFile\", path)."),
  parent: valueEntry("This runtime's parent panel handle (a no-panel handle when there is none)."),
  getParent: valueEntry("Get the parent panel handle, or null when there is no parent."),
  getParentWithContract: valueEntry("Get the parent handle typed by a panel contract, or null."),
  doTargetId: valueEntry("Build a unified RPC target ID for a Durable Object reference."),
  createDurableObjectServiceClient: valueEntry(
    "Resolve a Durable Object-backed service and call it through unified RPC."
  ),
  gatewayConfig: valueEntry("Gateway base URL and bearer token for NatStack service routes."),
  gatewayFetch: valueEntry(
    "Fetch helper that prefixes gateway-relative paths and adds Authorization: Bearer."
  ),
  openExternal: valueEntry(),
  openPanel: valueEntry("Open a workspace or browser panel and return a PanelHandle."),
  listPanels: valueEntry("List open panels."),
  getPanelHandle: valueEntry("Get a handle to a panel by id."),
  workers: namespaceEntry(WORKERS_MEMBERS),
  workspace: namespaceEntry(WORKSPACE_MEMBERS),
  credentials: namespaceEntry(CREDENTIALS_MEMBERS),
  git: namespaceEntry(GIT_MEMBERS),
  vcs: namespaceEntry(VCS_MEMBERS, VCS_DESCRIPTION),
  gad: namespaceEntry(GAD_MEMBERS),
  blobstore: namespaceEntry(
    BLOBSTORE_MEMBERS,
    "Per-workspace content-addressable blob store: putText/putBase64 store, getText/getRange/getRangeBytes/getBase64 fetch, grep searches; returns a sha256 digest. Persist large artifacts/screenshots and return the digest."
  ),
  webhooks: namespaceEntry(WEBHOOKS_MEMBERS),
  extensions: namespaceEntry(EXTENSIONS_MEMBERS),
  approvals: namespaceEntry(APPROVALS_MEMBERS),
  notifications: namespaceEntry(NOTIFICATIONS_MEMBERS),
  panelTree: namespaceEntry(PANEL_TREE_MEMBERS),
};

/** The portable key set (= Object.keys of what createHostedRuntime returns). */
export const PORTABLE_KEYS = Object.keys(portableExports);

/** The five entries whose description differs per target (panel/worker override). */
export const PER_TARGET_DESCRIPTION_KEYS = [
  "workspace",
  "openPanel",
  "listPanels",
  "getPanelHandle",
  "panelTree",
] as const;
