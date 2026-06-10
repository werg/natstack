import { describe, expect, it, vi } from "vitest";
import { publishWorkspaceRepo } from "./workspaceGitPublish.js";

function createGitClientMock() {
  return {
    addAll: vi.fn(async () => undefined),
    addRemote: vi.fn(async () => undefined),
    commit: vi.fn(async () => "1234567890abcdef"),
    getCurrentBranch: vi.fn(async () => "main"),
    getCurrentCommit: vi.fn(async () => "abc123"),
    listRemotes: vi.fn(async () => [] as Array<{ remote: string; url: string }>),
    push: vi.fn(async () => undefined),
    status: vi.fn(async () => ({
      branch: "main",
      commit: "abc123",
      dirty: false,
      files: [] as Array<{
        path: string;
        status: "unmodified" | "modified" | "added" | "deleted" | "untracked" | "ignored";
        staged: boolean;
        unstaged: boolean;
      }>,
    })),
  };
}

describe("publishWorkspaceRepo", () => {
  it("stages, commits, and pushes through the reserved internal remote", async () => {
    const git = createGitClientMock();
    git.status.mockResolvedValue({
      branch: "main",
      commit: "abc123",
      dirty: true,
      files: [{ path: "index.ts", status: "modified", staged: true, unstaged: false }],
    });

    const result = await publishWorkspaceRepo(git, "panels/app", "Update", { force: true });

    expect(git.addRemote).toHaveBeenCalledWith("panels/app", "__natstack", "panels/app");
    expect(git.addAll).toHaveBeenCalledWith("panels/app");
    expect(git.commit).toHaveBeenCalledWith({ dir: "panels/app", message: "Update" });
    expect(git.push).toHaveBeenCalledWith({
      dir: "panels/app",
      remote: "__natstack",
      ref: "main",
      force: true,
    });
    expect(result).toMatchObject({
      repoPath: "panels/app",
      branch: "main",
      commit: "1234567890abcdef",
      changed: true,
      pushed: true,
      buildEventsQuery: {
        service: "build.listRecentBuildEvents",
        args: ["panels/app"],
      },
    });
  });

  it("pushes the current HEAD without creating an empty commit when clean", async () => {
    const git = createGitClientMock();

    const result = await publishWorkspaceRepo(git, "packages/tool", "No-op");

    expect(git.commit).not.toHaveBeenCalled();
    expect(git.push).toHaveBeenCalledWith({
      dir: "packages/tool",
      remote: "__natstack",
      ref: "main",
      force: false,
    });
    expect(result.changed).toBe(false);
    expect(result.commit).toBe("abc123");
  });

  it("normalizes the suggested build events query without changing git dir operations", async () => {
    const git = createGitClientMock();

    const result = await publishWorkspaceRepo(git, "./panels/app", "No-op");

    expect(git.addAll).toHaveBeenCalledWith("./panels/app");
    expect(git.push).toHaveBeenCalledWith(expect.objectContaining({ dir: "./panels/app" }));
    expect(result.buildEventsQuery.args).toEqual(["panels/app"]);
  });

  it("does not use or overwrite an existing origin remote", async () => {
    const git = createGitClientMock();
    git.listRemotes.mockResolvedValue([{ remote: "origin", url: "https://github.com/acme/app" }]);

    await publishWorkspaceRepo(git, "panels/app", "Update");

    expect(git.addRemote).toHaveBeenCalledWith("panels/app", "__natstack", "panels/app");
    expect(git.push).toHaveBeenCalledWith(expect.objectContaining({ remote: "__natstack" }));
  });

  it("reports that the workspace source ref was not updated when push fails", async () => {
    const git = createGitClientMock();
    git.status.mockResolvedValue({
      branch: "main",
      commit: "abc123",
      dirty: true,
      files: [{ path: "index.ts", status: "modified", staged: true, unstaged: false }],
    });
    git.push.mockRejectedValue(new Error("Forbidden"));

    await expect(publishWorkspaceRepo(git, "panels/app", "Update")).rejects.toThrow(
      /Workspace publish failed[\s\S]*Local commit 1234567890abcdef exists[\s\S]*source ref was not updated[\s\S]*Forbidden/
    );
  });
});

describe("publishWorkspaceRepo path validation", () => {
  it("rejects '/' and scope-only paths with actionable guidance", async () => {
    const git = createGitClientMock();
    await expect(publishWorkspaceRepo(git, "/", "msg")).rejects.toThrow(
      /not a workspace repo path.*workers\/my-agent/s
    );
    await expect(publishWorkspaceRepo(git, "panels", "msg")).rejects.toThrow(
      /not a workspace repo path/
    );
    await expect(publishWorkspaceRepo(git, "../escape/repo", "msg")).rejects.toThrow(
      /escapes the workspace/
    );
  });
});
