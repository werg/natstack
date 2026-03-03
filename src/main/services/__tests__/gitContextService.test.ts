import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted for proper mock variable hoisting
const { mockExecFile, mockExistsSync, mockStatSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn().mockResolvedValue({ stdout: "" }),
  mockExistsSync: vi.fn(() => false),
  mockStatSync: vi.fn(() => ({ isFile: () => false })),
}));

vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock("util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("util")>();
  return {
    ...actual,
    promisify: () => mockExecFile,
  };
});
vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

import { handleGitContextCall } from "../gitContextService";

describe("handleGitContextCall", () => {
  const mockContextFolderManager = {
    ensureContextFolder: vi.fn().mockResolvedValue("/workspace/.contexts/ctx_123"),
  };
  const mockGitServer = {
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:9418"),
  };
  const mockTokenManager = {
    ensureToken: vi.fn().mockReturnValue("test-token-123"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ isFile: () => false });
    mockExecFile.mockResolvedValue({ stdout: "" });
  });

  it("initializes git on first operation", async () => {
    // existsSync is called for: target dir check (true), then .git check (false)
    mockExistsSync
      .mockReturnValueOnce(true)  // target dir exists
      .mockReturnValueOnce(false); // .git does not exist

    await handleGitContextCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      mockTokenManager as any,
      "contextOp",
      ["ctx_123", "status", undefined, undefined, undefined],
    );

    // Should have called git init
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "main"],
      expect.any(Object),
    );
  });

  it("throws on directory traversal", async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(
      handleGitContextCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        mockTokenManager as any,
        "contextOp",
        ["ctx_123", "status", "../../etc", undefined, undefined],
      ),
    ).rejects.toThrow("Path escapes context root");
  });

  it("throws on unknown operation", async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(
      handleGitContextCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        mockTokenManager as any,
        "contextOp",
        ["ctx_123", "unknown_op", undefined, undefined, undefined],
      ),
    ).rejects.toThrow("Unknown git operation: unknown_op");
  });

  it("requires message for commit operation", async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(
      handleGitContextCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        mockTokenManager as any,
        "contextOp",
        ["ctx_123", "commit", undefined, undefined, undefined],
      ),
    ).rejects.toThrow("Commit message is required");
  });

  it("resolves context folder for operations", async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFile.mockResolvedValue({ stdout: "M index.tsx" });

    await handleGitContextCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      mockTokenManager as any,
      "contextOp",
      ["ctx_123", "status", "panels/my-app", undefined, undefined],
    );

    expect(mockContextFolderManager.ensureContextFolder).toHaveBeenCalledWith("ctx_123");
  });
});
