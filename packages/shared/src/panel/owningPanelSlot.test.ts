import { describe, expect, it } from "vitest";
import { resolveOwningPanelSlot } from "./owningPanelSlot.js";

describe("resolveOwningPanelSlot", () => {
  // Lineage (entity-id space): do:agent → panel:nav-B (a panel's runtime entity) → server.
  // do:eval → panel:nav-gone (a panel whose slot was CLOSED) → panel:nav-B.
  const lineage: Record<string, string | undefined> = {
    "do:agent": "panel:nav-B",
    "panel:nav-B": "server",
    "do:eval": "panel:nav-gone",
    "panel:nav-gone": "panel:nav-B",
  };
  // Durable nav→OPEN-slot mapping: only panel:nav-B has an open slot.
  const openSlotForEntity: Record<string, string | undefined> = {
    "panel:nav-B": "panel:tree/B",
  };
  const baseDeps = {
    isOpenSlot: () => false,
    resolveOpenSlotForEntity: async (id: string) => openSlotForEntity[id],
    resolveParentId: async (id: string) => lineage[id],
  };

  it("returns an explicit open slot id immediately (isOpenSlot path)", async () => {
    const got = await resolveOwningPanelSlot("panel:tree/B", {
      ...baseDeps,
      isOpenSlot: (id) => id === "panel:tree/B",
    });
    expect(got).toBe("panel:tree/B");
  });

  it("maps a panel nav (runtime-entity) id to its open tree slot", async () => {
    const got = await resolveOwningPanelSlot("panel:nav-B", baseDeps);
    expect(got).toBe("panel:tree/B");
  });

  it("walks past non-panel ancestors to the nearest owning panel slot", async () => {
    const got = await resolveOwningPanelSlot("do:agent", baseDeps);
    expect(got).toBe("panel:tree/B");
  });

  it("skips a panel whose slot is closed/removed and falls through (robustness)", async () => {
    // do:eval → panel:nav-gone (no open slot) → panel:nav-B (open slot).
    const got = await resolveOwningPanelSlot("do:eval", baseDeps);
    expect(got).toBe("panel:tree/B");
  });

  it("falls back to root when no panel ancestor has an open slot", async () => {
    const got = await resolveOwningPanelSlot("do:agent", {
      ...baseDeps,
      resolveOpenSlotForEntity: async () => undefined,
    });
    expect(got).toBeUndefined();
  });

  it("terminates on a lineage cycle", async () => {
    const cyclic: Record<string, string | undefined> = { a: "b", b: "a" };
    const got = await resolveOwningPanelSlot("a", {
      isOpenSlot: () => false,
      resolveOpenSlotForEntity: async () => undefined,
      resolveParentId: async (id) => cyclic[id],
    });
    expect(got).toBeUndefined();
  });
});
