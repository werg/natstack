import { atom } from 'jotai';

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * The user's theme preference (light, dark, or system).
 * Defaults to 'system' to respect OS preferences.
 */
export const themeModeAtom = atom<ThemeMode>('system');

/**
 * The currently applied theme based on user preference and system settings.
 * This is a derived atom that resolves 'system' mode to the actual theme.
 */
export const effectiveThemeAtom = atom<'light' | 'dark'>((get) => {
  const mode = get(themeModeAtom);

  if (mode === 'system') {
    // Check system preference
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return 'light';
  }

  return mode;
});

/**
 * Action atom to set the theme mode.
 * Also persists the preference to localStorage.
 */
export const setThemeModeAtom = atom(
  null,
  (get, set, mode: ThemeMode) => {
    set(themeModeAtom, mode);

    // Persist to localStorage
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('theme-mode', mode);
      } catch (error) {
        console.error('Failed to save theme preference:', error);
      }
    }
  }
);

/**
 * Load theme preference from localStorage on app startup.
 */
export const loadThemePreferenceAtom = atom(
  null,
  (get, set) => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const saved = localStorage.getItem('theme-mode');
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        set(themeModeAtom, saved);
      }
    } catch (error) {
      console.error('Failed to load theme preference:', error);
    }
  }
);
