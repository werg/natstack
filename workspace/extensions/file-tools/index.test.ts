import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { platform } from "node:process";
import { activate } from "./index.js";

const tempRoots: string[] = [];

interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: { engine?: string };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "natstack-file-tools-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("@workspace-extensions/file-tools", () => {
  it("searches a context workspace with glob and context lines", async () => {
    const workspaceRoot = await makeTempRoot();
    const contextsPath = path.join(workspaceRoot, ".contexts");
    const contextRoot = path.join(contextsPath, "ctx-test");
    await fs.mkdir(path.join(contextRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(contextRoot, "src", "entities.ts"),
      ["const before = true;", "export const entity = createEntity({ id: 'a' });", "const after = true;"].join("\n"),
    );
    await fs.writeFile(path.join(contextRoot, "src", "notes.md"), "createEntity should not match this file\n");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath }),
      },
      fs: { realpath: async () => contextRoot },
      log: { info: vi.fn() },
      health: { healthy: vi.fn(), degraded: vi.fn() },
    });

    const result = await api.grep({
      pattern: "createEntity",
      path: ".",
      glob: "**/*.ts",
      context: 1,
      limit: 100,
    }) as TextToolResult;

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("src/entities.ts-1- const before = true;");
    expect(text).toContain("src/entities.ts:2: export const entity = createEntity({ id: 'a' });");
    expect(text).toContain("src/entities.ts-3- const after = true;");
    expect(text).not.toContain("notes.md");
    expect(result.details?.engine).toBe("ripgrep");
  });

  it("reports no matches without details", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(path.join(workspaceRoot, "file.ts"), "export const value = 1;\n");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    const result = await api.grep({ pattern: "createEntity", path: ".", glob: "**/*.ts" }) as TextToolResult;

    expect(result.content).toEqual([{ type: "text", text: "No matches found" }]);
    expect(result.details).toBeUndefined();
  });

  it("defaults grep to literal matching for regex-looking snippets", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(path.join(workspaceRoot, "script.ts"), "eval({ path: 'tmp/demo.ts' });\n");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    const result = await api.grep({ pattern: "eval({ path", path: "." }) as TextToolResult;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("script.ts:1:");
  });

  it("explains that grep path is a single root when a space-separated path is missing", async () => {
    const workspaceRoot = await makeTempRoot();
    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    await expect(api.grep({
      pattern: "console",
      path: "packages workers panels",
      glob: "*diagnostic*",
    })).rejects.toThrow("not a space-separated list");
  });

  it("finds files with ripgrep file listing", async () => {
    const workspaceRoot = await makeTempRoot();
    const contextsPath = path.join(workspaceRoot, ".contexts");
    const contextRoot = path.join(contextsPath, "ctx-test");
    await fs.mkdir(path.join(contextRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(contextRoot, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(contextRoot, "src", "b.md"), "# b\n");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath }),
      },
      fs: { realpath: async () => contextRoot },
      log: { info: vi.fn() },
    });

    const result = await api.find({
      pattern: "**/*.ts",
      path: ".",
      limit: 100,
    }) as TextToolResult;

    expect(result.content[0]).toEqual({ type: "text", text: "src/a.ts" });
    expect(result.details?.engine).toBe("ripgrep");
  });

  it("streams text reads with offset and limit", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(workspaceRoot, "big.txt"),
      Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    const result = await api.read({ path: "big.txt", offset: 3, limit: 2 }) as TextToolResult;

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("line 3\nline 4");
    expect(text).toContain("Use offset=5");
    expect(text).not.toContain("line 5\n");
    expect(result.details?.engine).toBe("node-file");
  });

  it("returns empty content when reading an empty file without an offset", async () => {
    const workspaceRoot = await makeTempRoot();
    await fs.writeFile(path.join(workspaceRoot, "empty.txt"), "");

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    const result = await api.read({ path: "empty.txt" }) as TextToolResult;
    expect(result.content).toEqual([{ type: "text", text: "" }]);
    expect(result.details?.engine).toBe("node-file");
  });

  it("rejects symlinked roots that escape the scoped context", async () => {
    if (platform === "win32") return;
    const workspaceRoot = await makeTempRoot();
    const outsideRoot = await makeTempRoot();
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "outside\n");
    await fs.symlink(outsideRoot, path.join(workspaceRoot, "outside"));

    const api = await activate({
      workspace: {
        getInfo: async () => ({ path: workspaceRoot, contextsPath: path.join(workspaceRoot, ".contexts") }),
      },
      fs: { realpath: async () => workspaceRoot },
      log: { info: vi.fn() },
    });

    await expect(api.read({ path: "outside/secret.txt" })).rejects.toThrow(/escapes search root/i);
  });
});
