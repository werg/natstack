import { useEffect, useState, useRef, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Flex } from "@radix-ui/themes";

import { effectiveThemeAtom, loadThemePreferenceAtom } from "../state/themeAtoms";
import { NavigationProvider, useNavigation } from "./NavigationContext";
import { PanelTreeProvider, PanelDndProvider } from "../shell/hooks/index.js";
import { useShellEvent } from "../shell/useShellEvent";
import { app } from "../shell/client";
import { PanelStack } from "./PanelStack";
import { TitleBar } from "./TitleBar";
import type { PanelContextMenuAction } from "../../shared/ipc/types";

export function PanelApp() {
  return (
    <PanelTreeProvider>
      <PanelDndProvider>
        <NavigationProvider>
          <PanelAppContent />
        </NavigationProvider>
      </PanelDndProvider>
    </PanelTreeProvider>
  );
}

function PanelAppContent() {
  const effectiveTheme = useThemeSynchronizer();
  const [currentTitle, setCurrentTitle] = useState("NatStack");

  // Use refs for callback handlers to avoid complex state patterns
  const openPanelDevToolsRef = useRef<() => void>(() => {});
  const handlePanelActionRef = useRef<(panelId: string, action: PanelContextMenuAction) => void>(
    () => {}
  );

  const { navigateToId, registerNavigateToId } = useNavigation();

  // Stable callbacks that delegate to refs
  const openPanelDevTools = useCallback(() => openPanelDevToolsRef.current(), []);
  const handlePanelAction = useCallback(
    (panelId: string, action: PanelContextMenuAction) =>
      handlePanelActionRef.current(panelId, action),
    []
  );

  // Keyboard shortcut for panel devtools
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

  // Listen for panel devtools toggle from native menu via shell event
  const handleTogglePanelDevTools = useCallback(() => {
    openPanelDevTools();
  }, [openPanelDevTools]);
  useShellEvent("toggle-panel-devtools", handleTogglePanelDevTools);

  // Listen for shell panel created event to navigate to the new panel
  useEffect(() => {
    const handleShellPanelCreated = (event: Event) => {
      const customEvent = event as CustomEvent<{ panelId: string }>;
      const { panelId } = customEvent.detail;
      if (panelId) {
        navigateToId(panelId);
      }
    };

    window.addEventListener("shell-panel-created", handleShellPanelCreated);
    return () => {
      window.removeEventListener("shell-panel-created", handleShellPanelCreated);
    };
  }, [navigateToId]);

  return (
    <Flex direction="column" height="100vh" style={{ overflow: "hidden" }}>
      <TitleBar title={currentTitle} onNavigateToId={navigateToId} onPanelAction={handlePanelAction} />
      <PanelStack
        onTitleChange={setCurrentTitle}
        hostTheme={effectiveTheme}
        onRegisterDevToolsHandler={(handler) => {
          openPanelDevToolsRef.current = handler;
        }}
        onRegisterNavigateToId={registerNavigateToId}
        onRegisterPanelAction={(handler) => {
          handlePanelActionRef.current = handler;
        }}
      />
    </Flex>
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

  // Listen for system theme changes via shell event
  const handleThemeChanged = useCallback(() => {
    // Force re-evaluation of system theme
    // The effectiveThemeAtom will automatically pick up the new system preference
    loadThemePreference();
  }, [loadThemePreference]);
  useShellEvent("system-theme-changed", handleThemeChanged);

  // Sync initial theme with Electron on mount
  useEffect(() => {
    void (async () => {
      try {
        await app.getSystemTheme();
        // Only set if we're in system mode
        const savedMode = localStorage.getItem("theme-mode");
        if (!savedMode || savedMode === "system") {
          await app.setThemeMode("system");
        }
      } catch (error) {
        console.error("Failed to sync theme with Electron:", error);
      }
    })();
  }, []);

  return effectiveTheme;
}
