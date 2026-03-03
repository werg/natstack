import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process — use vi.hoisted for proper hoisting
const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn().mockResolvedValue({ stdout: "" }),
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

// Mock fs
const { mockExistsSync, mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

// Mock tokenManager
vi.mock("../../tokenManager.js", () => ({
  getTokenManager: () => ({
    ensureToken: vi.fn().mockReturnValue("test-token"),
  }),
}));

import { handleProjectCall } from "../projectService";

describe("handleProjectCall", () => {
  const mockContextFolderManager = {
    ensureContextFolder: vi.fn().mockResolvedValue("/workspace/.contexts/ctx_123"),
  };
  const mockGitServer = {
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:9418"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFile.mockResolvedValue({ stdout: "" });
  });

  it("creates a panel project", async () => {
    const result = await handleProjectCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      "create",
      ["ctx_123", "panel", "my-app", "My App"],
    );

    expect(result).toEqual({
      created: "panels/my-app",
      type: "panel",
      name: "my-app",
      title: "My App",
      files: ["package.json", "index.tsx"],
    });

    // Should create directory
    expect(mockMkdirSync).toHaveBeenCalledWith(
      "/workspace/.contexts/ctx_123/panels/my-app",
      { recursive: true },
    );

    // Should write package.json with correct scope
    const pkgCall = mockWriteFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith("package.json"),
    );
    expect(pkgCall).toBeTruthy();
    const pkg = JSON.parse(pkgCall![1] as string);
    expect(pkg.name).toBe("@workspace-panels/my-app");
    expect(pkg.natstack.type).toBe("app");
    expect(pkg.natstack.title).toBe("My App");
  });

  it("creates a package project", async () => {
    const result = await handleProjectCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      "create",
      ["ctx_123", "package", "utils", undefined],
    ) as any;

    expect(result.created).toBe("packages/utils");
    expect(result.files).toContain("index.ts");

    const pkgCall = mockWriteFileSync.mock.calls.find((c: unknown[]) =>
      (c[0] as string).endsWith("package.json"),
    );
    const pkg = JSON.parse(pkgCall![1] as string);
    expect(pkg.name).toBe("@workspace/utils");
    expect(pkg.exports).toEqual({ ".": "./index.ts" });
  });

  it("creates a skill project", async () => {
    const result = await handleProjectCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      "create",
      ["ctx_123", "skill", "my-skill", "My Skill"],
    ) as any;

    expect(result.created).toBe("skills/my-skill");
    expect(result.files).toContain("SKILL.md");
  });

  it("creates an agent project", async () => {
    const result = await handleProjectCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      "create",
      ["ctx_123", "agent", "my-agent", "My Agent"],
    ) as any;

    expect(result.created).toBe("agents/my-agent");
    expect(result.files).toContain("index.ts");
  });

  it("rejects names with path separators", async () => {
    await expect(
      handleProjectCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        "create",
        ["ctx_123", "panel", "a/b", "Bad"],
      ),
    ).rejects.toThrow("path separators");
  });

  it("rejects names with '..'", async () => {
    await expect(
      handleProjectCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        "create",
        ["ctx_123", "panel", "foo..bar", "Bad"],
      ),
    ).rejects.toThrow("must not contain '..'");
  });

  it("rejects unknown project types", async () => {
    await expect(
      handleProjectCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        "create",
        ["ctx_123", "widget", "test", "Test"],
      ),
    ).rejects.toThrow("Unknown project type: widget");
  });

  it("rejects if project already exists", async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(
      handleProjectCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        "create",
        ["ctx_123", "panel", "my-app", "My App"],
      ),
    ).rejects.toThrow("Project already exists");
  });

  it("uses name as title when title is not provided", async () => {
    const result = await handleProjectCall(
      mockContextFolderManager as any,
      mockGitServer as any,
      "create",
      ["ctx_123", "panel", "my-app", undefined],
    ) as any;

    expect(result.title).toBe("my-app");
  });

  it("throws on unknown method", async () => {
    await expect(
      handleProjectCall(
        mockContextFolderManager as any,
        mockGitServer as any,
        "delete",
        [],
      ),
    ).rejects.toThrow("Unknown project method: delete");
  });
});
