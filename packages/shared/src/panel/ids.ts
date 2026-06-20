type Brand<T, Name extends string> = T & { readonly __brand: Name };

/** Stable workspace/tree handle for a panel slot. This is what shell UI uses. */
export type PanelSlotId = Brand<string, "PanelSlotId">;

/** Runtime identity for a concrete panel entity/history entry. This is what RPC auth uses. */
export type PanelEntityId = Brand<string, "PanelEntityId">;

// Canonical shapes (see panelIdUtils.computePanelId + canonicalEntityId + mintHistoryEntryKey):
//   slot id   = `panel:tree/…`  (a tree position; what nesting/panel-tree ops use)
//   entity id = `panel:nav-…`   (a live runtime instance; what RPC auth + leases use)
// The two are DISTINCT id spaces for the SAME panel. Confusing them (a nav id where a slot id is
// required, or vice-versa) silently rooted launched panels — invisible because both are `string` and
// the casts laundered anything. These casts now VALIDATE the shape so the mix-up throws LOUDLY at the
// boundary instead of corrupting the tree downstream.
const PANEL_SLOT_PREFIX = "panel:tree/";
const PANEL_ENTITY_PREFIX = "panel:nav-";

export function asPanelSlotId(value: string): PanelSlotId {
  if (!value.startsWith(PANEL_SLOT_PREFIX)) {
    throw new Error(
      `Not a panel slot id (expected "${PANEL_SLOT_PREFIX}…", got ${JSON.stringify(value)}). ` +
        `Slot ids name a tree position; a nav/entity id ("${PANEL_ENTITY_PREFIX}…") or other id must ` +
        `be mapped to its slot first (resolveOwningPanelSlot / workspace-state slot.resolveByEntity).`
    );
  }
  return value as PanelSlotId;
}

export function asPanelEntityId(value: string): PanelEntityId {
  if (!value.startsWith(PANEL_ENTITY_PREFIX)) {
    throw new Error(
      `Not a panel entity id (expected "${PANEL_ENTITY_PREFIX}…", got ${JSON.stringify(value)}). ` +
        `Entity/nav ids name a live runtime instance; a slot id ("${PANEL_SLOT_PREFIX}…") must not be ` +
        `passed here.`
    );
  }
  return value as PanelEntityId;
}

/**
 * Narrowing guards for code that handles ids of MIXED kinds (e.g. RPC routing probes any target id —
 * panel slot, panel entity, worker, or do). Use these to branch instead of `asPanel*` (which throws),
 * so a non-panel id is treated as "not a panel", not a crash.
 */
export function isPanelSlotId(value: string): value is PanelSlotId {
  return value.startsWith(PANEL_SLOT_PREFIX);
}

export function isPanelEntityId(value: string): value is PanelEntityId {
  return value.startsWith(PANEL_ENTITY_PREFIX);
}
