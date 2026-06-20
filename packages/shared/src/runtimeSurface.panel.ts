import type { RuntimeSurface } from "./runtimeSurface.js";
import { namespaceEntry, valueEntry } from "./runtimeSurface.js";
import { coreRuntimeSurface, PANEL_TREE_MEMBERS, WORKSPACE_MEMBERS } from "./runtimeSurface.core.js";

const panelTreeDescription =
  "Top-level export, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle | null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed.";

// Panel-only affordances, grouped under one `panel` namespace (was ~16 flat
// top-level exports). Identity/introspection/theme/focus/lifecycle + stateArgs.
const PANEL_MEMBERS = [
  "entityId",
  "slotId",
  "parentId",
  "env",
  "getInfo",
  "focusPanel",
  "getTheme",
  "onThemeChange",
  "onFocus",
  "onConnectionError",
  "onChildCreated",
  "reopen",
  "stateArgs",
];

export const panelRuntimeSurface: RuntimeSurface = {
  target: "panel",
  description: "Top-level value exports available from @workspace/runtime in panel eval contexts.",
  exports: {
    ...coreRuntimeSurface,
    // Entries whose description is panel-specific (member arrays shared with core).
    workspace: namespaceEntry(
      WORKSPACE_MEMBERS,
      "Workspace catalog, source tree, and unit helpers. Does not include panelTree; import top-level panelTree for panel-tree handles."
    ),
    openPanel: valueEntry(),
    listPanels: valueEntry(),
    getPanelHandle: valueEntry(),
    panelTree: namespaceEntry(PANEL_TREE_MEMBERS, panelTreeDescription),
    // Portable authoring helpers (also on worker + eval — pure, target-independent).
    Rpc: valueEntry("RPC helpers namespace export."),
    z: valueEntry("Zod export."),
    defineContract: valueEntry(),
    buildPanelLink: valueEntry(),
    parseContextId: valueEntry(),
    isValidContextId: valueEntry(),
    getInstanceId: valueEntry(),
    normalizePath: valueEntry(),
    getFileName: valueEntry(),
    resolvePath: valueEntry(),
    createGatewayFetch: valueEntry(
      "Create a gateway-authenticated fetch helper from an explicit config."
    ),
    // Panel-only namespaces.
    panel: namespaceEntry(
      PANEL_MEMBERS,
      "Panel-only affordances: identity (entityId/slotId/parentId/env), introspection (getInfo/getTheme/onThemeChange/onFocus/onConnectionError), lifecycle (focusPanel/onChildCreated/reopen), and stateArgs (get/set/use/setForPanel)."
    ),
    journal: namespaceEntry(
      ["Journal", "with", "current"],
      "Panel operation journaling: journal.Journal (class), journal.with(journal, fn), journal.current()."
    ),
    agentApi: valueEntry(),
    adblock: namespaceEntry([
      "getStats",
      "isActive",
      "getStatsForPanel",
      "isEnabledForPanel",
      "setEnabledForPanel",
      "resetStatsForPanel",
      "getPanelUrl",
      "addToWhitelist",
      "removeFromWhitelist",
    ]),
  },
};
