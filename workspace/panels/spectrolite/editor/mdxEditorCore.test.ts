import { describe, it, expect } from "vitest";
import { $getRoot, $createTextNode, type ElementNode } from "lexical";
import { createMdxEditorCore, HISTORIC_TAG } from "./mdxEditorCore.js";
import { buildEditOps } from "../coedit/commitEdits.js";

describe("MdxEditorCore (headless Lexical + vendored pipeline)", () => {
  it("round-trips markdown through import → export", () => {
    const core = createMdxEditorCore();
    const doc = "# Heading\n\nFirst paragraph.\n\nSecond paragraph.";
    core.setCanonical(doc);
    const out = core.getCanonical();
    expect(out).toContain("# Heading");
    expect(out).toContain("First paragraph.");
    expect(out).toContain("Second paragraph.");
  });

  it("exposes top-level content blocks with stable node-key ids", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\nbody one\n\nbody two");
    const blocks = core.getBlocks();
    expect(blocks.map((b) => b.text)).toEqual(["# A", "body one", "body two"]);
    // ids are real Lexical node keys (stable, reused by apply ops).
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
  });

  it("a user edit yields a surgical (non-fallback) commit hunk", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\nfirst\n\nsecond");
    const baseText = core.getCanonical();

    // Simulate the user typing into the "first" paragraph (block index 1).
    core.editor.update(
      () => {
        const para = $getRoot().getChildren()[1] as ElementNode;
        para.append($createTextNode(" EDITED"));
      },
      { discrete: true }
    );

    const { canonical, dirty } = core.getDirtyCommit();
    expect(canonical).toContain("first EDITED");
    const built = buildEditOps({
      path: "Doc.mdx",
      baseText,
      currentCanonical: canonical,
      dirtyBlocks: dirty,
    });
    expect(built.usedFallback).toBe(false); // serializer is stable → no merge noise
    expect(built.changed).toBe(true);
  });

  it("applyContained replaces one block surgically, leaving siblings intact", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\noriginal\n\ntail");
    const blocks = core.getBlocks();
    const middle = blocks.find((b) => b.text === "original")!;
    core.applyContained({ kind: "contained", oldId: middle.id, oldIndex: 1, newText: "replaced" });
    const out = core.getCanonical();
    expect(out).toContain("replaced");
    expect(out).not.toContain("original");
    expect(out).toContain("# A");
    expect(out).toContain("tail");
  });

  it("applyStructural inserts a new block before an anchor", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\ntail");
    const blocks = core.getBlocks();
    const tail = blocks.find((b) => b.text === "tail")!;
    core.applyStructural({
      kind: "structural",
      fromIndex: 1,
      toIndex: 0,
      oldIds: [],
      newTexts: ["inserted"],
      beforeId: tail.id,
    });
    const out = core.getCanonical();
    expect(out.indexOf("inserted")).toBeGreaterThan(out.indexOf("# A"));
    expect(out.indexOf("inserted")).toBeLessThan(out.indexOf("tail"));
  });

  it("applyStructural deletes a block", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\nkill me\n\nkeep");
    const blocks = core.getBlocks();
    const victim = blocks.find((b) => b.text === "kill me")!;
    core.applyStructural({
      kind: "structural",
      fromIndex: 1,
      toIndex: 1,
      oldIds: [victim.id],
      newTexts: [],
      beforeId: null,
    });
    const out = core.getCanonical();
    expect(out).not.toContain("kill me");
    expect(out).toContain("keep");
  });

  it("onUserEdit fires for user edits but NOT for historic (programmatic) applies", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\nbody");
    let hits = 0;
    const off = core.onUserEdit(() => hits++);

    // Historic apply → must NOT count.
    const blocks = core.getBlocks();
    core.applyContained({
      kind: "contained",
      oldId: blocks[1]!.id,
      oldIndex: 1,
      newText: "scribe text",
    });
    expect(hits).toBe(0);

    // A real user edit → counts.
    core.editor.update(
      () => {
        const para = $getRoot().getChildren()[1] as ElementNode;
        para.append($createTextNode("!"));
      },
      { discrete: true }
    );
    expect(hits).toBeGreaterThan(0);
    off();
  });

  it("tags programmatic applies with HISTORIC_TAG", () => {
    const core = createMdxEditorCore();
    core.setCanonical("# A\n\nbody");
    let sawHistoric = false;
    const off = core.editor.registerUpdateListener(({ tags }) => {
      if (tags.has(HISTORIC_TAG)) sawHistoric = true;
    });
    const blocks = core.getBlocks();
    core.applyContained({ kind: "contained", oldId: blocks[1]!.id, oldIndex: 1, newText: "x" });
    expect(sawHistoric).toBe(true);
    off();
  });
});
