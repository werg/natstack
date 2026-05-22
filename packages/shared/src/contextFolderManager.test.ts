import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitClient } from "@natstack/git";
import { ContextFolderManager } from "./contextFolderManager.js";
import type { WorkspaceNode } from "./types.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "natstack-context-folder-"));
  tempRoots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initGitRepo(cwd: string): void {
  try {
    git(cwd, ["init", "-b", "main"]);
  } catch {
    git(cwd, ["init"]);
    git(cwd, ["checkout", "-B", "main"]);
  }
}

function makeNode(repoPath: string): WorkspaceNode {
  return {
    name: path.basename(repoPath),
    path: repoPath,
    type: "directory",
    isGitRepo: true,
    children: [],
  } as WorkspaceNode;
}

describe("ContextFolderManager", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("copies git object storage so panel-side GitClient can read context repo status", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);

    expect(lstatSync(path.join(contextRepoPath, ".git", "objects")).isSymbolicLink()).toBe(false);

    const client = new GitClient(fs, { token: "test" });
    await expect(client.status(contextRepoPath)).resolves.toMatchObject({
      branch: "main",
      dirty: false,
    });
  });

  it("copies branch refs so panel-side GitClient can checkout another branch", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["checkout", "-b", "branch-e2e"]);
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Branch\n");
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Branch commit"]);
    git(repoPath, ["checkout", "main"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);
    const client = new GitClient(fs, { token: "test" });

    await client.checkout(contextRepoPath, "branch-e2e");
    await expect(client.status(contextRepoPath)).resolves.toMatchObject({
      branch: "branch-e2e",
      dirty: false,
    });
  });
});
