/**
 * Tests for type definitions
 */

import { describe, it, expect } from "vitest";
import type {
  EvalOptions,
  EvalResult,
  EvalContext,
  ConsoleEntry,
  ConsoleCapture,
  TypeCheckOptions,
  TypeCheckResult,
  TypeCheckError,
} from "./types.js";
import type { PackageRegistry, PackageSpec } from "@natstack/build";

describe("EvalOptions type", () => {
  it("should accept valid options with language", () => {
    const options: EvalOptions = {
      language: "typescript",
    };
    expect(options.language).toBe("typescript");
  });

  it("should accept javascript language", () => {
    const options: EvalOptions = {
      language: "javascript",
    };
    expect(options.language).toBe("javascript");
  });

  it("should accept optional bindings", () => {
    const options: EvalOptions = {
      language: "typescript",
      bindings: { foo: 1, bar: "baz" },
    };
    expect(options.bindings).toEqual({ foo: 1, bar: "baz" });
  });

  it("should accept optional typeCheck flag", () => {
    const options: EvalOptions = {
      language: "typescript",
      typeCheck: true,
    };
    expect(options.typeCheck).toBe(true);
  });

  it("should accept optional signal", () => {
    const controller = new AbortController();
    const options: EvalOptions = {
      language: "typescript",
      signal: controller.signal,
    };
    expect(options.signal).toBe(controller.signal);
  });

  it("should accept all options together", () => {
    const controller = new AbortController();
    const options: EvalOptions = {
      language: "typescript",
      bindings: { x: 42 },
      typeCheck: true,
      signal: controller.signal,
    };
    expect(options).toBeDefined();
  });

  it("should accept optional context", () => {
    const options: EvalOptions = {
      language: "typescript",
      context: {
        projectRoot: "/project",
      },
    };
    expect(options.context?.projectRoot).toBe("/project");
  });

  it("should accept context with registry", () => {
    const mockRegistry: PackageRegistry = {
      get: () => undefined,
      has: () => false,
      keys: () => [],
    };
    const options: EvalOptions = {
      language: "typescript",
      context: {
        projectRoot: "/project",
        registry: mockRegistry,
      },
    };
    expect(options.context?.registry).toBe(mockRegistry);
  });

  it("should accept context with dependencies", () => {
    const options: EvalOptions = {
      language: "typescript",
      context: {
        projectRoot: "/project",
        dependencies: {
          lodash: "^4.17.0",
          "my-lib": "user/lib#main",
        },
      },
    };
    expect(options.context?.dependencies?.["lodash"]).toBe("^4.17.0");
  });
});

describe("EvalContext type", () => {
  it("should require projectRoot", () => {
    const context: EvalContext = {
      projectRoot: "/my/project",
    };
    expect(context.projectRoot).toBe("/my/project");
  });

  it("should accept optional sourceRoot", () => {
    const context: EvalContext = {
      projectRoot: "/project",
      sourceRoot: "/project/src",
    };
    expect(context.sourceRoot).toBe("/project/src");
  });

  it("should accept optional registry", () => {
    const mockRegistry: PackageRegistry = {
      get: (name: string): PackageSpec | undefined => {
        if (name === "test") return { gitSpec: "user/test#main" };
        return undefined;
      },
      has: (name: string) => name === "test",
      keys: () => ["test"],
    };
    const context: EvalContext = {
      projectRoot: "/project",
      registry: mockRegistry,
    };
    expect(context.registry?.has("test")).toBe(true);
    expect(context.registry?.get("test")?.gitSpec).toBe("user/test#main");
  });

  it("should accept optional dependencies map", () => {
    const context: EvalContext = {
      projectRoot: "/project",
      dependencies: {
        react: "^18.0.0",
        lodash: "^4.17.0",
      },
    };
    expect(context.dependencies).toEqual({
      react: "^18.0.0",
      lodash: "^4.17.0",
    });
  });

  it("should accept all context properties", () => {
    const mockRegistry: PackageRegistry = {
      get: () => undefined,
      has: () => false,
      keys: () => [],
    };
    const context: EvalContext = {
      projectRoot: "/project",
      sourceRoot: "/project/src/cells",
      registry: mockRegistry,
      dependencies: {
        "local-lib": "user/lib#main",
      },
    };
    expect(context.projectRoot).toBe("/project");
    expect(context.sourceRoot).toBe("/project/src/cells");
    expect(context.registry).toBe(mockRegistry);
    expect(context.dependencies).toHaveProperty("local-lib");
  });
});

describe("EvalResult type", () => {
  it("should have console array", () => {
    const result: EvalResult = {
      console: [],
      bindings: {},
    };
    expect(result.console).toEqual([]);
  });

  it("should have bindings object", () => {
    const result: EvalResult = {
      console: [],
      bindings: { x: 1 },
    };
    expect(result.bindings).toEqual({ x: 1 });
  });

  it("should accept optional returnValue", () => {
    const result: EvalResult = {
      console: [],
      bindings: {},
      returnValue: 42,
    };
    expect(result.returnValue).toBe(42);
  });

  it("should accept undefined returnValue", () => {
    const result: EvalResult = {
      console: [],
      bindings: {},
      returnValue: undefined,
    };
    expect(result.returnValue).toBeUndefined();
  });
});

describe("ConsoleEntry type", () => {
  it("should have level", () => {
    const entry: ConsoleEntry = {
      level: "log",
      args: [],
      timestamp: Date.now(),
    };
    expect(entry.level).toBe("log");
  });

  it("should accept all valid levels", () => {
    const levels: ConsoleEntry["level"][] = ["log", "info", "warn", "error", "debug"];
    levels.forEach((level) => {
      const entry: ConsoleEntry = {
        level,
        args: [],
        timestamp: 0,
      };
      expect(entry.level).toBe(level);
    });
  });

  it("should have args array", () => {
    const entry: ConsoleEntry = {
      level: "log",
      args: ["hello", 42, { key: "value" }],
      timestamp: 0,
    };
    expect(entry.args).toHaveLength(3);
  });

  it("should have timestamp", () => {
    const now = Date.now();
    const entry: ConsoleEntry = {
      level: "log",
      args: [],
      timestamp: now,
    };
    expect(entry.timestamp).toBe(now);
  });
});

describe("ConsoleCapture type", () => {
  it("should have proxy property", () => {
    // Type test - just verify the structure is correct
    const mockCapture: ConsoleCapture = {
      proxy: console,
      getOutput: () => [],
      clear: () => {},
    };
    expect(mockCapture.proxy).toBeDefined();
  });

  it("should have getOutput function", () => {
    const mockCapture: ConsoleCapture = {
      proxy: console,
      getOutput: () => [],
      clear: () => {},
    };
    expect(typeof mockCapture.getOutput).toBe("function");
  });

  it("should have clear function", () => {
    const mockCapture: ConsoleCapture = {
      proxy: console,
      getOutput: () => [],
      clear: () => {},
    };
    expect(typeof mockCapture.clear).toBe("function");
  });
});

describe("TypeCheckOptions type", () => {
  it("should accept language", () => {
    const options: TypeCheckOptions = {
      language: "typescript",
    };
    expect(options.language).toBe("typescript");
  });

  it("should accept javascript language", () => {
    const options: TypeCheckOptions = {
      language: "javascript",
    };
    expect(options.language).toBe("javascript");
  });

  it("should accept optional signal", () => {
    const controller = new AbortController();
    const options: TypeCheckOptions = {
      language: "typescript",
      signal: controller.signal,
    };
    expect(options.signal).toBe(controller.signal);
  });
});

describe("TypeCheckResult type", () => {
  it("should have errors array", () => {
    const result: TypeCheckResult = {
      errors: [],
      warnings: [],
    };
    expect(result.errors).toEqual([]);
  });

  it("should have warnings array", () => {
    const result: TypeCheckResult = {
      errors: [],
      warnings: [],
    };
    expect(result.warnings).toEqual([]);
  });

  it("should accept errors with details", () => {
    const result: TypeCheckResult = {
      errors: [
        { message: "Error 1", file: "test.ts", line: 1, column: 1 },
        { message: "Error 2" },
      ],
      warnings: [],
    };
    expect(result.errors).toHaveLength(2);
  });
});

describe("TypeCheckError type", () => {
  it("should require message", () => {
    const error: TypeCheckError = {
      message: "Type error message",
    };
    expect(error.message).toBe("Type error message");
  });

  it("should accept optional file", () => {
    const error: TypeCheckError = {
      message: "Error",
      file: "test.ts",
    };
    expect(error.file).toBe("test.ts");
  });

  it("should accept optional line", () => {
    const error: TypeCheckError = {
      message: "Error",
      line: 42,
    };
    expect(error.line).toBe(42);
  });

  it("should accept optional column", () => {
    const error: TypeCheckError = {
      message: "Error",
      column: 10,
    };
    expect(error.column).toBe(10);
  });

  it("should accept all properties", () => {
    const error: TypeCheckError = {
      message: "Full error",
      file: "test.ts",
      line: 42,
      column: 10,
    };
    expect(error).toEqual({
      message: "Full error",
      file: "test.ts",
      line: 42,
      column: 10,
    });
  });
});
