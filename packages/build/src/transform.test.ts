/**
 * Tests for code transformation utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transform, getLoaderForLanguage, TransformAbortError } from "./transform.js";
import type { Loader } from "./transform.js";

// Mock getEsbuild to avoid actual esbuild initialization in tests
vi.mock("./esbuild-init.js", () => ({
  getEsbuild: vi.fn(),
}));

describe("transform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("early returns", () => {
    it("should return code as-is for plain JS without sourcemaps", async () => {
      const code = 'console.log("hello");';
      const result = await transform(code, {
        loader: "js",
        sourceMaps: false,
      });

      expect(result.code).toBe(code);
      expect(result.sourceMap).toBeUndefined();
    });

    it("should throw TransformAbortError when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        transform("const x = 1;", {
          loader: "ts",
          signal: controller.signal,
        })
      ).rejects.toThrow(TransformAbortError);
    });
  });

  describe("with mocked esbuild", () => {
    it("should call esbuild.transform with correct options", async () => {
      const mockTransform = vi.fn().mockResolvedValue({
        code: 'const x = 1;\n',
        map: "",
        warnings: [],
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await transform("const x: number = 1;", {
        loader: "ts",
        sourceMaps: false,
      });

      // Default jsx mode is 'automatic' which uses react/jsx-runtime
      expect(mockTransform).toHaveBeenCalledWith("const x: number = 1;", {
        loader: "ts",
        target: "es2022",
        format: "esm",
        sourcemap: false,
        sourcefile: "input.ts",
        jsx: "automatic",
        minify: false,
        keepNames: true,
      });
    });

    it("should use custom JSX factory and fragment when jsx='transform'", async () => {
      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = h();",
        map: "",
        warnings: [],
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await transform("<div />", {
        loader: "tsx",
        jsx: "transform",
        jsxFactory: "h",
        jsxFragment: "Fragment",
        sourceMaps: false,
      });

      expect(mockTransform).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          jsx: "transform",
          jsxFactory: "h",
          jsxFragment: "Fragment",
        })
      );
    });

    it("should use custom sourcefile name", async () => {
      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
        map: "",
        warnings: [],
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await transform("const x = 1;", {
        loader: "ts",
        sourcefile: "myfile",
        sourceMaps: false,
      });

      expect(mockTransform).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          sourcefile: "myfile.ts",
        })
      );
    });

    it("should extract inline source map when sourceMaps is true", async () => {
      const base64Map = Buffer.from('{"version":3}').toString("base64");
      const codeWithMap = `const x = 1;\n//# sourceMappingURL=data:application/json;base64,${base64Map}`;

      const mockTransform = vi.fn().mockResolvedValue({
        code: codeWithMap,
        map: "",
        warnings: [],
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      const result = await transform("const x: number = 1;", {
        loader: "ts",
        sourceMaps: true,
      });

      expect(result.sourceMap).toBe(base64Map);
    });

    it("should not have sourceMap when no inline map in output", async () => {
      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
        map: "",
        warnings: [],
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      const result = await transform("const x: number = 1;", {
        loader: "ts",
        sourceMaps: true,
      });

      expect(result.sourceMap).toBeUndefined();
    });

    it("should throw TransformAbortError when aborted after esbuild init", async () => {
      const controller = new AbortController();

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockImplementation(async () => {
        controller.abort();
        return { transform: vi.fn() } as never;
      });

      await expect(
        transform("const x = 1;", {
          loader: "ts",
          signal: controller.signal,
        })
      ).rejects.toThrow(TransformAbortError);
    });

    it("should throw TransformAbortError when aborted after transform", async () => {
      const controller = new AbortController();

      const mockTransform = vi.fn().mockImplementation(async () => {
        controller.abort();
        return { code: "const x = 1;", map: "", warnings: [] };
      });

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await expect(
        transform("const x = 1;", {
          loader: "ts",
          signal: controller.signal,
        })
      ).rejects.toThrow(TransformAbortError);
    });

    it("should wrap non-TransformAbortError errors", async () => {
      const mockTransform = vi.fn().mockRejectedValue(new Error("Parse error"));

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await expect(
        transform("invalid syntax {{{", {
          loader: "ts",
        })
      ).rejects.toThrow("Transform failed: Parse error");
    });

    it("should re-throw TransformAbortError unchanged", async () => {
      const mockTransform = vi.fn().mockRejectedValue(new TransformAbortError("custom"));

      const { getEsbuild } = await import("./esbuild-init.js");
      vi.mocked(getEsbuild).mockResolvedValue({
        transform: mockTransform,
      } as never);

      await expect(
        transform("const x = 1;", {
          loader: "ts",
        })
      ).rejects.toThrow(TransformAbortError);
    });
  });
});

describe("getLoaderForLanguage", () => {
  it("should return 'ts' for typescript without jsx", () => {
    expect(getLoaderForLanguage("typescript")).toBe("ts");
    expect(getLoaderForLanguage("typescript", false)).toBe("ts");
  });

  it("should return 'tsx' for typescript with jsx", () => {
    expect(getLoaderForLanguage("typescript", true)).toBe("tsx");
  });

  it("should return 'js' for javascript without jsx", () => {
    expect(getLoaderForLanguage("javascript")).toBe("js");
    expect(getLoaderForLanguage("javascript", false)).toBe("js");
  });

  it("should return 'jsx' for javascript with jsx", () => {
    expect(getLoaderForLanguage("javascript", true)).toBe("jsx");
  });
});

describe("TransformAbortError", () => {
  it("should have correct name", () => {
    const error = new TransformAbortError();
    expect(error.name).toBe("TransformAbortError");
  });

  it("should have default message", () => {
    const error = new TransformAbortError();
    expect(error.message).toBe("Transformation aborted");
  });

  it("should accept custom message", () => {
    const error = new TransformAbortError("Custom abort message");
    expect(error.message).toBe("Custom abort message");
  });

  it("should be instanceof Error", () => {
    const error = new TransformAbortError();
    expect(error).toBeInstanceOf(Error);
  });
});

describe("Loader type", () => {
  it("should accept valid loader values", () => {
    const loaders: Loader[] = ["js", "jsx", "ts", "tsx"];
    expect(loaders).toHaveLength(4);
  });
});
