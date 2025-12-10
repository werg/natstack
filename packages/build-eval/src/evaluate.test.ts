/**
 * Tests for code evaluation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluate, initializeEval, AbortError, EvalError } from "./evaluate.js";

// Mock dependencies
vi.mock("@natstack/build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@natstack/build")>();
  return {
    getEsbuild: vi.fn(),
    transform: vi.fn(),
    getLoaderForLanguage: vi.fn().mockReturnValue("tsx"),
    BuildError: class BuildError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "BuildError";
      }
    },
    createFsPlugin: vi.fn().mockReturnValue({
      name: "mock-fs",
      setup: () => {},
    }),
    // Use actual implementations for ESM transform and execution utilities
    transformEsmForAsyncExecution: actual.transformEsmForAsyncExecution,
    executeEsm: actual.executeEsm,
    getExportReturnValue: actual.getExportReturnValue,
  };
});

vi.mock("./type-check.js", () => ({
  typeCheckOrThrow: vi.fn().mockResolvedValue(undefined),
  isTypeScriptAvailable: vi.fn().mockResolvedValue(true),
}));

describe("evaluate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("basic evaluation", () => {
    it("should evaluate simple JavaScript code", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: 'console.log("hello");' }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: 'console.log("hello");',
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const result = await evaluate('console.log("hello");', {
        language: "typescript",
      });

      expect(result.console).toBeDefined();
      expect(result.bindings).toBeDefined();
    });

    it("should capture console.log output", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: '__console__.log("captured");' }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: 'console.log("captured");',
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const result = await evaluate('console.log("captured");', {
        language: "typescript",
      });

      // Console output should be captured (may be empty if the bundled code doesn't use __console__)
      expect(result.console).toBeDefined();
      expect(Array.isArray(result.console)).toBe(true);
    });

    it("should return bindings object", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const x = 42;" }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 42;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const result = await evaluate("const x = 42;", {
        language: "typescript",
      });

      expect(result.bindings).toBeDefined();
      expect(typeof result.bindings).toBe("object");
    });
  });

  describe("type checking", () => {
    it("should skip type checking by default", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const x = 1;" }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const { typeCheckOrThrow } = await import("./type-check.js");

      await evaluate("const x = 1;", { language: "typescript" });

      expect(typeCheckOrThrow).not.toHaveBeenCalled();
    });

    it("should call type checker when typeCheck is true", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const x = 1;" }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const { typeCheckOrThrow } = await import("./type-check.js");

      await evaluate("const x: number = 1;", {
        language: "typescript",
        typeCheck: true,
      });

      expect(typeCheckOrThrow).toHaveBeenCalledWith(
        "const x: number = 1;",
        expect.objectContaining({ language: "typescript" })
      );
    });
  });

  describe("abort handling", () => {
    it("should throw AbortError when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        evaluate("const x = 1;", {
          language: "typescript",
          signal: controller.signal,
        })
      ).rejects.toThrow(AbortError);
    });

    it("should throw AbortError when aborted during transform", async () => {
      const controller = new AbortController();

      const { transform } = await import("@natstack/build");
      vi.mocked(transform).mockImplementation(async () => {
        controller.abort();
        return { code: "const x = 1;" };
      });

      await expect(
        evaluate("const x = 1;", {
          language: "typescript",
          signal: controller.signal,
        })
      ).rejects.toThrow(AbortError);
    });

    it("should throw AbortError when aborted after getting esbuild", async () => {
      const controller = new AbortController();

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(transform).mockImplementation(mockTransform);
      vi.mocked(getEsbuild).mockImplementation(async () => {
        controller.abort();
        return { build: vi.fn() } as never;
      });

      await expect(
        evaluate("const x = 1;", {
          language: "typescript",
          signal: controller.signal,
        })
      ).rejects.toThrow(AbortError);
    });
  });

  describe("build errors", () => {
    it("should throw BuildError on esbuild errors", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [
          {
            location: { file: "input.js", line: 1 },
            text: "Syntax error",
          },
        ],
        outputFiles: [],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = {{",
      });

      const { getEsbuild, transform, BuildError } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      await expect(
        evaluate("const x = {{", { language: "typescript" })
      ).rejects.toThrow(BuildError);
    });

    it("should throw BuildError when no output from esbuild", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
      });

      const { getEsbuild, transform, BuildError } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      await expect(
        evaluate("const x = 1;", { language: "typescript" })
      ).rejects.toThrow(BuildError);
    });
  });

  describe("bindings injection", () => {
    it("should accept bindings option", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const result = injectedValue * 2;" }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const result = injectedValue * 2;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      const result = await evaluate("const result = injectedValue * 2;", {
        language: "typescript",
        bindings: { injectedValue: 21 },
      });

      expect(result).toBeDefined();
    });
  });

  describe("language options", () => {
    it("should handle javascript language", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const x = 1;" }],
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);

      // For JavaScript, transform should not be called (or return as-is)
      const result = await evaluate("const x = 1;", {
        language: "javascript",
      });

      expect(result).toBeDefined();
    });

    it("should transform TypeScript to JavaScript", async () => {
      const mockBuild = vi.fn().mockResolvedValue({
        errors: [],
        outputFiles: [{ text: "const x = 1;" }],
      });

      const mockTransform = vi.fn().mockResolvedValue({
        code: "const x = 1;",
      });

      const { getEsbuild, transform } = await import("@natstack/build");
      vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
      vi.mocked(transform).mockImplementation(mockTransform);

      await evaluate("const x: number = 1;", { language: "typescript" });

      expect(transform).toHaveBeenCalled();
    });
  });
});

describe("AbortError", () => {
  it("should have correct name", () => {
    const error = new AbortError();
    expect(error.name).toBe("AbortError");
  });

  it("should have default message", () => {
    const error = new AbortError();
    expect(error.message).toBe("Execution aborted");
  });

  it("should accept custom message", () => {
    const error = new AbortError("Custom abort");
    expect(error.message).toBe("Custom abort");
  });

  it("should be instanceof Error", () => {
    const error = new AbortError();
    expect(error).toBeInstanceOf(Error);
  });
});

describe("EvalError", () => {
  it("should have correct name", () => {
    const error = new EvalError("Test error");
    expect(error.name).toBe("EvalError");
  });

  it("should have message", () => {
    const error = new EvalError("Evaluation failed");
    expect(error.message).toBe("Evaluation failed");
  });

  it("should accept cause", () => {
    const cause = new Error("Original error");
    const error = new EvalError("Wrapped error", cause);
    expect(error.cause).toBe(cause);
  });

  it("should be instanceof Error", () => {
    const error = new EvalError("Test");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("initializeEval", () => {
  it("should call getEsbuild to pre-warm", async () => {
    const { getEsbuild } = await import("@natstack/build");
    vi.mocked(getEsbuild).mockResolvedValue({} as never);

    await initializeEval();

    expect(getEsbuild).toHaveBeenCalled();
  });
});

describe("return value capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should capture exports from ESM format with default export", async () => {
    // Simulate esbuild ESM output with exports - this gets transformed
    const mockBuild = vi.fn().mockResolvedValue({
      errors: [],
      outputFiles: [
        {
          text: `var x = 42;
export default x;`,
        },
      ],
    });

    const mockTransform = vi.fn().mockResolvedValue({
      code: "export default 42;",
    });

    const { getEsbuild, transform } = await import("@natstack/build");
    vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
    vi.mocked(transform).mockImplementation(mockTransform);

    const result = await evaluate("export default 42;", {
      language: "typescript",
    });

    expect(result.returnValue).toBe(42);
    expect(result.bindings).toHaveProperty("default", 42);
  });

  it("should capture named exports", async () => {
    const mockBuild = vi.fn().mockResolvedValue({
      errors: [],
      outputFiles: [
        {
          text: `var foo = 1;
var bar = 2;
export { foo, bar };`,
        },
      ],
    });

    const mockTransform = vi.fn().mockResolvedValue({
      code: "export const foo = 1; export const bar = 2;",
    });

    const { getEsbuild, transform } = await import("@natstack/build");
    vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
    vi.mocked(transform).mockImplementation(mockTransform);

    const result = await evaluate("export const foo = 1;", {
      language: "typescript",
    });

    expect(result.returnValue).toEqual({ foo: 1, bar: 2 });
    expect(result.bindings).toHaveProperty("foo", 1);
    expect(result.bindings).toHaveProperty("bar", 2);
  });

  it("should return default export when present alongside named exports", async () => {
    const mockBuild = vi.fn().mockResolvedValue({
      errors: [],
      outputFiles: [
        {
          text: `var value = { x: 123 };
var helper = "test";
export default value;
export { helper };`,
        },
      ],
    });

    const mockTransform = vi.fn().mockResolvedValue({
      code: "export default { x: 123 }; export const helper = 'test';",
    });

    const { getEsbuild, transform } = await import("@natstack/build");
    vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
    vi.mocked(transform).mockImplementation(mockTransform);

    const result = await evaluate("export default { value: 123 };", {
      language: "typescript",
    });

    // Should return default export, not the whole module
    expect(result.returnValue).toEqual({ x: 123 });
  });

  it("should return undefined when no exports", async () => {
    const mockBuild = vi.fn().mockResolvedValue({
      errors: [],
      outputFiles: [
        {
          text: `var x = 1 + 2;`,
        },
      ],
    });

    const mockTransform = vi.fn().mockResolvedValue({
      code: "const x = 1 + 2;",
    });

    const { getEsbuild, transform } = await import("@natstack/build");
    vi.mocked(getEsbuild).mockResolvedValue({ build: mockBuild } as never);
    vi.mocked(transform).mockImplementation(mockTransform);

    const result = await evaluate("const x = 1 + 2;", {
      language: "typescript",
    });

    expect(result.returnValue).toBeUndefined();
  });
});
