import { describe, it, expect } from "vitest";
import { createEditTool } from "../edit.js";
import { StubVcs } from "./stub-vcs.js";

const CWD = "/work/ctx";

describe("createEditTool", () => {
  it("replaces an exact match", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "const x = 1;\nconst y = 2;" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "const x = 1;",
      newText: "const x = 42;",
    });
    expect(result.details.diff).toContain("const x = 42;");
    expect(vcs.read("a.ts")).toContain("const x = 42;");
    // Provenance: the edit is tagged with the authoring tool-call id (the edge
    // into the agentic trajectory — file → edit → invocation → turn → session).
    expect(vcs.lastEditInput?.invocationId).toBe("call-1");
  });

  it("rejects when there are multiple occurrences", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "foo\nfoo\nfoo" } });
    const tool = createEditTool(CWD, vcs);
    await expect(
      tool.execute("call-1", { path: "a.ts", oldText: "foo", newText: "bar" }),
    ).rejects.toThrow(/3 occurrences/);
  });

  it("rejects when text is not found", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "alpha" } });
    const tool = createEditTool(CWD, vcs);
    await expect(
      tool.execute("call-1", { path: "a.ts", oldText: "beta", newText: "gamma" }),
    ).rejects.toThrow(/Could not find/);
  });

  it("rejects when file is missing", async () => {
    const vcs = new StubVcs();
    const tool = createEditTool(CWD, vcs);
    await expect(
      tool.execute("call-1", { path: "missing.ts", oldText: "x", newText: "y" }),
    ).rejects.toThrow(/not found/i);
  });

  it("treats no-op replacements as completed no-ops", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "const x = 1;" } });
    const tool = createEditTool(CWD, vcs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "const x = 1;",
      newText: "const x = 1;",
    });

    expect((result.content[0] as { text: string }).text).toContain("No changes made");
    expect(result.details.diff).toBe("");
  });

  it("uses fuzzy match for smart quotes", async () => {
    const vcs = new StubVcs({
      files: { ["a.ts"]: "say \u201chello\u201d world" },
    });
    const tool = createEditTool(CWD, vcs);
    await tool.execute("call-1", {
      path: "a.ts",
      oldText: '"hello"',
      newText: '"goodbye"',
    });
    expect(vcs.read("a.ts")).toContain('"goodbye"');
  });
});
