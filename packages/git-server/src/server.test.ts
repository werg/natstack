import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { execFileSync } from "child_process";
import { describe, expect, it } from "vitest";
import { GitServer } from "./server";

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "natstack-git-server-"));
}

function initRepoWithBranch(projectDir: string): void {
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-B", "main"], { cwd: projectDir, stdio: "ignore" });
  }
  execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@natstack.local"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "branch-e2e"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["checkout", "main"], { cwd: projectDir, stdio: "ignore" });
}

describe("GitServer", () => {
  it("initializes project repos on main", async () => {
    const root = await makeRoot();
    const projectDir = path.join(root, "projects", "default");
    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "Welcome.mdx"), "# Welcome\n");

      const server = new GitServer({
        reposPath: root,
        initPatterns: ["projects/*"],
      });

      await server.initializeRepos();

      const branch = execFileSync("git", ["-C", projectDir, "branch", "--show-current"], {
        encoding: "utf8",
      }).trim();
      const commit = execFileSync("git", ["-C", projectDir, "rev-parse", "--verify", "HEAD"], {
        encoding: "utf8",
      }).trim();

      expect(branch).toBe("main");
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves full non-current branch names when listing branches", async () => {
    const root = await makeRoot();
    const projectDir = path.join(root, "projects", "default");
    try {
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, "Welcome.mdx"), "# Welcome\n");
      initRepoWithBranch(projectDir);

      const server = new GitServer({
        reposPath: root,
        initPatterns: ["projects/*"],
      });
      await server.initializeRepos();

      await expect(server.listBranches("projects/default")).resolves.toEqual([
        { name: "branch-e2e", current: false },
        { name: "main", current: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
