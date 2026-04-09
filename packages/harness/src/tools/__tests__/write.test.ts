import { describe, it, expect } from "vitest";
import { createWriteTool } from "../write.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createWriteTool", () => {
  it("writes a new file", async () => {
    const fs = new StubFs();
    const tool = createWriteTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "out.txt", content: "hello" });
    expect(result.details.bytesWritten).toBe(5);
    const stored = (await fs.readFile("/work/ctx/out.txt")).toString();
    expect(stored).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const fs = new StubFs({ files: { [`${CWD}/out.txt`]: "old" } });
    const tool = createWriteTool(CWD, fs);
    await tool.execute("call-1", { path: "out.txt", content: "new" });
    const stored = (await fs.readFile("/work/ctx/out.txt")).toString();
    expect(stored).toBe("new");
  });

  it("creates parent directories", async () => {
    const fs = new StubFs();
    const tool = createWriteTool(CWD, fs);
    await tool.execute("call-1", { path: "deep/sub/file.txt", content: "ok" });
    expect(fs.dirs.has("/work/ctx/deep/sub")).toBe(true);
  });
});
