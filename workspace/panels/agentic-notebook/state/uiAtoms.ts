import { atom } from "jotai";
import type { CodeLanguage } from "../types/messages";
import type { SubmitKeyConfig } from "../types/channel";

/**
 * Sidebar visibility state.
 */
export const sidebarOpenAtom = atom<boolean>(true);

/**
 * Input mode: text or code.
 */
export const inputModeAtom = atom<"text" | "code">("text");

/**
 * Selected code language for code input.
 */
export const codeLanguageAtom = atom<CodeLanguage>("typescript");

/**
 * Current input value (text or code).
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
