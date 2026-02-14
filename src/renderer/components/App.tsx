import { useEffect, useCallback, useState, lazy, Suspense } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Theme, Flex, Spinner } from "@radix-ui/themes";

import {
  appModeAtom,
  loadAppModeAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import { useShellEvent } from "../shell/useShellEvent";
import { panel } from "../shell/client";
import type { ShellPage } from "../../shared/types";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceWizard } from "./WorkspaceWizard";
import { ChunkErrorBoundary } from "./ChunkErrorBoundary";

// Lazy-load MainMode — this creates a separate chunk containing PanelApp,
// PanelStack, TitleBar, LazyPanelTreeSidebar, @dnd-kit/*, and all transitive deps.
// Mutable: reassigned on retry because React.lazy caches rejected promises permanently.
let LazyMainMode = lazy(() => import("./MainMode"));

function LoadingSpinner() {
  return (
    <Flex align="center" justify="center" style={{ height: "100vh" }}>
      <Spinner size="3" />
    </Flex>
  );
}

/**
 * Root App component that routes between workspace chooser and main panel app.
 */
export function App() {
  const appMode = useAtomValue(appModeAtom);
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadAppMode = useSetAtom(loadAppModeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  // Counter to force remount of lazy component after a chunk load failure.
  const [lazyRetryKey, setLazyRetryKey] = useState(0);

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
      {appMode === "chooser" ? (
        <ChooserMode />
      ) : (
        <ChunkErrorBoundary onRetry={() => {
          // Reassign to create a fresh lazy() with a new import() promise
          LazyMainMode = lazy(() => import("./MainMode"));
          setLazyRetryKey((k) => k + 1);
        }}>
          <Suspense key={lazyRetryKey} fallback={<LoadingSpinner />}>
            <LazyMainMode />
          </Suspense>
        </ChunkErrorBoundary>
      )}
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
