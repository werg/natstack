import { useEffect, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Theme, Dialog } from "@radix-ui/themes";

import {
  appModeAtom,
  loadAppModeAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import { useShellEvent } from "../shell/useShellEvent";
import { panel } from "../shell/client";
import type { ShellPage } from "../../shared/ipc/types";
import { PanelApp } from "./PanelApp";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceWizard } from "./WorkspaceWizard";

/**
 * Root App component that routes between workspace chooser and main panel app.
 */
export function App() {
  const appMode = useAtomValue(appModeAtom);
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadAppMode = useSetAtom(loadAppModeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  // Load app mode and theme preference on mount
  useEffect(() => {
    void loadAppMode();
    loadThemePreference();
  }, [loadAppMode, loadThemePreference]);

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Listen for workspace chooser menu event via shell event
  const handleOpenWorkspaceChooser = useCallback(() => {
    setWorkspaceChooserOpen(true);
  }, [setWorkspaceChooserOpen]);
  useShellEvent("open-workspace-chooser", handleOpenWorkspaceChooser);

  // Listen for navigate-about menu event via shell event
  const handleNavigateAbout = useCallback(async (payload: { page: ShellPage }) => {
    try {
      const result = await panel.createShellPanel(payload.page);
      window.dispatchEvent(new CustomEvent("shell-panel-created", { detail: { panelId: result.id } }));
    } catch (error) {
      console.error(`[App] Failed to create shell panel for ${payload.page}:`, error);
    }
  }, []);
  useShellEvent("navigate-about", handleNavigateAbout);

  return (
    <Theme appearance={effectiveTheme} radius="none">
      {appMode === "chooser" ? <ChooserMode /> : <MainMode />}
    </Theme>
  );
}

/**
 * Chooser mode: shows workspace selector.
 */
function ChooserMode() {
  return (
    <>
      <WorkspaceChooser />
      <WorkspaceWizard />
    </>
  );
}

/**
 * Main mode: shows panel app with dialogs for workspace chooser and wizard.
 */
function MainMode() {
  const workspaceChooserOpen = useAtomValue(workspaceChooserDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  return (
    <>
      <PanelApp />
      <WorkspaceWizard />

      {/* Workspace Chooser Dialog (for switching workspaces in main mode) */}
      <Dialog.Root open={workspaceChooserOpen} onOpenChange={setWorkspaceChooserOpen}>
        <Dialog.Content maxWidth="600px">
          <WorkspaceChooser />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
