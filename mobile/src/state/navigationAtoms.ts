/**
 * Navigation state atoms -- Jotai atoms for panel navigation state.
 *
 * Tracks the currently active panel ID and provides derived state
 * for the AppBar title and navigation decisions.
 */

import { atom } from "jotai";
import type { Panel } from "@shared/types";
import { panelTreeAtom } from "./shellClientAtom";

/** The ID of the currently active/focused panel */
export const activePanelIdAtom = atom<string | null>(null);

/** Derived: find the active panel object from the tree */
export const activePanelAtom = atom<Panel | null>((get) => {
  const id = get(activePanelIdAtom);
  if (!id) return null;
  const tree = get(panelTreeAtom);
  return findPanelById(tree, id);
});

/** Derived: title of the active panel, or fallback */
export const activePanelTitleAtom = atom<string>((get) => {
  const panel = get(activePanelAtom);
  return panel?.title ?? "NatStack";
});

/** Derived: parent panel ID of the active panel (for Android back button) */
export const activePanelParentIdAtom = atom<string | null>((get) => {
  const id = get(activePanelIdAtom);
  if (!id) return null;
  const tree = get(panelTreeAtom);
  return findParentId(tree, id);
});

/** Recursively search for a panel by ID */
function findPanelById(panels: Panel[], id: string): Panel | null {
  for (const panel of panels) {
    if (panel.id === id) return panel;
    const found = findPanelById(panel.children, id);
    if (found) return found;
  }
  return null;
}

/** Find the parent ID of a panel */
function findParentId(panels: Panel[], targetId: string, parentId: string | null = null): string | null {
  for (const panel of panels) {
    if (panel.id === targetId) return parentId;
    const found = findParentId(panel.children, targetId, panel.id);
    if (found !== null) return found;
  }
  return null;
}
