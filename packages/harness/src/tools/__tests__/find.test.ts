import { describe, it, expect, vi } from "vitest";
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

  it("delegates to the file-tools extension when context rpc is available", async () => {
    const fs = new StubFs();
    const rpc = {
      call: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "src/a.ts" }],
        details: { engine: "ripgrep" },
      }),
      streamCall: vi.fn(async () => new Response()),
    };
    const tool = createFindTool(CWD, fs, { rpc });

    const result = await tool.execute("call-1", { pattern: "**/*.ts", path: ".", limit: 10 });

    expect((result.content[0] as { text: string }).text).toBe("src/a.ts");
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/file-tools",
      "find",
      [{ pattern: "**/*.ts", path: ".", cwd: CWD, limit: 10 }],
    ]);
  });
});
