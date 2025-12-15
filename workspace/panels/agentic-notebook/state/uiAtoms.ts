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
 * Mobile breakpoint detection.
 */
export const isMobileAtom = atom<boolean>(false);

/**
 * Whether keyboard shortcuts overlay is visible.
 */
export const shortcutsOverlayOpenAtom = atom<boolean>(false);
