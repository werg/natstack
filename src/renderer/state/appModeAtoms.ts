import { atom } from "jotai";
import type { WorkspaceEntry, SettingsData } from "../../shared/types.js";
import { settings, workspace } from "../shell/client.js";

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
 * Delete a workspace
 */
export const removeRecentWorkspaceAtom = atom(null, async (get, set, name: string) => {
  try {
    await workspace.delete(name);
    const current = get(recentWorkspacesAtom);
    set(
      recentWorkspacesAtom,
      current.filter((w) => w.name !== name)
    );
  } catch (error) {
    console.error("Failed to delete workspace:", error);
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
 * Settings data from main process
 */
export const settingsDataAtom = atom<SettingsData | null>(null);

/**
 * Whether settings are loading
 */
export const settingsLoadingAtom = atom(false);

/**
 * Whether settings dialog is open
 */
export const settingsDialogOpenAtom = atom(false);

/**
 * Load settings from main process
 */
export const loadSettingsAtom = atom(null, async (_get, set) => {
  set(settingsLoadingAtom, true);
  try {
    const data = await settings.getData();
    set(settingsDataAtom, data);
  } catch (error) {
    console.error("Failed to load settings:", error);
  } finally {
    set(settingsLoadingAtom, false);
  }
});

/**
 * Set an API key for a provider
 */
export const setApiKeyAtom = atom(
  null,
  async (_get, set, params: { providerId: string; apiKey: string }) => {
    try {
      await settings.setApiKey(params.providerId, params.apiKey);
      // Reload settings to reflect change
      const data = await settings.getData();
      set(settingsDataAtom, data);
    } catch (error) {
      console.error("Failed to set API key:", error);
      throw error;
    }
  }
);

/**
 * Remove an API key for a provider
 */
export const removeApiKeyAtom = atom(null, async (_get, set, providerId: string) => {
  try {
    await settings.removeApiKey(providerId);
    // Reload settings to reflect change
    const data = await settings.getData();
    set(settingsDataAtom, data);
  } catch (error) {
    console.error("Failed to remove API key:", error);
    throw error;
  }
});

/**
 * Set a model role mapping
 */
export const setModelRoleAtom = atom(
  null,
  async (_get, set, params: { role: string; modelSpec: string }) => {
    try {
      await settings.setModelRole(params.role, params.modelSpec);
      // Reload settings to reflect change
      const data = await settings.getData();
      set(settingsDataAtom, data);
    } catch (error) {
      console.error("Failed to set model role:", error);
      throw error;
    }
  }
);

/**
 * Enable a CLI-auth provider (like claude-code)
 */
export const enableProviderAtom = atom(null, async (_get, set, providerId: string) => {
  try {
    await settings.enableProvider(providerId);
    // Reload settings to reflect change
    const data = await settings.getData();
    set(settingsDataAtom, data);
  } catch (error) {
    console.error("Failed to enable provider:", error);
    throw error;
  }
});

/**
 * Disable a CLI-auth provider
 */
export const disableProviderAtom = atom(null, async (_get, set, providerId: string) => {
  try {
    await settings.disableProvider(providerId);
    // Reload settings to reflect change
    const data = await settings.getData();
    set(settingsDataAtom, data);
  } catch (error) {
    console.error("Failed to disable provider:", error);
    throw error;
  }
});

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

/**
 * Wizard form data
 */
export interface WizardFormData {
  workspaceName: string;
  gitUrl: string;
  forkFrom: string;
}

export const wizardFormDataAtom = atom<WizardFormData>({
  workspaceName: "",
  gitUrl: "",
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
  set(wizardFormDataAtom, { workspaceName: "", gitUrl: "", forkFrom: "" });
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
    const opts: { gitUrl?: string; forkFrom?: string } = {};
    if (formData.gitUrl) opts.gitUrl = formData.gitUrl;
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
