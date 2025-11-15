import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  effectiveThemeAtom,
  loadThemePreferenceAtom,
} from '../state/themeAtoms';
import { PanelStack } from './PanelStack';

export function PanelApp() {
  useThemeSynchronizer();

  return (
    <div className="app-container">
      <PanelStack />
    </div>
  );
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
