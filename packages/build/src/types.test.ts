/**
 * Tests for shared types
 */

import { describe, it, expect } from "vitest";
import { BuildError } from "./types.js";
import type { BuildErrorDetail } from "./types.js";

describe("BuildError", () => {
  it("should have correct name", () => {
    const error = new BuildError("Test error");
    expect(error.name).toBe("BuildError");
  });

  it("should have message", () => {
    const error = new BuildError("Test error message");
    expect(error.message).toBe("Test error message");
  });

  it("should have empty errors array by default", () => {
    const error = new BuildError("Test error");
    expect(error.errors).toEqual([]);
  });

  it("should accept errors array", () => {
    const details: BuildErrorDetail[] = [
      { message: "Error 1", file: "file1.ts", line: 10, column: 5 },
      { message: "Error 2", file: "file2.ts", line: 20 },
    ];
    const error = new BuildError("Test error", details);

    expect(error.errors).toEqual(details);
    expect(error.errors).toHaveLength(2);
  });

  it("should be instanceof Error", () => {
    const error = new BuildError("Test");
    expect(error).toBeInstanceOf(Error);
  });

  it("should be instanceof BuildError", () => {
    const error = new BuildError("Test");
    expect(error).toBeInstanceOf(BuildError);
  });

  it("should have errors as readonly property", () => {
    const error = new BuildError("Test");
    // TypeScript enforces this at compile time
    // Runtime test just verifies the property exists
    expect(error).toHaveProperty("errors");
  });
});

describe("BuildErrorDetail", () => {
  it("should require message property", () => {
    const detail: BuildErrorDetail = { message: "Error message" };
    expect(detail.message).toBe("Error message");
  });

  it("should have optional file property", () => {
    const detail: BuildErrorDetail = {
      message: "Error",
      file: "test.ts",
    };
    expect(detail.file).toBe("test.ts");
  });

  it("should have optional line property", () => {
    const detail: BuildErrorDetail = {
      message: "Error",
      line: 42,
    };
    expect(detail.line).toBe(42);
  });

  it("should have optional column property", () => {
    const detail: BuildErrorDetail = {
      message: "Error",
      column: 10,
    };
    expect(detail.column).toBe(10);
  });

  it("should accept all properties", () => {
    const detail: BuildErrorDetail = {
      message: "Full error",
      file: "test.ts",
      line: 42,
      column: 10,
    };

    expect(detail).toEqual({
      message: "Full error",
      file: "test.ts",
      line: 42,
      column: 10,
    });
  });
});

describe("Error handling patterns", () => {
  it("should be catchable as Error", () => {
    try {
      throw new BuildError("Test");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("should be distinguishable from generic Error", () => {
    const buildError = new BuildError("Build failed");
    const genericError = new Error("Generic error");

    expect(buildError instanceof BuildError).toBe(true);
    expect(genericError instanceof BuildError).toBe(false);
  });

  it("should preserve error details through catch", () => {
    const details: BuildErrorDetail[] = [
      { message: "Syntax error", file: "test.ts", line: 1 },
    ];

    try {
      throw new BuildError("Build failed", details);
    } catch (e) {
      if (e instanceof BuildError) {
        expect(e.errors).toEqual(details);
      } else {
        throw new Error("Expected BuildError");
      }
    }
  });
});
