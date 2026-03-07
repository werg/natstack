import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExistsSync, mockStatSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockStatSync: vi.fn((): { isDirectory: () => boolean } => ({ isDirectory: () => true })),
}));

const mockStartVitest = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    state: { getFiles: () => [] },
    close: vi.fn(),
  }),
);

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

vi.mock("vitest/node", () => ({
  startVitest: mockStartVitest,
}));

import { handleTestCall } from "../../../shared/services/testRunnerService";

describe("handleTestCall", () => {
  const mockContextFolderManager = {
    ensureContextFolder: vi.fn().mockResolvedValue("/workspace/.contexts/ctx_123"),
  };
  const options = {
    contextFolderManager: mockContextFolderManager as any,
    workspaceRoot: "/workspace",
    panelTestSetupPath: "/natstack/src/main/services/testSetup.ts",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockStartVitest.mockResolvedValue({
      state: { getFiles: () => [] },
      close: vi.fn(),
    });
  });

  it("throws on unknown method", async () => {
    await expect(
      handleTestCall(options, "unknown", ["ctx_123", "panels/my-app"]),
    ).rejects.toThrow("Unknown test method: unknown");
  });

  it("throws when target directory does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(
      handleTestCall(options, "run", ["ctx_123", "panels/nonexistent"]),
    ).rejects.toThrow("Target directory does not exist: panels/nonexistent");
  });

  it("throws when target is a file instead of directory", async () => {
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    await expect(
      handleTestCall(options, "run", ["ctx_123", "panels/my-app/index.ts"]),
    ).rejects.toThrow("Target must be a directory: panels/my-app/index.ts");
  });

  it("throws on directory traversal", async () => {
    await expect(
      handleTestCall(options, "run", ["ctx_123", "../../etc"]),
    ).rejects.toThrow("Path escapes context root");
  });

  it("returns 'no test files found' when vitest finds nothing", async () => {
    const result = await handleTestCall(options, "run", [
      "ctx_123",
      "panels/empty-app",
    ]);

    expect(result.summary).toContain("No test files found");
    expect(result.total).toBe(0);
  });

  it("injects panel setup file for panel targets", async () => {
    await handleTestCall(options, "run", ["ctx_123", "panels/my-app"]);

    expect(mockStartVitest).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        setupFiles: [options.panelTestSetupPath],
      }),
    );
  });

  it("throws when panel setup file does not exist", async () => {
    // First two existsSync calls: target dir check (true), then setup file check (false)
    mockExistsSync
      .mockReturnValueOnce(true)   // targetPath exists
      .mockReturnValueOnce(false); // panelTestSetupPath does not exist

    await expect(
      handleTestCall(options, "run", ["ctx_123", "panels/my-app"]),
    ).rejects.toThrow("Panel test setup file not found");
  });

  it("does not inject panel setup file for package targets", async () => {
    await handleTestCall(options, "run", ["ctx_123", "packages/my-lib"]);

    expect(mockStartVitest).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        setupFiles: [],
      }),
    );
  });

  it("passes test name filter to vitest", async () => {
    await handleTestCall(options, "run", [
      "ctx_123",
      "panels/my-app",
      undefined,
      "should render",
    ]);

    expect(mockStartVitest).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({
        testNamePattern: "should render",
      }),
    );
  });

  it("formats passing results correctly", async () => {
    mockStartVitest.mockResolvedValue({
      state: {
        getFiles: () => [
          {
            filepath: "/workspace/.contexts/ctx_123/panels/my-app/index.test.ts",
            result: { state: "pass", duration: 42 },
            tasks: [
              { name: "renders", result: { state: "pass" } },
              { name: "handles click", result: { state: "pass" } },
            ],
          },
        ],
      },
      close: vi.fn(),
    });

    const result = await handleTestCall(options, "run", [
      "ctx_123",
      "panels/my-app",
    ]);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(2);
    expect(result.summary).toBe("2 tests passed");
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.status).toBe("pass");
  });

  it("formats failing results with error messages", async () => {
    mockStartVitest.mockResolvedValue({
      state: {
        getFiles: () => [
          {
            filepath: "/workspace/.contexts/ctx_123/panels/my-app/index.test.ts",
            result: { state: "fail", duration: 100 },
            tasks: [
              { name: "renders", result: { state: "pass" } },
              {
                name: "handles click",
                result: {
                  state: "fail",
                  errors: [{ message: "Expected true to be false" }],
                },
              },
            ],
          },
        ],
      },
      close: vi.fn(),
    });

    const result = await handleTestCall(options, "run", [
      "ctx_123",
      "panels/my-app",
    ]);

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
    expect(result.summary).toBe("1 of 2 tests failed");
    expect(result.details[0]!.errors).toContain(
      "handles click: Expected true to be false",
    );
  });
});
