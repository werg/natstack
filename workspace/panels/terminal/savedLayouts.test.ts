import { describe, expect, it } from "vitest";
import { deleteSavedLayout, renameSavedLayout, touchSavedLayout, upsertSavedLayout } from "./savedLayouts.js";
import type { SavedLayout } from "./types.js";

describe("saved layout model", () => {
  it("upserts by id or name and caps the list", () => {
    const layouts = Array.from({ length: 35 }, (_, index) => layout(`id-${index}`, `Layout ${index}`, index));

    const result = upsertSavedLayout(layouts, layout("new", "Layout 4", 100), 100);

    expect(result).toHaveLength(32);
    expect(result[0]).toMatchObject({ id: "new", name: "Layout 4", updatedAt: 100 });
    expect(result.some((item) => item.id === "id-4")).toBe(false);
  });

  it("touches loaded layouts by moving them to the front", () => {
    const layouts = [layout("a", "A", 1), layout("b", "B", 2), layout("c", "C", 3)];

    expect(touchSavedLayout(layouts, "b", 10).map((item) => [item.id, item.updatedAt])).toEqual([
      ["b", 10],
      ["a", 1],
      ["c", 3],
    ]);
  });

  it("renames layouts as an LRU edit and removes name conflicts", () => {
    const layouts = [layout("a", "A", 1), layout("b", "B", 2), layout("c", "C", 3)];

    const result = renameSavedLayout(layouts, "b", "A", 10);

    expect(result.map((item) => [item.id, item.name, item.updatedAt])).toEqual([
      ["b", "A", 10],
      ["c", "C", 3],
    ]);
  });

  it("deletes by id", () => {
    expect(deleteSavedLayout([layout("a", "A", 1), layout("b", "B", 2)], "a").map((item) => item.id)).toEqual(["b"]);
  });
});

function layout(id: string, name: string, updatedAt: number): SavedLayout {
  return {
    id,
    name,
    tree: { kind: "leaf", sessionId: "slot-1" },
    cwds: { "slot-1": "/repo" },
    labels: { "slot-1": "Shell" },
    updatedAt,
  };
}
