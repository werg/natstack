/**
 * Tests for git service handler.
 */

const { mockGitClient, mockFs } = vi.hoisted(() => {
  const mockGitClient = {
    init: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockResolvedValue({ staged: [], unstaged: [] }),
    add: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue("abc123"),
    isRepo: vi.fn().mockResolvedValue(true),
    addAll: vi.fn().mockResolvedValue(undefined),
  };

  const mockFs = {
    readFile: vi.fn().mockResolvedValue("file-contents"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue(["a.txt"]),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
    }),
  };

  return { mockGitClient, mockFs };
});

vi.mock("@natstack/git", () => ({
  GitClient: vi.fn().mockImplementation(() => mockGitClient),
}));

vi.mock("fs/promises", () => ({
  default: mockFs,
  ...mockFs,
}));

import { handleGitServiceCall } from "./gitServiceHandler.js";

describe("handleGitServiceCall", () => {
  const ctx = { callerId: "panel-1", callerKind: "panel" as const };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("init calls client.init(dir, defaultBranch)", async () => {
    await handleGitServiceCall(ctx as any, "init", ["/tmp/repo", "main"]);
    expect(mockGitClient.init).toHaveBeenCalledWith("/tmp/repo", "main");
  });

  it("init defaults branch to 'main' when not provided", async () => {
    await handleGitServiceCall(ctx as any, "init", ["/tmp/repo"]);
    expect(mockGitClient.init).toHaveBeenCalledWith("/tmp/repo", "main");
  });

  it("status calls client.status(dir)", async () => {
    const result = await handleGitServiceCall(ctx as any, "status", [
      "/tmp/repo",
    ]);
    expect(mockGitClient.status).toHaveBeenCalledWith("/tmp/repo");
    expect(result).toEqual({ staged: [], unstaged: [] });
  });

  it("add calls client.add(dir, filepath)", async () => {
    await handleGitServiceCall(ctx as any, "add", ["/tmp/repo", "file.txt"]);
    expect(mockGitClient.add).toHaveBeenCalledWith("/tmp/repo", "file.txt");
  });

  it("commit calls client.commit(options)", async () => {
    const options = { dir: "/tmp/repo", message: "initial commit" };
    const result = await handleGitServiceCall(ctx as any, "commit", [options]);
    expect(mockGitClient.commit).toHaveBeenCalledWith(options);
    expect(result).toBe("abc123");
  });

  it("fs.readFile with encoding calls fs.readFile with encoding", async () => {
    const result = await handleGitServiceCall(ctx as any, "fs.readFile", [
      "/tmp/safe",
      "/tmp/safe/readme.md",
      "utf-8",
    ]);
    expect(mockFs.readFile).toHaveBeenCalledWith("/tmp/safe/readme.md", {
      encoding: "utf-8",
    });
    expect(result).toBe("file-contents");
  });

  it("fs.readFile rejects path traversal (path outside scope)", async () => {
    await expect(
      handleGitServiceCall(ctx as any, "fs.readFile", [
        "/tmp/safe",
        "/etc/passwd",
        "utf-8",
      ]),
    ).rejects.toThrow('Path "/etc/passwd" is outside allowed scope "/tmp/safe"');
  });

  it("throws on unknown method", async () => {
    await expect(
      handleGitServiceCall(ctx as any, "unknownMethod", []),
    ).rejects.toThrow("Unknown git service method: unknownMethod");
  });
});
