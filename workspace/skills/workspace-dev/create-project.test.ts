import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  const applyEdits = vi.fn();
  return { files, dirs, applyEdits };
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
    applyEdits: mocks.applyEdits,
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
    mocks.applyEdits.mockReset();
    // Edit-first scaffold: `writeProjectFiles` applies one GAD transition of
    // create ops. The mock records each created file so fork assertions can
    // inspect the projected content.
    mocks.applyEdits.mockImplementation(
      async (input: {
        edits: Array<{
          kind: string;
          path: string;
          content?: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
        }>;
      }) => {
        for (const edit of input.edits) {
          if ((edit.kind === "create" || edit.kind === "write") && edit.content) {
            const value =
              edit.content.kind === "text"
                ? edit.content.text
                : Uint8Array.from(atob(edit.content.base64), (c) => c.charCodeAt(0));
            addFile(edit.path, value);
          }
        }
        return {
          status: "clean" as const,
          stateHash: "state:test",
          eventId: "e",
          headHash: "h",
          conflicts: [],
          changedPaths: input.edits.map((edit) => edit.path),
        };
      }
    );
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

    expect(result.committed).toBe(true);
    expect(result.files).toContain("new-worker.ts");
    // The fork wrote all files through a single GAD applyEdits transition.
    expect(mocks.applyEdits).toHaveBeenCalledTimes(1);
    // The fork wrote its files through one edit-first GAD transition.
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
