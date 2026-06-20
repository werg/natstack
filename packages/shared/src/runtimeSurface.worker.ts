import type { RuntimeSurface } from "./runtimeSurface.js";
import { namespaceEntry, valueEntry } from "./runtimeSurface.js";
import { coreRuntimeSurface, PANEL_TREE_MEMBERS, WORKSPACE_MEMBERS } from "./runtimeSurface.core.js";

const panelTreeDescription =
  "Runtime property, not workspace.panelTree. Signatures: self(): PanelHandle; get(id): PanelHandle; list(): Promise<PanelHandle[]>; roots(): Promise<PanelHandle[]>; children(id): Promise<PanelHandle[]>; parent(id): PanelHandle | null; navigate(id, source, opts?): Promise<{ id, title }>. Use list/roots/children/get for existing panels; navigate replaces an existing panel slot; openPanel creates a new panel. self/get are sync; async methods refresh metadata as needed.";

export const workerRuntimeSurface: RuntimeSurface = {
  target: "workerRuntime",
  description: "Properties available on the object returned by createWorkerRuntime(env).",
  exports: {
    ...coreRuntimeSurface,
    // Entries whose description is worker-specific (member arrays shared with core).
    workspace: namespaceEntry(
      WORKSPACE_MEMBERS,
      "Workspace catalog, source tree, and unit helpers. Does not include panelTree; use runtime.panelTree for panel-tree handles."
    ),
    openPanel: valueEntry("Open a workspace or browser panel and return a PanelHandle."),
    listPanels: valueEntry("Alias for runtime.panelTree.list()."),
    getPanelHandle: valueEntry("Alias for runtime.panelTree.get(id, kind?)."),
    panelTree: namespaceEntry(PANEL_TREE_MEMBERS, panelTreeDescription),
    // Worker-only target extras.
    handleRpcPost: valueEntry(),
    destroy: valueEntry(),
  },
};
