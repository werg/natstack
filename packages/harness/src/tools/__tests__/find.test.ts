import { describe, it, expect } from "vitest";
import { createFindTool } from "../find.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createFindTool", () => {
  it("finds files matching a glob", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "x",
        [`${CWD}/b.md`]: "x",
        [`${CWD}/sub/c.ts`]: "x",
      },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "**/*.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).toContain("sub/c.ts");
    expect(text).not.toContain("b.md");
  });

  it("returns 'No files found' when nothing matches", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*.md" });
    expect((result.content[0] as { text: string }).text).toBe("No files found matching pattern");
  });

  it("includes hidden (dot) files", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/.hidden`]: "x", [`${CWD}/visible`]: "x" },
    });
    const tool = createFindTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "*" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(".hidden");
  });

  it("rejects when search path doesn't exist", async () => {
    const fs = new StubFs();
    const tool = createFindTool(CWD, fs);
    await expect(
      tool.execute("call-1", { pattern: "*", path: "missing" }),
    ).rejects.toThrow(/not found/i);
  });
});
