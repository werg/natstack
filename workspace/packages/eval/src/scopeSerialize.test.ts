import { describe, expect, it } from "vitest";
import { deserializeScope, serializeScope } from "./scopeSerialize.js";

describe("scope serialization", () => {
  it("drops oversized top-level values instead of producing oversized SQLite payloads", () => {
    const scope = new Map<string, unknown>([
      ["small", { ok: true }],
      ["__lastEvalReturn", "x".repeat(512 * 1024)],
    ]);

    const serialized = serializeScope(scope);
    const restored = deserializeScope(serialized.json);

    expect(serialized.json.length).toBeLessThan(160 * 1024);
    expect(restored.get("small")).toEqual({ ok: true });
    expect(restored.has("__lastEvalReturn")).toBe(false);
    expect(serialized.serializedKeys).toContain("small");
    expect(serialized.droppedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "__lastEvalReturn",
          reason: expect.stringContaining("serialized value too large"),
        }),
      ]),
    );
  });

  it("drops the largest persisted keys when the total scope payload is too large", () => {
    const scope = new Map<string, unknown>([
      ["first", "a".repeat(120 * 1024)],
      ["second", "b".repeat(120 * 1024)],
      ["third", "c".repeat(120 * 1024)],
      ["fourth", "d".repeat(120 * 1024)],
      ["small", "kept"],
    ]);

    const serialized = serializeScope(scope);
    const restored = deserializeScope(serialized.json);

    expect(serialized.json.length).toBeLessThanOrEqual(384 * 1024);
    expect(restored.get("small")).toBe("kept");
    expect(serialized.droppedPaths.some((entry) => entry.reason.includes("serialized scope"))).toBe(true);
  });
});
