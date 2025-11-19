import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Theme } from "@radix-ui/themes";

import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import { PanelStack } from "./PanelStack";
import { TitleBar } from "./TitleBar";

export function PanelApp() {
  const effectiveTheme = useThemeSynchronizer();
  const [currentTitle, setCurrentTitle] = useState("NatStack");
  const [openPanelDevTools, setOpenPanelDevTools] = useState<() => void>(() => () => {});

  const openAppDevTools = () => {
    void window.electronAPI.openAppDevTools().catch((error) => {
      console.error("Failed to open app devtools", error);
    });
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openPanelDevTools();
      } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        openAppDevTools();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openPanelDevTools]);

  return (
    <Theme appearance={effectiveTheme}>
      <TitleBar
        title={currentTitle}
        onOpenPanelDevTools={openPanelDevTools}
        onOpenAppDevTools={openAppDevTools}
      />
      <PanelStack
        onTitleChange={setCurrentTitle}
        hostTheme={effectiveTheme}
        onRegisterDevToolsHandler={setOpenPanelDevTools}
      />
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
