import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getDeclaredRemoteForRepo,
  getDeclaredRemotesForRepo,
  removeDeclaredRemoteFromConfig,
  setDeclaredRemoteInConfig,
  syncDeclaredRemoteForRepo,
} from "./remotes.js";
import type { WorkspaceConfig } from "./types.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-remotes-"));
}

function initRepo(workspaceRoot: string, repoPath: string): void {
  const repoDir = path.join(workspaceRoot, repoPath);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
}

describe("workspace remotes", () => {
  it("stores remote names as keys under the section/repo declaration", () => {
    const config: WorkspaceConfig = { id: "test", git: {} };

    const withOrigin = setDeclaredRemoteInConfig(config, "panels/chat", {
      name: "origin",
      url: "https://github.com/acme/chat.git",
    });
    const next = setDeclaredRemoteInConfig(withOrigin, "panels/chat", {
      name: "ci",
      url: "https://github.com/acme/chat-ci.git",
    });

    expect(next.git?.remotes?.["panels"]?.["chat"]).toEqual({
      origin: "https://github.com/acme/chat.git",
      ci: "https://github.com/acme/chat-ci.git",
    });
    expect(getDeclaredRemoteForRepo(next, "panels/chat")).toMatchObject({
      repoPath: "panels/chat",
      section: "panels",
      repoKey: "chat",
      name: "origin",
    });
    expect(getDeclaredRemoteForRepo(next, "panels/chat", "ci")).toMatchObject({
      name: "ci",
      url: "https://github.com/acme/chat-ci.git",
    });
    expect(getDeclaredRemotesForRepo(next, "panels/chat").map((remote) => remote.name)).toEqual(["ci", "origin"]);
  });

  it("removes a named remote without removing the repo declaration", () => {
    const config = setDeclaredRemoteInConfig(
      setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/chat", {
        name: "origin",
        url: "https://github.com/acme/chat.git",
      }),
      "panels/chat",
      {
        name: "ci",
        url: "https://github.com/acme/chat-ci.git",
      },
    );

    const next = removeDeclaredRemoteFromConfig(config, "panels/chat", "ci");

    expect(next.git?.remotes?.["panels"]?.["chat"]).toEqual({
      origin: "https://github.com/acme/chat.git",
    });
  });

  it("rejects remote URLs with embedded credentials", () => {
    expect(() => setDeclaredRemoteInConfig({ id: "test" }, "panels/chat", {
      name: "origin",
      url: "https://token@github.com/acme/chat.git",
    })).toThrow("Remote URL must not contain embedded credentials");
  });

  it("materializes declared remotes into git config", async () => {
    const workspaceRoot = tempWorkspace();
    initRepo(workspaceRoot, "panels/chat");
    const config = setDeclaredRemoteInConfig(
      setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/chat", {
        name: "origin",
        url: "https://github.com/acme/chat.git",
      }),
      "panels/chat",
      {
        name: "ci",
        url: "https://github.com/acme/chat-ci.git",
      },
    );

    await syncDeclaredRemoteForRepo({ config, workspaceRoot, repoPath: "panels/chat" });

    const repoDir = path.join(workspaceRoot, "panels/chat");
    expect(execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim()).toBe("https://github.com/acme/chat.git");
    expect(execFileSync("git", ["remote", "get-url", "ci"], {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim()).toBe("https://github.com/acme/chat-ci.git");
    expect(execFileSync("git", ["config", "remote.origin.natstack-managed"], {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim()).toBe("true");
  });

  it("applies a predeclared remote when the repo appears later", async () => {
    const workspaceRoot = tempWorkspace();
    const config = setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/future", {
      name: "origin",
      url: "https://github.com/acme/future.git",
    });

    await expect(syncDeclaredRemoteForRepo({
      config,
      workspaceRoot,
      repoPath: "panels/future",
    })).resolves.toMatchObject({ applied: false });

    initRepo(workspaceRoot, "panels/future");
    await expect(syncDeclaredRemoteForRepo({
      config,
      workspaceRoot,
      repoPath: "panels/future",
    })).resolves.toMatchObject({ applied: true });

    expect(execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: path.join(workspaceRoot, "panels/future"),
      encoding: "utf-8",
    }).trim()).toBe("https://github.com/acme/future.git");
  });
});
