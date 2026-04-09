import { describe, it, expect } from "vitest";
import { createEditTool } from "../edit.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createEditTool", () => {
  it("replaces an exact match", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "const x = 1;\nconst y = 2;" } });
    const tool = createEditTool(CWD, fs);
    const result = await tool.execute("call-1", {
      path: "a.ts",
      oldText: "const x = 1;",
      newText: "const x = 42;",
    });
    expect(result.details.diff).toContain("const x = 42;");
    const stored = (await fs.readFile("/work/ctx/a.ts")).toString();
    expect(stored).toContain("const x = 42;");
  });

  it("rejects when there are multiple occurrences", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "foo\nfoo\nfoo" } });
    const tool = createEditTool(CWD, fs);
    await expect(
      tool.execute("call-1", { path: "a.ts", oldText: "foo", newText: "bar" }),
    ).rejects.toThrow(/3 occurrences/);
  });

  it("rejects when text is not found", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "alpha" } });
    const tool = createEditTool(CWD, fs);
    await expect(
      tool.execute("call-1", { path: "a.ts", oldText: "beta", newText: "gamma" }),
    ).rejects.toThrow(/Could not find/);
  });

  it("rejects when file is missing", async () => {
    const fs = new StubFs();
    const tool = createEditTool(CWD, fs);
    await expect(
      tool.execute("call-1", { path: "missing.ts", oldText: "x", newText: "y" }),
    ).rejects.toThrow(/not found/i);
  });

  it("uses fuzzy match for smart quotes", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/a.ts`]: "say \u201chello\u201d world" },
    });
    const tool = createEditTool(CWD, fs);
    await tool.execute("call-1", {
      path: "a.ts",
      oldText: '"hello"',
      newText: '"goodbye"',
    });
    const stored = (await fs.readFile("/work/ctx/a.ts")).toString();
    expect(stored).toContain('"goodbye"');
  });
});
