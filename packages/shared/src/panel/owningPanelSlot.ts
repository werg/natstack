import { asPanelSlotId, type PanelSlotId } from "./ids.js";

/**
 * Dependencies for {@link resolveOwningPanelSlot}. Injected so the same walk works from the server
 * create handler (registry + workspace-state) and the eval parent resolver (entity store), against
 * one authoritative, durable source of truth.
 */
export interface OwningPanelSlotDeps {
  /** True if `id` is itself an OPEN panel TREE SLOT (slot-id space, e.g. an explicit `panel:tree/…`). */
  isOpenSlot: (id: string) => boolean | Promise<boolean>;
  /**
   * The OPEN tree slot whose CURRENT runtime entity is `id` (nav-id space, `panel:nav-…`), or
   * undefined. Must be durable (slot store), not lease-based — so it resolves even when the owning
   * panel isn't currently loaded, and returns nothing for a closed/removed panel.
   */
  resolveOpenSlotForEntity: (id: string) => Promise<string | undefined>;
  /** The launch parent (entity lineage `parentId`) of `id`, or undefined at the root. */
  resolveParentId: (id: string) => Promise<string | undefined>;
}

/**
 * Resolve the nearest OPEN panel that owns `startId`, returning its TREE SLOT id (the identity panel
 * NESTING uses) — or undefined for a root-level launch. The single source of truth for "what panel
 * does this belong to", shared by the server create handler and the eval parent resolver.
 *
 * It reconciles the two panel id spaces in ONE place — the entity lineage references panels by their
 * runtime-entity (nav) id, but the tree is keyed by SLOT id. At each lineage node it: (1) returns the
 * node if it is already an open slot (explicit slot-id parent); (2) else maps the node's nav id → its
 * open slot durably and returns that; (3) else walks up the `parentId` chain. Closed/removed panels
 * map to nothing and are walked past (removal-robust); the durable mapping closes the "owning panel
 * not currently loaded" hole a lease-based mapping would leave open. Terminates on cycles.
 */
export async function resolveOwningPanelSlot(
  startId: string,
  deps: OwningPanelSlotDeps
): Promise<PanelSlotId | undefined> {
  const seen = new Set<string>();
  let cur: string | undefined = startId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (await deps.isOpenSlot(cur)) return asPanelSlotId(cur);
    const slotId = await deps.resolveOpenSlotForEntity(cur);
    if (slotId) return asPanelSlotId(slotId);
    cur = await deps.resolveParentId(cur);
  }
  return undefined;
}
