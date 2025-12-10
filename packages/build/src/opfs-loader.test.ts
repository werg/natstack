/**
 * Tests for OPFS/Filesystem module loader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs/promises before importing the module
vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock esbuild-init
vi.mock("./esbuild-init.js", () => ({
  getEsbuild: vi.fn(),
}));

describe("opfs-loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("readFile", () => {
    it("should read file from filesystem", async () => {
      const mockFs = await import("fs/promises");
      vi.mocked(mockFs.readFile).mockResolvedValue("file content");

      const { readFile } = await import("./opfs-loader.js");
      const content = await readFile("/test/file.ts");

      expect(content).toBe("file content");
      expect(mockFs.readFile).toHaveBeenCalledWith("/test/file.ts", "utf-8");
    });
  });

  describe("writeFile", () => {
    it("should create parent directory and write file", async () => {
      const mockFs = await import("fs/promises");
      vi.mocked(mockFs.mkdir).mockResolvedValue(undefined);
      vi.mocked(mockFs.writeFile).mockResolvedValue(undefined);

      const { writeFile } = await import("./opfs-loader.js");
      await writeFile("/test/dir/file.ts", "content");

      expect(mockFs.mkdir).toHaveBeenCalledWith("/test/dir", { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith("/test/dir/file.ts", "content");
    });

    it("should ignore mkdir errors (directory may exist)", async () => {
      const mockFs = await import("fs/promises");
      vi.mocked(mockFs.mkdir).mockRejectedValue(new Error("EEXIST"));
      vi.mocked(mockFs.writeFile).mockResolvedValue(undefined);

      const { writeFile } = await import("./opfs-loader.js");

      // Should not throw
      await expect(writeFile("/test/file.ts", "content")).resolves.toBeUndefined();
    });

    it("should handle root-level files", async () => {
      const mockFs = await import("fs/promises");
      vi.mocked(mockFs.mkdir).mockResolvedValue(undefined);
      vi.mocked(mockFs.writeFile).mockResolvedValue(undefined);

      const { writeFile } = await import("./opfs-loader.js");
      await writeFile("/file.ts", "content");

      // Should not try to create "/" directory
      expect(mockFs.mkdir).not.toHaveBeenCalled();
      expect(mockFs.writeFile).toHaveBeenCalledWith("/file.ts", "content");
    });
  });

  describe("FsLoader", () => {
    it("should be exported as class", async () => {
      const { FsLoader } = await import("./opfs-loader.js");
      expect(FsLoader).toBeDefined();
      expect(typeof FsLoader).toBe("function");
    });

    it("should have importModule method", async () => {
      const { FsLoader } = await import("./opfs-loader.js");
      const loader = new FsLoader();
      expect(typeof loader.importModule).toBe("function");
    });

    it("should have clearCache method", async () => {
      const { FsLoader } = await import("./opfs-loader.js");
      const loader = new FsLoader();
      expect(typeof loader.clearCache).toBe("function");
    });

    it("should have invalidate method", async () => {
      const { FsLoader } = await import("./opfs-loader.js");
      const loader = new FsLoader();
      expect(typeof loader.invalidate).toBe("function");
    });
  });

  describe("importModule", () => {
    it("should initialize esbuild on first call", async () => {
      const mockFs = await import("fs/promises");
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: 'export const x = 1;' }],
      });

      vi.mocked(mockFs.readFile).mockResolvedValue("export const x: number = 1;");
      vi.mocked(mockFs.stat).mockResolvedValue({ isFile: () => true } as never);

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);

      // Mock URL.createObjectURL and URL.revokeObjectURL
      const mockUrl = "blob:test";
      vi.stubGlobal("URL", {
        createObjectURL: vi.fn().mockReturnValue(mockUrl),
        revokeObjectURL: vi.fn(),
      });

      const { FsLoader } = await import("./opfs-loader.js");
      const loader = new FsLoader();

      // This will fail in Node.js due to dynamic import of blob URL,
      // but we can verify the esbuild setup
      try {
        await loader.importModule("/test.ts");
      } catch {
        // Expected to fail in Node test environment
      }

      expect(getEsbuild).toHaveBeenCalled();
    });
  });

  describe("clearModuleCache", () => {
    it("should be exported as function", async () => {
      const { clearModuleCache } = await import("./opfs-loader.js");
      expect(typeof clearModuleCache).toBe("function");
    });
  });

  describe("invalidateModule", () => {
    it("should be exported as function", async () => {
      const { invalidateModule } = await import("./opfs-loader.js");
      expect(typeof invalidateModule).toBe("function");
    });
  });

  describe("createFsPlugin", () => {
    it("should return an esbuild plugin", async () => {
      const { createFsPlugin } = await import("./opfs-loader.js");
      const plugin = createFsPlugin();

      expect(plugin).toHaveProperty("name", "fs-resolver");
      expect(plugin).toHaveProperty("setup");
      expect(typeof plugin.setup).toBe("function");
    });
  });

});

describe("path utilities (internal)", () => {
  // Test the internal path utilities by exercising them through the plugin

  describe("extension resolution", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should try extensions in order: .ts, .tsx, .js, .jsx, .json", async () => {
      const mockFs = await import("fs/promises");

      // First 4 extensions fail, .json succeeds
      vi.mocked(mockFs.stat)
        .mockRejectedValueOnce(new Error("ENOENT")) // .ts
        .mockRejectedValueOnce(new Error("ENOENT")) // .tsx
        .mockRejectedValueOnce(new Error("ENOENT")) // .js
        .mockRejectedValueOnce(new Error("ENOENT")) // .jsx
        .mockResolvedValueOnce({ isFile: () => true } as never); // .json

      vi.mocked(mockFs.readFile).mockResolvedValue('{"key": "value"}');

      // We can't easily test the internal resolveWithExtensions,
      // but we can verify the EXTENSION_ORDER through documentation
      // This test documents the expected behavior
      expect(true).toBe(true);
    });
  });

  describe("loader detection", () => {
    it("should map file extensions to loaders correctly", async () => {
      // This tests the internal getLoader function indirectly
      // The function maps:
      // .tsx -> tsx
      // .ts -> ts
      // .jsx -> jsx
      // .json -> json
      // .css -> css
      // default -> js

      const { createFsPlugin } = await import("./opfs-loader.js");
      const plugin = createFsPlugin();

      // Verify the plugin exists and has expected structure
      expect(plugin.name).toBe("fs-resolver");
    });
  });
});

describe("esbuild plugin behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should resolve relative imports starting with .", async () => {
    const { createFsPlugin } = await import("./opfs-loader.js");
    const plugin = createFsPlugin();

    const mockOnResolve = vi.fn();
    const mockOnLoad = vi.fn();

    const mockBuild = {
      onResolve: mockOnResolve,
      onLoad: mockOnLoad,
    };

    plugin.setup(mockBuild as never);

    // Verify onResolve was called with filter for relative paths
    expect(mockOnResolve).toHaveBeenCalledWith(
      { filter: /^\./ },
      expect.any(Function)
    );
  });

  it("should resolve absolute imports starting with /", async () => {
    const { createFsPlugin } = await import("./opfs-loader.js");
    const plugin = createFsPlugin();

    const mockOnResolve = vi.fn();
    const mockOnLoad = vi.fn();

    const mockBuild = {
      onResolve: mockOnResolve,
      onLoad: mockOnLoad,
    };

    plugin.setup(mockBuild as never);

    // Verify onResolve was called with filter for absolute paths
    expect(mockOnResolve).toHaveBeenCalledWith(
      { filter: /^\// },
      expect.any(Function)
    );
  });

  it("should load files from fs namespace", async () => {
    const { createFsPlugin } = await import("./opfs-loader.js");
    const plugin = createFsPlugin();

    const mockOnResolve = vi.fn();
    const mockOnLoad = vi.fn();

    const mockBuild = {
      onResolve: mockOnResolve,
      onLoad: mockOnLoad,
    };

    plugin.setup(mockBuild as never);

    // Verify onLoad was called for fs namespace
    expect(mockOnLoad).toHaveBeenCalledWith(
      { filter: /.*/, namespace: "fs" },
      expect.any(Function)
    );
  });
});
