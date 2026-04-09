import { describe, it, expect } from "vitest";
import { createGrepTool } from "../grep.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createGrepTool", () => {
  it("finds a literal pattern across multiple files", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "const foo = 1;\nconst bar = 2;",
        [`${CWD}/b.ts`]: "const baz = 3;\nfoo() // call",
      },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "foo", literal: true });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts:1");
    expect(text).toContain("b.ts:2");
  });

  it("regex search matches groups", async () => {
    const fs = new StubFs({
      files: { [`${CWD}/a.ts`]: "let x = 10;\nlet y = 20;\nconst z = 30;" },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "let \\w+ = \\d+" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts:1");
    expect(text).toContain("a.ts:2");
    expect(text).not.toContain("a.ts:3");
  });

  it("returns 'No matches found' when nothing matches", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "abc" } });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "xyz" });
    expect((result.content[0] as { text: string }).text).toBe("No matches found");
  });

  it("filters files by glob", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/a.ts`]: "match",
        [`${CWD}/b.md`]: "match",
      },
    });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "match", glob: "*.ts" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("a.ts");
    expect(text).not.toContain("b.md");
  });

  it("respects ignoreCase", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "Hello World" } });
    const tool = createGrepTool(CWD, fs);
    const result = await tool.execute("call-1", { pattern: "hello", ignoreCase: true });
    expect((result.content[0] as { text: string }).text).toContain("a.ts:1");
  });

  it("aborts when signal is already aborted", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createGrepTool(CWD, fs);
    const ac = new AbortController();
    ac.abort();
    await expect(
      tool.execute("call-1", { pattern: "x" }, ac.signal),
    ).rejects.toThrow(/abort/i);
  });
});
