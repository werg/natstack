/**
 * Theme state atoms -- Jotai atoms for theme detection.
 *
 * Uses React Native's Appearance API to detect the system theme.
 * Unlike Electron (which uses matchMedia/localStorage), mobile uses
 * the native Appearance module directly.
 */

import { atom } from "jotai";
import { Appearance, type ColorSchemeName } from "react-native";

/** Current color scheme from the system ("light" | "dark" | null) */
export const colorSchemeAtom = atom<ColorSchemeName>(Appearance.getColorScheme());

/** Derived: whether dark mode is active (defaults to dark if system doesn't report) */
export const isDarkModeAtom = atom((get) => {
  const scheme = get(colorSchemeAtom);
  return scheme !== "light"; // default to dark
});

/** Basic theme colors derived from the color scheme */
export const themeColorsAtom = atom((get) => {
  const dark = get(isDarkModeAtom);
  return {
    background: dark ? "#1a1a2e" : "#f5f5f5",
    surface: dark ? "#16213e" : "#ffffff",
    text: dark ? "#e0e0e0" : "#1a1a1a",
    textSecondary: dark ? "#888888" : "#666666",
    border: dark ? "#333333" : "#cccccc",
    primary: dark ? "#0f3460" : "#1a73e8",
    danger: dark ? "#5c2e2e" : "#d93025",
    statusConnected: "#4caf50",
    statusConnecting: "#ff9800",
    statusDisconnected: "#f44336",
  };
});
