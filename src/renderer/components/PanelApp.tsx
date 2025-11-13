import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  activePathAtom,
  panelColumnCountAtom,
  panelVisibilityStateAtom,
  targetPanelAtom,
} from '../state/panelAtoms';
import {
  effectiveThemeAtom,
  loadThemePreferenceAtom,
  setThemeModeAtom,
} from '../state/themeAtoms';
import { reconcileVisibilityState } from '../state/panelVisibility';
import { ControlBar } from './ControlBar';
import { PanelStack } from './PanelStack';

export function PanelApp() {
  useVisibilitySynchronizer();
  useThemeSynchronizer();

  return (
    <div className="app-container">
      <ControlBar />
      <PanelStack />
    </div>
  );
}

/**
 * Hook that synchronizes the visibility state atom with changes to:
 * - activePath (when navigating or adding/removing panels)
 * - columnCount (when user adjusts visible panel limit)
 * - targetPanelId (when user focuses a different panel)
 *
 * Exported for testing purposes.
 */
export function useVisibilitySynchronizer(): void {
  const activePath = useAtomValue(activePathAtom);
  const columnCount = useAtomValue(panelColumnCountAtom);
  const targetPanelId = useAtomValue(targetPanelAtom);
  const setVisibilityState = useSetAtom(panelVisibilityStateAtom);

  useEffect(() => {
    setVisibilityState((previous) =>
      reconcileVisibilityState({
        activePath,
        columnCount,
        targetPanelId,
        previous,
      })
    );
  }, [activePath, columnCount, targetPanelId, setVisibilityState]);
}

/**
 * Hook that synchronizes the theme with system preferences.
 * - Loads saved theme preference from localStorage on mount
 * - Applies the effective theme to the document
 * - Listens for system theme changes
 * - Syncs with Electron's nativeTheme
 *
 * Exported for testing purposes.
 */
export function useThemeSynchronizer(): void {
  const effectiveTheme = useAtomValue(effectiveThemeAtom);
  const loadThemePreference = useSetAtom(loadThemePreferenceAtom);
  const setThemeMode = useSetAtom(setThemeModeAtom);

  // Load saved theme preference on mount
  useEffect(() => {
    loadThemePreference();
  }, [loadThemePreference]);

  // Apply theme to document
  useEffect(() => {
    if (effectiveTheme === 'dark') {
      document.documentElement.classList.add('dark-mode');
    } else {
      document.documentElement.classList.remove('dark-mode');
    }
  }, [effectiveTheme]);

  // Listen for system theme changes from Electron
  useEffect(() => {
    if (typeof window.electronAPI === 'undefined') {
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
    if (typeof window.electronAPI === 'undefined') {
      return;
    }

    void (async () => {
      try {
        const systemTheme = await window.electronAPI.getSystemTheme();
        // Only set if we're in system mode
        const savedMode = localStorage.getItem('theme-mode');
        if (!savedMode || savedMode === 'system') {
          await window.electronAPI.setThemeMode('system');
        }
      } catch (error) {
        console.error('Failed to sync theme with Electron:', error);
      }
    })();
  }, []);
}
