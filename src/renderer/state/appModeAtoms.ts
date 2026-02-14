import { atom } from "jotai";
import type { AppMode, RecentWorkspace, SettingsData } from "../../shared/types.js";
import { app, central, settings, workspace } from "../shell/client.js";

// =============================================================================
// App Mode State
// =============================================================================

/**
 * Current application mode: "chooser" or "main"
 */
export const appModeAtom = atom<AppMode>("chooser");

/**
 * Load app mode from main process
 */
export const loadAppModeAtom = atom(null, async (_get, set) => {
  try {
    const mode = await app.getMode();
    set(appModeAtom, mode);
  } catch (error) {
    console.error("Failed to load app mode:", error);
  }
});

// =============================================================================
// Recent Workspaces State
// =============================================================================

/**
 * List of recently opened workspaces
 */
export const recentWorkspacesAtom = atom<RecentWorkspace[]>([]);

/**
 * Whether workspaces are currently loading
 */
export const workspacesLoadingAtom = atom(false);

/**
 * Load recent workspaces from main process
 */
export const loadRecentWorkspacesAtom = atom(null, async (_get, set) => {
  set(workspacesLoadingAtom, true);
  try {
    const workspaces = await central.getRecentWorkspaces();
    set(recentWorkspacesAtom, workspaces);
  } catch (error) {
    console.error("Failed to load recent workspaces:", error);
  } finally {
    set(workspacesLoadingAtom, false);
  }
});

/**
 * Remove a workspace from recent list
 */
export const removeRecentWorkspaceAtom = atom(null, async (get, set, path: string) => {
  try {
    await central.removeRecentWorkspace(path);
    // Update local state
    const current = get(recentWorkspacesAtom);
    set(
      recentWorkspacesAtom,
      current.filter((w) => w.path !== path)
    );
  } catch (error) {
    console.error("Failed to remove recent workspace:", error);
  }
});

// =============================================================================
// Workspace Selection State
// =============================================================================

/**
 * Select and open a workspace (triggers app relaunch)
 */
export const selectWorkspaceAtom = atom(null, async (_get, _set, path: string) => {
  try {
    await workspace.select(path);
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
// Workspace Chooser State (for main mode)
// =============================================================================

/**
 * Whether workspace chooser dialog is open (in main mode)
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
 * Current wizard step (0-indexed)
 */
export const wizardStepAtom = atom(0);

/**
 * Wizard form data
 */
export interface WizardFormData {
  folderPath: string;
  workspaceName: string;
}

export const wizardFormDataAtom = atom<WizardFormData>({
  folderPath: "",
  workspaceName: "",
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
  set(wizardStepAtom, 0);
  set(wizardFormDataAtom, { folderPath: "", workspaceName: "" });
  set(wizardCreatingAtom, false);
  set(wizardErrorAtom, null);
});

/**
 * Create a new workspace
 */
export const createWorkspaceAtom = atom(null, async (get, set) => {
  const formData = get(wizardFormDataAtom);

  if (!formData.folderPath || !formData.workspaceName) {
    set(wizardErrorAtom, "Folder path and workspace name are required");
    return null;
  }

  set(wizardCreatingAtom, true);
  set(wizardErrorAtom, null);

  try {
    const result = await workspace.create(
      formData.folderPath,
      formData.workspaceName
    );

    if (!result.isValid) {
      set(wizardErrorAtom, result.error || "Failed to create workspace");
      return null;
    }

    // Select the newly created workspace (triggers app relaunch)
    await workspace.select(result.path);
    return result;
  } catch (error) {
    set(wizardErrorAtom, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    set(wizardCreatingAtom, false);
  }
});
