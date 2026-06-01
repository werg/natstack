import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const initAndPush = vi.fn();
  const gitClient = {
    listRemotes: vi.fn(),
    addRemote: vi.fn(),
    addAll: vi.fn(),
    status: vi.fn(),
    getCurrentBranch: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
  };
  return { files, dirs, initAndPush, gitClient };
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
  gitConfig: { serverUrl: "http://git.local", token: "token" },
  git: { client: vi.fn(() => mocks.gitClient), syncRepoToContexts: vi.fn() },
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

vi.mock("@natstack/git", () => ({
  GitClient: class GitClient {},
  initAndPush: mocks.initAndPush,
}));

describe("forkProject", () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.dirs.clear();
    mocks.initAndPush.mockReset();
    for (const fn of Object.values(mocks.gitClient)) fn.mockReset();
  });

  it("commitAndPush supports force push", async () => {
    mocks.gitClient.listRemotes.mockResolvedValue([{ remote: "origin", url: "panels/my-app" }]);
    mocks.gitClient.status.mockResolvedValue({
      branch: "main",
      commit: "abc",
      dirty: true,
      files: [{ path: "index.tsx", status: "modified", staged: true, unstaged: false }],
    });
    mocks.gitClient.getCurrentBranch.mockResolvedValue("main");
    mocks.gitClient.commit.mockResolvedValue("1234567890abcdef");

    const { commitAndPush } = await import("./create-project.js");
    const result = await commitAndPush("panels/my-app", "Update", { force: true });

    expect(mocks.gitClient.push).toHaveBeenCalledWith({
      dir: "panels/my-app",
      ref: "main",
      force: true,
    });
    expect(result).toBe("Committed 1234567 and pushed to origin/main");
  });

  it("commitAndPush pushes an existing clean commit on retry", async () => {
    mocks.gitClient.listRemotes.mockResolvedValue([{ remote: "origin", url: "panels/my-app" }]);
    mocks.gitClient.status.mockResolvedValue({
      branch: "main",
      commit: "abc",
      dirty: false,
      files: [],
    });
    mocks.gitClient.getCurrentBranch.mockResolvedValue("main");

    const { commitAndPush } = await import("./create-project.js");
    const result = await commitAndPush("panels/my-app", "Update");

    expect(mocks.gitClient.commit).not.toHaveBeenCalled();
    expect(mocks.gitClient.push).toHaveBeenCalledWith({
      dir: "panels/my-app",
      ref: "main",
      force: false,
    });
    expect(result).toBe("No working-tree changes; pushed current HEAD to origin/main");
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

    const { forkProject } = await import("./create-project.js");
    const result = await forkProject({
      from: "workers/source",
      to: "workers/new",
      title: "New Worker",
    });

    expect(result.pushed).toBe(true);
    expect(result.files).toContain("new-worker.ts");
    const options = mocks.initAndPush.mock.calls[0]![2];
    const initialFiles = options.initialFiles as Record<string, string | Uint8Array>;
    expect(JSON.parse(initialFiles["package.json"] as string)).toMatchObject({
      name: "@workspace-workers/new",
      natstack: {
        title: "New Worker",
        entry: "new-worker.ts",
        durable: { classes: [{ className: "NewWorker" }] },
      },
    });
    expect(initialFiles["new-worker.ts"]).toContain("class NewWorker");
    expect(initialFiles["new-worker.ts"]).toContain("workers/new");
    expect(initialFiles["icon.png"]).toBeInstanceOf(Uint8Array);
  });
});
