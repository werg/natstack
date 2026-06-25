import { describe, it, expect } from "vitest";
import { buildEditOps, applyReplaceHunks } from "./commitEdits.js";

const PATH = "projects/default/Doc.mdx";

describe("buildEditOps", () => {
  it("emits no edits when nothing changed", () => {
    const text = "# A\n\nbody\n";
    const r = buildEditOps({ path: PATH, baseText: text, currentCanonical: text, dirtyBlocks: [] });
    expect(r.changed).toBe(false);
    expect(r.edits).toEqual([]);
    expect(r.usedFallback).toBe(false);
  });

  it("emits surgical per-block hunks when blocks edit in place (no fallback)", () => {
    // base: "# Title\n\npara one\n\npara two" — edit the middle block.
    const baseText = "# Title\n\npara one\n\npara two";
    const currentCanonical = "# Title\n\npara ONE\n\npara two";
    // The middle block "para one" sits at [9, 17).
    expect(baseText.slice(9, 17)).toBe("para one");
    const r = buildEditOps({
      path: PATH,
      baseText,
      currentCanonical,
      dirtyBlocks: [{ baseStart: 9, baseEnd: 17, newText: "para ONE" }],
    });
    expect(r.usedFallback).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.edits).toEqual([
      {
        kind: "replace",
        path: PATH,
        hunks: [{ start: 9, end: 17, oldText: "para one", newText: "para ONE" }],
      },
    ]);
    // Replaying the hunks reproduces the current canonical exactly.
    expect(applyReplaceHunks(baseText, r.edits[0]!.hunks)).toBe(currentCanonical);
  });

  it("applies multiple disjoint dirty-block hunks", () => {
    const baseText = "AAA\n\nBBB\n\nCCC";
    const currentCanonical = "A1A\n\nBBB\n\nC1C";
    const r = buildEditOps({
      path: PATH,
      baseText,
      currentCanonical,
      dirtyBlocks: [
        { baseStart: 0, baseEnd: 3, newText: "A1A" },
        { baseStart: 10, baseEnd: 13, newText: "C1C" },
      ],
    });
    expect(r.usedFallback).toBe(false);
    expect(r.edits[0]!.hunks).toHaveLength(2);
    expect(applyReplaceHunks(baseText, r.edits[0]!.hunks)).toBe(currentCanonical);
  });

  it("falls back to a whole-doc hunk when surgical hunks can't reconcile to canonical", () => {
    // Dirty block ranges don't reconstruct the current canonical (structural
    // drift) → single whole-document replace.
    const baseText = "AAA\n\nBBB";
    const currentCanonical = "AAA\n\nBBB\n\nCCC"; // a block was added — range map can't express it
    const r = buildEditOps({
      path: PATH,
      baseText,
      currentCanonical,
      dirtyBlocks: [{ baseStart: 5, baseEnd: 8, newText: "BBB" }], // unchanged block; no surgical change
    });
    expect(r.usedFallback).toBe(true);
    expect(r.edits[0]!.hunks).toEqual([
      { start: 0, end: baseText.length, oldText: baseText, newText: currentCanonical },
    ]);
    expect(applyReplaceHunks(baseText, r.edits[0]!.hunks)).toBe(currentCanonical);
  });

  it("falls back when a stale range would land out of bounds", () => {
    const baseText = "short";
    const currentCanonical = "shorter text now";
    const r = buildEditOps({
      path: PATH,
      baseText,
      currentCanonical,
      dirtyBlocks: [{ baseStart: 0, baseEnd: 999, newText: "x" }], // bogus range
    });
    expect(r.usedFallback).toBe(true);
    expect(applyReplaceHunks(baseText, r.edits[0]!.hunks)).toBe(currentCanonical);
  });
});
