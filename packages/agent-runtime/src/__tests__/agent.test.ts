/**
 * Agent module unit tests.
 *
 * Tests for deepMerge utility and related agent functionality.
 */

import { describe, it, expect } from "vitest";
import { deepMerge } from "../agent.js";

describe("deepMerge", () => {
  it("should merge flat objects", () => {
    const defaults = { a: 1, b: 2, c: 3 };
    const persisted = { b: 20, c: 30 };

    const result = deepMerge(defaults, persisted);

    expect(result).toEqual({ a: 1, b: 20, c: 30 });
  });

  it("should preserve defaults for missing keys", () => {
    const defaults = { a: 1, b: 2, c: 3 };
    const persisted = { b: 20 };

    const result = deepMerge(defaults, persisted);

    expect(result.a).toBe(1);
    expect(result.b).toBe(20);
    expect(result.c).toBe(3);
  });

  it("should deep merge nested objects", () => {
    const defaults = {
      nested: { x: 1, y: 2 },
      other: "value",
    };
    const persisted: Partial<typeof defaults> = {
      nested: { x: 10 } as typeof defaults.nested,
    };

    const result = deepMerge(defaults, persisted);

    expect(result.nested).toEqual({ x: 10, y: 2 });
    expect(result.other).toBe("value");
  });

  it("should not merge arrays (replace them)", () => {
    const defaults = { arr: [1, 2, 3] };
    const persisted = { arr: [4, 5] };

    const result = deepMerge(defaults, persisted);

    expect(result.arr).toEqual([4, 5]);
  });

  it("should handle null persisted values", () => {
    const defaults = { a: 1, b: { x: 2 } };
    const persisted = { a: null, b: null } as unknown as Partial<typeof defaults>;

    const result = deepMerge(defaults, persisted);

    // null should override (not be ignored)
    expect(result.a).toBeNull();
    expect(result.b).toBeNull();
  });

  it("should ignore undefined persisted values", () => {
    const defaults = { a: 1, b: 2 };
    const persisted = { a: undefined, b: 20 };

    const result = deepMerge(defaults, persisted);

    expect(result.a).toBe(1); // undefined ignored, default preserved
    expect(result.b).toBe(20);
  });

  it("should handle empty persisted object", () => {
    const defaults = { a: 1, b: { nested: true } };
    const persisted = {};

    const result = deepMerge(defaults, persisted);

    expect(result).toEqual(defaults);
  });

  it("should deeply merge multiple levels", () => {
    const defaults = {
      level1: {
        level2: {
          level3: { a: 1, b: 2 },
        },
      },
    };
    const persisted: Partial<typeof defaults> = {
      level1: {
        level2: {
          level3: { a: 10 } as typeof defaults.level1.level2.level3,
        },
      } as typeof defaults.level1,
    };

    const result = deepMerge(defaults, persisted);

    expect(result.level1.level2.level3).toEqual({ a: 10, b: 2 });
  });

  it("should not mutate original objects", () => {
    const defaults = { a: 1, nested: { x: 1 } };
    const persisted = { a: 2, nested: { x: 2 } };

    const originalDefaults = JSON.parse(JSON.stringify(defaults));
    const originalPersisted = JSON.parse(JSON.stringify(persisted));

    deepMerge(defaults, persisted);

    expect(defaults).toEqual(originalDefaults);
    expect(persisted).toEqual(originalPersisted);
  });
});
