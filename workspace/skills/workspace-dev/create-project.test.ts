import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const vcsCommit = vi.fn();
  return { files, dirs, vcsCommit };
});

function normalize(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function addDir(p: string): void {
  const normalized = normalize(p);
  if (!normalized) return;
  const parts = normalized.split("/");
  for (let i = 1; i <= parts.length; i++) mocks.dirs.add(parts.slice(0, i).join("/"));
}

function addFile(p: string, content: string | Uint8Array): void {
  const normalized = normalize(p);
  const parent = normalized.split("/").slice(0, -1).join("/");
  addDir(parent);
  mocks.files.set(normalized, content);
}

vi.mock("@workspace/runtime", () => ({
  vcs: {
    commit: mocks.vcsCommit,
  },
  fs: {
    async exists(p: string): Promise<boolean> {
      const normalized = normalize(p);
      return mocks.files.has(normalized) || mocks.dirs.has(normalized);
    },
    async readdir(
      p: string,
      opts?: { withFileTypes?: boolean }
    ): Promise<string[] | Array<{ name: string; isDirectory(): boolean }>> {
      const normalized = normalize(p);
      const prefix = normalized ? `${normalized}/` : "";
      const names = new Map<string, boolean>();
      for (const file of mocks.files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0);
      }
      for (const dir of mocks.dirs) {
        if (!dir.startsWith(prefix) || dir === normalized) continue;
        const rest = dir.slice(prefix.length);
        const [name, ...tail] = rest.split("/");
        names.set(name!, tail.length > 0 || mocks.dirs.has(`${prefix}${name}`));
      }
      if (opts?.withFileTypes) {
        return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
      }
      return [...names.keys()];
    },
    async readFile(p: string, encoding?: string): Promise<string | Uint8Array> {
      const content = mocks.files.get(normalize(p));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (encoding && content instanceof Uint8Array) return new TextDecoder().decode(content);
      return content;
    },
    async mkdir(p: string): Promise<void> {
      addDir(p);
    },
    async writeFile(p: string, content: string | Uint8Array): Promise<void> {
      addFile(p, content);
    },
  },
}));

describe("forkProject", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.dirs.clear();
    mocks.vcsCommit.mockReset();
  });

  it("commitWorkspace commits through vcs", async () => {
    mocks.vcsCommit.mockResolvedValue({
      message: "Committed state:1234567… on main (3 paths)",
    });

    const { commitWorkspace } = await import("./create-project.js");
    const result = await commitWorkspace("panels/my-app", "Update");

    expect(mocks.vcsCommit).toHaveBeenCalledWith("panels/my-app", "Update");
    expect(result).toBe("Committed state:1234567… on main (3 paths)");
  });

  it("commitWorkspace reports an unchanged tree", async () => {
    mocks.vcsCommit.mockResolvedValue({
      message: "No changes; workspace state unchanged at state:1234567…",
    });

    const { commitWorkspace } = await import("./create-project.js");
    const result = await commitWorkspace("panels/my-app", "Update");

    expect(mocks.vcsCommit).toHaveBeenCalledWith("panels/my-app", "Update");
    expect(result).toBe("No changes; workspace state unchanged at state:1234567…");
  });

  it("commitWorkspace propagates commit failures", async () => {
    mocks.vcsCommit.mockRejectedValue(new Error("ref CAS conflict: worktree:vcs:workspace:main"));

    const { commitWorkspace } = await import("./create-project.js");

    await expect(commitWorkspace("panels/my-app", "Update")).rejects.toThrow(/ref CAS conflict/);
  });

  it("rewrites a single-class worker fork and preserves binary files", async () => {
    addDir("workers/source/.git");
    addFile(
      "workers/source/package.json",
      JSON.stringify({
        name: "@workspace-workers/source",
        natstack: {
          type: "worker",
          entry: "source-worker.ts",
          durable: { classes: [{ className: "SourceWorker" }] },
        },
      })
    );
    addFile(
      "workers/source/source-worker.ts",
      'export class SourceWorker { readonly source = "workers/source"; }\n'
    );
    addFile("workers/source/icon.png", new Uint8Array([1, 2, 3]));
    mocks.vcsCommit.mockResolvedValue({ message: "Committed" });

    const { forkProject } = await import("./create-project.js");
    const result = await forkProject({
      from: "workers/source",
      to: "workers/new",
      title: "New Worker",
    });

    expect(result.committed).toBe(true);
    expect(result.files).toContain("new-worker.ts");
    expect(mocks.vcsCommit).toHaveBeenCalledWith(
      "workers/new",
      expect.stringContaining("Fork workers/source to workers/new")
    );
    // The fork wrote its files through fs before committing.
    expect(JSON.parse(mocks.files.get("workers/new/package.json") as string)).toMatchObject({
      name: "@workspace-workers/new",
      natstack: {
        title: "New Worker",
        entry: "new-worker.ts",
        durable: { classes: [{ className: "NewWorker" }] },
      },
    });
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain("class NewWorker");
    expect(mocks.files.get("workers/new/new-worker.ts")).toContain("workers/new");
    expect(mocks.files.get("workers/new/icon.png")).toBeInstanceOf(Uint8Array);
  });
});
