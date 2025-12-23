import { describe, it, expect, vi } from "vitest";
import { execute, executeDefault, validateRequires, getDefaultRequire } from "./execute";

describe("execute", () => {
  // Mock require function for tests
  const mockRequire = (id: string) => {
    if (id === "test-module") {
      return { value: 42 };
    }
    throw new Error(`Module not found: ${id}`);
  };

  describe("basic execution", () => {
    it("executes simple code", () => {
      const result = execute(`exports.value = 42;`, { require: mockRequire });

      expect(result.exports.value).toBe(42);
    });

    it("returns the return value of the code", () => {
      const result = execute(`return 123;`, { require: mockRequire });

      expect(result.returnValue).toBe(123);
    });

    it("supports module.exports assignment", () => {
      const result = execute(`module.exports = { foo: "bar" };`, {
        require: mockRequire,
      });

      expect(result.exports).toEqual({ foo: "bar" });
    });

    it("supports exports.default", () => {
      const result = execute(`exports.default = function() { return 1; };`, {
        require: mockRequire,
      });

      expect(typeof result.exports.default).toBe("function");
    });
  });

  describe("require function", () => {
    it("uses provided require function", () => {
      const result = execute(
        `const mod = require("test-module"); exports.val = mod.value;`,
        { require: mockRequire }
      );

      expect(result.exports.val).toBe(42);
    });

    it("throws when require is not available", () => {
      // Temporarily remove global require
      const original = (globalThis as Record<string, unknown>)[
        "__natstackRequire__"
      ];
      delete (globalThis as Record<string, unknown>)["__natstackRequire__"];

      try {
        expect(() => execute(`exports.x = 1;`)).toThrow(
          "__natstackRequire__ not available"
        );
      } finally {
        if (original) {
          (globalThis as Record<string, unknown>)["__natstackRequire__"] =
            original;
        }
      }
    });
  });

  describe("console capture", () => {
    it("uses provided console proxy", () => {
      const logs: string[] = [];
      const mockConsole = {
        log: (...args: unknown[]) => logs.push(args.join(" ")),
      } as Console;

      execute(`console.log("hello", "world");`, {
        require: mockRequire,
        console: mockConsole,
      });

      expect(logs).toEqual(["hello world"]);
    });

    it("uses default console when not provided", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        execute(`console.log("test");`, { require: mockRequire });
        expect(spy).toHaveBeenCalledWith("test");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("scope bindings", () => {
    it("injects custom bindings", () => {
      const result = execute(`exports.doubled = myValue * 2;`, {
        require: mockRequire,
        bindings: { myValue: 21 },
      });

      expect(result.exports.doubled).toBe(42);
    });

    it("supports multiple bindings", () => {
      const result = execute(`exports.sum = a + b + c;`, {
        require: mockRequire,
        bindings: { a: 1, b: 2, c: 3 },
      });

      expect(result.exports.sum).toBe(6);
    });

    it("bindings can be functions", () => {
      const result = execute(`exports.result = myFn(5);`, {
        require: mockRequire,
        bindings: { myFn: (x: number) => x * 2 },
      });

      expect(result.exports.result).toBe(10);
    });
  });

  describe("strict mode", () => {
    it("runs in strict mode", () => {
      expect(() =>
        execute(`undeclaredVariable = 42;`, { require: mockRequire })
      ).toThrow();
    });
  });

  describe("error handling", () => {
    it("propagates runtime errors", () => {
      expect(() =>
        execute(`throw new Error("test error");`, { require: mockRequire })
      ).toThrow("test error");
    });

    it("propagates syntax errors in code", () => {
      expect(() =>
        execute(`const x = {`, { require: mockRequire })
      ).toThrow();
    });
  });
});

describe("executeDefault", () => {
  const mockRequire = () => ({});

  it("returns the default export", () => {
    const result = executeDefault<number>(
      `exports.default = 42;`,
      { require: mockRequire }
    );

    expect(result).toBe(42);
  });

  it("returns module.exports when it's a function", () => {
    const fn = executeDefault<() => number>(
      `module.exports = function() { return 123; };`,
      { require: mockRequire }
    );

    expect(fn()).toBe(123);
  });

  it("throws when no default export found", () => {
    expect(() =>
      executeDefault(`exports.named = 42;`, { require: mockRequire })
    ).toThrow("No default export found");
  });

  it("works with complex default exports", () => {
    const result = executeDefault<{ name: string; value: number }>(
      `exports.default = { name: "test", value: 42 };`,
      { require: mockRequire }
    );

    expect(result).toEqual({ name: "test", value: 42 });
  });
});

describe("validateRequires", () => {
  it("returns valid when all modules are available", () => {
    const mockRequire = (id: string) => {
      if (id === "react" || id === "lodash") return {};
      throw new Error(`Not found: ${id}`);
    };

    const result = validateRequires(["react", "lodash"], mockRequire);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.missingModule).toBeUndefined();
  });

  it("returns invalid when a module is missing", () => {
    const mockRequire = (id: string) => {
      if (id === "react") return {};
      throw new Error(`Not found: ${id}`);
    };

    const result = validateRequires(["react", "missing-module"], mockRequire);

    expect(result.valid).toBe(false);
    expect(result.missingModule).toBe("missing-module");
    expect(result.error).toContain("missing-module");
  });

  it("returns invalid when require function is not available", () => {
    // Don't provide a require function and ensure global isn't set
    const original = (globalThis as Record<string, unknown>)["__natstackRequire__"];
    delete (globalThis as Record<string, unknown>)["__natstackRequire__"];

    try {
      const result = validateRequires(["react"]);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("__natstackRequire__");
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__natstackRequire__"] = original;
      }
    }
  });

  it("returns valid for empty requires array", () => {
    const mockRequire = () => ({});
    const result = validateRequires([], mockRequire);

    expect(result.valid).toBe(true);
  });

  it("stops at first missing module", () => {
    const attempted: string[] = [];
    const mockRequire = (id: string) => {
      attempted.push(id);
      if (id === "a") return {};
      throw new Error(`Not found: ${id}`);
    };

    validateRequires(["a", "b", "c"], mockRequire);

    // Should stop after "b" fails, never try "c"
    expect(attempted).toEqual(["a", "b"]);
  });
});

describe("getDefaultRequire", () => {
  it("returns undefined when global require is not set", () => {
    const original = (globalThis as Record<string, unknown>)["__natstackRequire__"];
    delete (globalThis as Record<string, unknown>)["__natstackRequire__"];

    try {
      expect(getDefaultRequire()).toBeUndefined();
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__natstackRequire__"] = original;
      }
    }
  });

  it("returns the global require function when set", () => {
    const mockFn = () => ({});
    const original = (globalThis as Record<string, unknown>)["__natstackRequire__"];
    (globalThis as Record<string, unknown>)["__natstackRequire__"] = mockFn;

    try {
      expect(getDefaultRequire()).toBe(mockFn);
    } finally {
      if (original) {
        (globalThis as Record<string, unknown>)["__natstackRequire__"] = original;
      } else {
        delete (globalThis as Record<string, unknown>)["__natstackRequire__"];
      }
    }
  });
});
