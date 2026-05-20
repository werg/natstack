import type { SavedLayout } from "./types.js";

export const MAX_SAVED_LAYOUTS = 32;

export function upsertSavedLayout(layouts: SavedLayout[], layout: SavedLayout, now = Date.now()): SavedLayout[] {
  return [
    { ...layout, updatedAt: now },
    ...layouts.filter((item) => item.id !== layout.id && item.name !== layout.name),
  ].slice(0, MAX_SAVED_LAYOUTS);
}

export function touchSavedLayout(layouts: SavedLayout[], layoutId: string, now = Date.now()): SavedLayout[] {
  const layout = layouts.find((item) => item.id === layoutId);
  if (!layout) return layouts;
  return [{ ...layout, updatedAt: now }, ...layouts.filter((item) => item.id !== layoutId)].slice(0, MAX_SAVED_LAYOUTS);
}

export function renameSavedLayout(layouts: SavedLayout[], layoutId: string, name: string, now = Date.now()): SavedLayout[] {
  const layout = layouts.find((item) => item.id === layoutId);
  if (!layout) return layouts;
  return [
    { ...layout, name, updatedAt: now },
    ...layouts.filter((item) => item.id !== layoutId && item.name !== name),
  ].slice(0, MAX_SAVED_LAYOUTS);
}

export function deleteSavedLayout(layouts: SavedLayout[], layoutId: string): SavedLayout[] {
  return layouts.filter((item) => item.id !== layoutId);
}
