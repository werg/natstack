import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Flex, Theme } from "@radix-ui/themes";

import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import {
  settingsDialogOpenAtom,
  workspaceChooserDialogOpenAtom,
} from "../state/appModeAtoms";
import { NavigationProvider, useNavigation } from "./NavigationContext";
import { PanelStack } from "./PanelStack";
import { TitleBar } from "./TitleBar";

export function PanelApp() {
  return (
    <NavigationProvider>
      <PanelAppContent />
    </NavigationProvider>
  );
}

function PanelAppContent() {
  const effectiveTheme = useThemeSynchronizer();
  const [currentTitle, setCurrentTitle] = useState("NatStack");
  const [openPanelDevTools, setOpenPanelDevTools] = useState<() => void>(() => () => {});
  const { navigate, registerNavigate } = useNavigation();
  const setSettingsOpen = useSetAtom(settingsDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  const openAppDevTools = () => {
    void window.electronAPI.openAppDevTools().catch((error) => {
      console.error("Failed to open app devtools", error);
    });
  };

  const openSettings = () => {
    setSettingsOpen(true);
  };

  const openWorkspaceChooser = () => {
    setWorkspaceChooserOpen(true);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openPanelDevTools();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openPanelDevTools]);

  return (
    <Theme appearance={effectiveTheme} radius="none">
      <Flex direction="column" height="100vh" style={{ overflow: "hidden" }}>
        <TitleBar
          title={currentTitle}
          onOpenPanelDevTools={openPanelDevTools}
          onOpenAppDevTools={openAppDevTools}
          onOpenSettings={openSettings}
          onOpenWorkspaceChooser={openWorkspaceChooser}
          onNavigate={navigate}
        />
        <PanelStack
          onTitleChange={setCurrentTitle}
          hostTheme={effectiveTheme}
          onRegisterDevToolsHandler={setOpenPanelDevTools}
          onRegisterNavigate={registerNavigate}
        />
      </Flex>
    </Theme>
  );
}

/**
 * Hook that synchronizes the theme with system preferences.
 * - Loads saved theme preference from localStorage on mount
 * - Applies the effective theme to the document
 * - Listens for system theme changes
 * - Syncs with Electron's nativeTheme
 *
 * Returns the effective theme for use with Radix UI Theme component.
 * Exported for testing purposes.
 */
export function useThemeSynchronizer(): "light" | "dark" {
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);

  // Load saved theme preference on mount
  useEffect(() => {
    loadThemePreference();
  }, [loadThemePreference]);

  // Listen for system theme changes from Electron
  useEffect(() => {
    if (typeof window.electronAPI === "undefined") {
      return;
    }

    const cleanup = window.electronAPI.onSystemThemeChanged(() => {
      // Force re-evaluation of system theme
      // The effectiveThemeAtom will automatically pick up the new system preference
      loadThemePreference();
    });

    return cleanup;
  }, [loadThemePreference]);

  // Sync initial theme with Electron on mount
  useEffect(() => {
    if (typeof window.electronAPI === "undefined") {
      return;
    }

    void (async () => {
      try {
        await window.electronAPI.getSystemTheme();
        // Only set if we're in system mode
        const savedMode = localStorage.getItem("theme-mode");
        if (!savedMode || savedMode === "system") {
          await window.electronAPI.setThemeMode("system");
        }
      } catch (error) {
        console.error("Failed to sync theme with Electron:", error);
      }
    })();
  }, []);

  return effectiveTheme;
}
