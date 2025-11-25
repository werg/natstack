import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Theme, Dialog } from "@radix-ui/themes";

import {
  appModeAtom,
  loadAppModeAtom,
  settingsDialogOpenAtom,
  settingsDataAtom,
  loadSettingsAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import { PanelApp } from "./PanelApp";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceWizard } from "./WorkspaceWizard";
import { SettingsDialog } from "./SettingsDialog";

/**
 * Root App component that routes between workspace chooser and main panel app.
 */
export function App() {
  const appMode = useAtomValue(appModeAtom);
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadAppMode = useSetAtom(loadAppModeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const setSettingsOpen = useSetAtom(settingsDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  // Load app mode and theme preference on mount
  useEffect(() => {
    void loadAppMode();
    loadThemePreference();
  }, [loadAppMode, loadThemePreference]);

  // Listen for system theme changes
  useEffect(() => {
    if (typeof window.electronAPI === "undefined") return;

    const cleanup = window.electronAPI.onSystemThemeChanged(() => {
      loadThemePreference();
    });

    return cleanup;
  }, [loadThemePreference]);

  // Listen for settings menu event
  useEffect(() => {
    if (typeof window.electronAPI === "undefined") return;

    const cleanup = window.electronAPI.onOpenSettings(() => {
      setSettingsOpen(true);
    });

    return cleanup;
  }, [setSettingsOpen]);

  // Listen for workspace chooser menu event
  useEffect(() => {
    if (typeof window.electronAPI === "undefined") return;

    const cleanup = window.electronAPI.onOpenWorkspaceChooser(() => {
      setWorkspaceChooserOpen(true);
    });

    return cleanup;
  }, [setWorkspaceChooserOpen]);

  return (
    <Theme appearance={effectiveTheme} radius="none">
      {appMode === "chooser" ? <ChooserMode /> : <MainMode />}
    </Theme>
  );
}

/**
 * Chooser mode: shows workspace selector with settings dialog.
 * If no providers are configured, settings dialog opens in setup mode.
 */
function ChooserMode() {
  const settingsData = useAtomValue(settingsDataAtom);
  const loadSettings = useSetAtom(loadSettingsAtom);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // Load settings on mount to check if setup is needed
  useEffect(() => {
    void loadSettings().then(() => setInitialLoadDone(true));
  }, [loadSettings]);

  // Determine if we need setup mode (no providers configured)
  const needsSetup = initialLoadDone && settingsData !== null && !settingsData.hasConfiguredProviders;

  return (
    <>
      <WorkspaceChooser />
      <WorkspaceWizard />
      <SettingsDialog isSetupMode={needsSetup} />
    </>
  );
}

/**
 * Main mode: shows panel app with dialogs for workspace chooser, wizard, and settings.
 * If no providers are configured, settings dialog opens in setup mode on startup.
 */
function MainMode() {
  const settingsData = useAtomValue(settingsDataAtom);
  const loadSettings = useSetAtom(loadSettingsAtom);
  const setSettingsOpen = useSetAtom(settingsDialogOpenAtom);
  const workspaceChooserOpen = useAtomValue(workspaceChooserDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const [initialLoadDone, setInitialLoadDone] = useState(false);

  // Load settings on mount to check if setup is needed
  useEffect(() => {
    void loadSettings().then(() => setInitialLoadDone(true));
  }, [loadSettings]);

  // Check if we need setup mode (no providers configured)
  const needsSetup = initialLoadDone && settingsData !== null && !settingsData.hasConfiguredProviders;

  // Open settings dialog on startup if no providers configured
  useEffect(() => {
    if (needsSetup) {
      setSettingsOpen(true);
    }
  }, [needsSetup, setSettingsOpen]);

  return (
    <>
      <PanelApp />
      <WorkspaceWizard />
      <SettingsDialog isSetupMode={needsSetup} />

      {/* Workspace Chooser Dialog (for switching workspaces in main mode) */}
      <Dialog.Root open={workspaceChooserOpen} onOpenChange={setWorkspaceChooserOpen}>
        <Dialog.Content maxWidth="600px">
          <WorkspaceChooser />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
