import { describe, it, expect } from "vitest";
import { createLsTool } from "../ls.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createLsTool", () => {
  it("lists files and directories alphabetically", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/b.ts`]: "x",
        [`${CWD}/a.ts`]: "x",
        [`${CWD}/sub/c.ts`]: "x",
      },
    });
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", {});
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("a.ts");
    expect(lines[1]).toBe("b.ts");
    expect(lines[2]).toBe("sub/");
  });

  it("returns '(empty directory)' for empty dir", async () => {
    const fs = new StubFs();
    await fs.mkdir("/work/ctx/empty", { recursive: true });
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "empty" });
    expect((result.content[0] as { text: string }).text).toBe("(empty directory)");
  });

  it("rejects when path doesn't exist", async () => {
    const fs = new StubFs();
    const tool = createLsTool(CWD, fs);
    await expect(tool.execute("call-1", { path: "nope" })).rejects.toThrow(/not found/i);
  });

  it("rejects when path is a file, not a directory", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createLsTool(CWD, fs);
    await expect(tool.execute("call-1", { path: "a.ts" })).rejects.toThrow(/Not a directory/);
  });
});
