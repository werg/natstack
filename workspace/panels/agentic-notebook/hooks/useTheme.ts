import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { themeModeAtom, type ThemeMode } from "../state/uiAtoms";

/**
 * Hook for managing theme mode.
 */
export function useThemeMode() {
  return useAtom(themeModeAtom);
}

/**
 * Hook for getting the resolved theme appearance (light or dark).
 * Handles system preference detection.
 */
export function useThemeAppearance(): "light" | "dark" {
  const themeMode = useAtomValue(themeModeAtom);
  const [systemPreference, setSystemPreference] = useState<"light" | "dark">("light");

  // Listen for system preference changes
  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    // Set initial value
    setSystemPreference(mediaQuery.matches ? "dark" : "light");

    // Listen for changes
    const handler = (e: MediaQueryListEvent) => {
      setSystemPreference(e.matches ? "dark" : "light");
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  if (themeMode === "system") {
    return systemPreference;
  }

  return themeMode;
}
