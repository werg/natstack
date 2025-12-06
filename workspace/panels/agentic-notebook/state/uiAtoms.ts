import { atom } from "jotai";
import type { SubmitKeyConfig } from "../types/channel";

/**
 * Sidebar visibility state.
 */
export const sidebarOpenAtom = atom<boolean>(true);

/**
 * Current input value.
 */
export const inputValueAtom = atom<string>("");

/**
 * Submit key configuration.
 */
export const submitKeyConfigAtom = atom<SubmitKeyConfig>({
  submitKey: "Enter",
  enterBehavior: "submit",
});

/**
 * Whether the input is focused.
 */
export const inputFocusedAtom = atom<boolean>(false);

/**
 * Mobile breakpoint detection.
 */
export const isMobileAtom = atom<boolean>(false);

/**
 * Whether keyboard shortcuts overlay is visible.
 */
export const shortcutsOverlayOpenAtom = atom<boolean>(false);

/**
 * Theme mode (dark, light, or system).
 */
export type ThemeMode = "light" | "dark" | "system";
export const themeModeAtom = atom<ThemeMode>("system");
