import { describe, it, expect } from "vitest";
import { diff3Merge } from "./diff3.js";

describe("diff3Merge", () => {
  it("returns ours when theirs is unchanged", () => {
    const result = diff3Merge("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n");
    expect(result).toEqual({ ok: true, text: "a\nB\nc\n", conflicts: 0 });
  });

  it("returns theirs when ours is unchanged", () => {
    const result = diff3Merge("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n");
    expect(result).toEqual({ ok: true, text: "a\nb\nC\n", conflicts: 0 });
  });

  it("merges non-overlapping edits from both sides", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const ours = "ONE\ntwo\nthree\nfour\nfive\n";
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  });

  it("merges an insertion and a distant deletion", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nnew\nb\nc\nd\ne\n";
    const theirs = "a\nb\nc\nd\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nnew\nb\nc\nd\n");
  });

  it("takes identical changes from both sides without conflict", () => {
    const base = "a\nb\nc\n";
    const both = "a\nB!\nc\n";
    const result = diff3Merge(base, both, both);
    expect(result).toEqual({ ok: true, text: both, conflicts: 0 });
  });

  it("emits conflict markers for overlapping different edits", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nours\nc\n";
    const theirs = "a\ntheirs\nc\n";
    const result = diff3Merge(base, ours, theirs, {
      oursLabel: "main",
      theirsLabel: "ctx:1",
    });
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< main\nours\n=======\ntheirs\n>>>>>>> ctx:1\nc\n");
  });

  it("handles edits at file boundaries", () => {
    const base = "m\n";
    const ours = "start\nm\n";
    const theirs = "m\nend\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("start\nm\nend\n");
  });

  it("handles empty base (both sides add different content → conflict)", () => {
    const result = diff3Merge("", "ours\n", "theirs\n");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("<<<<<<<");
  });

  it("renders multiple absorbed theirs chunks with base gap lines intact", () => {
    // ours replaces B..D as one chunk; theirs edits B and D separately with
    // unchanged base line c between — c must survive in theirs' view.
    const base = "a\nB\nc\nD\ne\n";
    const ours = "a\nX\ne\n";
    const theirs = "a\nB2\nc\nD2\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nX\n=======\nB2\nc\nD2\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when theirs edits inside a base span replaced by ours", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nZ\ne\n";
    const theirs = "a\nb\nT\nd\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nZ\n=======\nb\nT\nd\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when ours partially overlaps the left side of theirs", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nB\nC\nd\ne\n";
    const theirs = "a\nX\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< ours\nB\nC\nd\n=======\nX\n>>>>>>> theirs\ne\n");
  });

  it("conflicts when ours partially overlaps the right side of theirs", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nb\nX\ne\n";
    const theirs = "a\nB\nC\nd\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.text).toBe("a\n<<<<<<< ours\nb\nX\n=======\nB\nC\nd\n>>>>>>> theirs\ne\n");
  });

  it("renders multiple absorbed ours chunks with base gap lines intact (symmetric)", () => {
    const base = "a\nB\nc\nD\ne\n";
    const ours = "a\nB2\nc\nD2\ne\n";
    const theirs = "a\nX\ne\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe("a\n<<<<<<< ours\nB2\nc\nD2\n=======\nX\n>>>>>>> theirs\ne\n");
  });

  it("handles multiple absorbed chunks on both sides", () => {
    // The region cascades: ours' B..D replacement absorbs theirs' D..F
    // replacement, which in turn absorbs ours' F edit. Each side keeps its
    // unchanged base gap lines (e for ours, c for theirs).
    const base = "a\nB\nc\nD\ne\nF\ng\n";
    const ours = "a\nX\ne\nF1\ng\n"; // replaces B..D with X, edits F
    const theirs = "a\nB2\nc\nY\ng\n"; // edits B, replaces D..F with Y
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(result.text).toBe(
      "a\n" +
        "<<<<<<< ours\n" +
        "X\ne\nF1\n" +
        "=======\n" +
        "B2\nc\nY\n" +
        ">>>>>>> theirs\n" +
        "g\n"
    );
  });

  it("still auto-merges multiple non-overlapping chunks from both sides", () => {
    const base = "a\nb\nc\nd\ne\nf\ng\n";
    const ours = "a\nB!\nc\nd\ne\nF!\ng\n";
    const theirs = "a\nb\nc\nD!\ne\nf\ng\n";
    const result = diff3Merge(base, ours, theirs);
    expect(result.ok).toBe(true);
    expect(result.text).toBe("a\nB!\nc\nD!\ne\nF!\ng\n");
  });

  it("preserves missing trailing newline when no input has one", () => {
    const result = diff3Merge("a\nb", "a\nB", "a\nb");
    expect(result.text).toBe("a\nB");
  });
});
