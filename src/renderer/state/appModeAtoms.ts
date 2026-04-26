import { atom } from "jotai";
import type { WorkspaceEntry } from "@natstack/shared/types";
import { workspace } from "../shell/client.js";

// =============================================================================
// Workspace State
// =============================================================================

/**
 * List of workspaces
 */
export const recentWorkspacesAtom = atom<WorkspaceEntry[]>([]);

/**
 * Whether workspaces are currently loading
 */
export const workspacesLoadingAtom = atom(false);

/**
 * Name of the currently active workspace
 */
export const activeWorkspaceNameAtom = atom<string | null>(null);

/**
 * Transient error for workspace operations (dismissable)
 */
export const workspaceErrorAtom = atom<string | null>(null);

/**
 * Load workspaces from main process
 */
export const loadRecentWorkspacesAtom = atom(null, async (_get, set) => {
  set(workspacesLoadingAtom, true);
  try {
    const [workspaces, activeName] = await Promise.all([
      workspace.list(),
      workspace.getActive(),
    ]);
    set(recentWorkspacesAtom, workspaces);
    set(activeWorkspaceNameAtom, activeName);
  } catch (error) {
    console.error("Failed to load workspaces:", error);
  } finally {
    set(workspacesLoadingAtom, false);
  }
});

/**
 * Delete a workspace — reloads full list on success, sets error on failure.
 */
export const removeRecentWorkspaceAtom = atom(null, async (_get, set, name: string) => {
  try {
    await workspace.delete(name);
    set(workspaceErrorAtom, null);
    // Reload full list to ensure consistency with disk state
    const [workspaces, activeName] = await Promise.all([
      workspace.list(),
      workspace.getActive(),
    ]);
    set(recentWorkspacesAtom, workspaces);
    set(activeWorkspaceNameAtom, activeName);
  } catch (error) {
    set(workspaceErrorAtom, `Failed to delete "${name}": ${error instanceof Error ? error.message : String(error)}`);
    // Reload list anyway to sync with disk
    try {
      const workspaces = await workspace.list();
      set(recentWorkspacesAtom, workspaces);
    } catch (reloadErr) {
      console.error("Failed to reload workspace list:", reloadErr);
    }
  }
});

// =============================================================================
// Workspace Selection State
// =============================================================================

/**
 * Select and open a workspace (triggers app relaunch)
 */
export const selectWorkspaceAtom = atom(null, async (_get, _set, name: string) => {
  try {
    await workspace.select(name);
    // App will relaunch, no need to update state
  } catch (error) {
    console.error("Failed to select workspace:", error);
    throw error;
  }
});

// =============================================================================
// Settings State
// =============================================================================

/**
 * Whether settings dialog is open
 */
export const settingsDialogOpenAtom = atom(false);

// =============================================================================
// Workspace Chooser State (for switch workspace dialog)
// =============================================================================

/**
 * Whether workspace chooser dialog is open
 */
export const workspaceChooserDialogOpenAtom = atom(false);

// =============================================================================
// Workspace Wizard State
// =============================================================================

/**
 * Whether workspace wizard dialog is open
 */
export const wizardDialogOpenAtom = atom(false);

// =============================================================================
// Shell Overlay State
// =============================================================================

/**
 * Ref-counted overlay tracker. Each shell dialog increments on open,
 * decrements on close via useShellOverlay(isOpen). Panel views are hidden
 * when count > 0. No central enumeration — each dialog self-registers.
 */
export const shellOverlayCountAtom = atom(0);
export const shellOverlayActiveAtom = atom((get) => get(shellOverlayCountAtom) > 0);

/**
 * Wizard form data
 */
export interface WizardFormData {
  workspaceName: string;
  forkFrom: string;
}

export const wizardFormDataAtom = atom<WizardFormData>({
  workspaceName: "",
  forkFrom: "",
});

/**
 * Whether workspace is being created
 */
export const wizardCreatingAtom = atom(false);

/**
 * Wizard error message
 */
export const wizardErrorAtom = atom<string | null>(null);

/**
 * Reset wizard state
 */
export const resetWizardAtom = atom(null, (_get, set) => {
  set(wizardFormDataAtom, { workspaceName: "", forkFrom: "" });
  set(wizardCreatingAtom, false);
  set(wizardErrorAtom, null);
});

/**
 * Create a new workspace
 */
export const createWorkspaceAtom = atom(null, async (get, set) => {
  const formData = get(wizardFormDataAtom);

  if (!formData.workspaceName) {
    set(wizardErrorAtom, "Workspace name is required");
    return null;
  }

  set(wizardCreatingAtom, true);
  set(wizardErrorAtom, null);

  try {
    const opts: { forkFrom?: string } = {};
    if (formData.forkFrom) opts.forkFrom = formData.forkFrom;
    await workspace.create(
      formData.workspaceName,
      Object.keys(opts).length > 0 ? opts : undefined,
    );

    // Select the newly created workspace (triggers app relaunch)
    await workspace.select(formData.workspaceName);
    return true;
  } catch (error) {
    set(wizardErrorAtom, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    set(wizardCreatingAtom, false);
  }
});
