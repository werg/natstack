import { describe, it } from "node:test";
import assert from "node:assert";
import { executeCell, AbortError, TimeoutError } from "./executor.js";
import { createConsoleCapture } from "./console-capture.js";
import type { ExecutionHelpers } from "./types.js";

function createTestHelpers(overrides: Partial<ExecutionHelpers> = {}): ExecutionHelpers {
  return {
    console: createConsoleCapture(),
    importModule: async () => {
      throw new Error("importModule not implemented in test");
    },
    importOPFS: async () => {
      throw new Error("importOPFS not implemented in test");
    },
    ...overrides,
  };
}

describe("executeCell", () => {
  describe("basic execution", () => {
    it("should execute simple expressions", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("1 + 2", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
    });

    it("should execute statements", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("const x = 1; const y = 2;", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
      assert.strictEqual(scope["x"], 1);
      assert.strictEqual(scope["y"], 2);
    });

    it("should handle async/await", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell(
        "const p = await Promise.resolve(42); console.log(p);",
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(scope["p"], 42);
      assert.deepStrictEqual(result.output[0]!.args, [42]);
    });
  });

  describe("scope persistence", () => {
    it("should persist const declarations to scope", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      await executeCell("const x = 42;", scope, mutableKeys, helpers);

      assert.strictEqual(scope["x"], 42);
    });

    it("should persist let declarations to scope as mutable", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("let y = 100;", scope, mutableKeys, helpers);

      assert.strictEqual(scope["y"], 100);
      assert.deepStrictEqual(result.mutableNames, ["y"]);
    });

    it("should persist function declarations to scope", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      await executeCell("function add(a, b) { return a + b; }", scope, mutableKeys, helpers);

      assert.strictEqual(typeof scope["add"], "function");
      assert.strictEqual((scope["add"] as (a: number, b: number) => number)(2, 3), 5);
    });

    it("should persist class declarations to scope", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      await executeCell("class Counter { constructor() { this.value = 0; } }", scope, mutableKeys, helpers);

      assert.strictEqual(typeof scope["Counter"], "function");
    });

    it("should access previous scope values", async () => {
      const scope: Record<string, unknown> = { existingVar: 10 };
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("console.log(existingVar * 2);", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [20]);
    });

    it("should allow using scope values across cells", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      // Cell 1: declare variable
      await executeCell("let counter = 0;", scope, mutableKeys, helpers);
      mutableKeys.add("counter"); // Simulate kernel tracking
      assert.strictEqual(scope["counter"], 0);

      // Cell 2: use the variable
      const result = await executeCell("console.log(counter + 1);", scope, mutableKeys, helpers);
      assert.deepStrictEqual(result.output[0]!.args, [1]);
    });

    it("should allow mutable variables to be reassigned across cells", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      // Cell 1: declare mutable variable
      await executeCell("let counter = 0;", scope, mutableKeys, helpers);
      mutableKeys.add("counter");
      assert.strictEqual(scope["counter"], 0);

      // Cell 2: reassign the variable - should auto-persist without manual __scope__ assignment
      await executeCell("counter = counter + 1;", scope, mutableKeys, helpers);
      assert.strictEqual(scope["counter"], 1);

      // Cell 3: verify it persists again
      await executeCell("counter = counter + 10;", scope, mutableKeys, helpers);
      assert.strictEqual(scope["counter"], 11);
    });
  });

  describe("mutable vs const tracking", () => {
    it("should track const names separately from mutable", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("const x = 1; let y = 2;", scope, mutableKeys, helpers);

      assert.deepStrictEqual(result.constNames, ["x"]);
      assert.deepStrictEqual(result.mutableNames, ["y"]);
    });

    it("should use let for mutable variables in scope destructure", async () => {
      const scope: Record<string, unknown> = { mutableVar: 10, constVar: 20 };
      const mutableKeys = new Set<string>(["mutableVar"]);
      const helpers = createTestHelpers();

      // mutableVar should be accessible and reassignable
      const result = await executeCell(
        "console.log(mutableVar, constVar);",
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [10, 20]);
    });
  });

  describe("console capture", () => {
    it("should capture console.log output", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell('console.log("hello");', scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output.length, 1);
      assert.strictEqual(result.output[0]!.level, "log");
      assert.deepStrictEqual(result.output[0]!.args, ["hello"]);
    });

    it("should capture multiple console outputs", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell(
        'console.log("one"); console.warn("two"); console.error("three");',
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.output.length, 3);
      assert.strictEqual(result.output[0]!.level, "log");
      assert.strictEqual(result.output[1]!.level, "warn");
      assert.strictEqual(result.output[2]!.level, "error");
    });
  });

  describe("error handling", () => {
    it("should catch and return runtime errors", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("throw new Error('test error');", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof Error);
      assert.strictEqual(result.error.message, "test error");
    });

    it("should catch reference errors", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell("undefinedVariable", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof Error);
    });

    it("should capture console output even when error occurs", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell(
        'console.log("before error"); throw new Error("fail");',
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output.length, 1);
      assert.deepStrictEqual(result.output[0]!.args, ["before error"]);
    });
  });

  describe("abort and timeout", () => {
    it("should abort when signal is already aborted", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const controller = new AbortController();
      controller.abort();

      const helpers = createTestHelpers({ signal: controller.signal });

      const result = await executeCell("const x = 1;", scope, mutableKeys, helpers);

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof AbortError);
    });

    it("should abort async operations when signal fires", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const controller = new AbortController();

      const helpers = createTestHelpers({ signal: controller.signal });

      const promise = executeCell(
        "await new Promise(r => setTimeout(r, 10000))",
        scope,
        mutableKeys,
        helpers
      );

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      const result = await promise;
      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof AbortError);
    });

    it("should timeout when execution takes too long", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell(
        "await new Promise(r => setTimeout(r, 10000))",
        scope,
        mutableKeys,
        helpers,
        { timeout: 50 }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof TimeoutError);
    });

    it("should complete before timeout if fast enough", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const result = await executeCell(
        "const x = 1 + 2;",
        scope,
        mutableKeys,
        helpers,
        { timeout: 5000 }
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(scope["x"], 3);
    });

    it("should provide checkAbort function to user code", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const controller = new AbortController();

      const helpers = createTestHelpers({ signal: controller.signal });

      // checkAbort should be available
      const result = await executeCell(
        "checkAbort(); const x = 1;",
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(scope["x"], 1);
    });
  });

  describe("import helpers", () => {
    it("should make importModule available", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const mockModule = { default: "mock" };
      const helpers = createTestHelpers({
        importModule: async () => mockModule,
      });

      const result = await executeCell(
        "const mod = await importModule('test'); console.log(mod);",
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(scope["mod"], mockModule);
    });

    it("should make importOPFS available", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const mockModule = { helper: () => 42 };
      const helpers = createTestHelpers({
        importOPFS: async () => mockModule,
      });

      const result = await executeCell(
        "const mod = await importOPFS('/test.js'); console.log(mod.helper());",
        scope,
        mutableKeys,
        helpers
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [42]);
    });
  });

  describe("complex scenarios", () => {
    it("should handle multi-line code with mixed statements", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const code = `
        const numbers = [1, 2, 3, 4, 5];
        const doubled = numbers.map(n => n * 2);
        console.log("Doubled:", doubled);
        console.log("Sum:", doubled.reduce((a, b) => a + b, 0));
      `;

      const result = await executeCell(code, scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.output.length, 2);
      assert.deepStrictEqual(scope["numbers"], [1, 2, 3, 4, 5]);
      assert.deepStrictEqual(scope["doubled"], [2, 4, 6, 8, 10]);
      assert.deepStrictEqual(result.output[1]!.args, ["Sum:", 30]);
    });

    it("should work with async iteration", async () => {
      const scope: Record<string, unknown> = {};
      const mutableKeys = new Set<string>();
      const helpers = createTestHelpers();

      const code = `
        const results = [];
        for (const i of [1, 2, 3]) {
          results.push(await Promise.resolve(i * 2));
        }
        console.log(results);
      `;

      const result = await executeCell(code, scope, mutableKeys, helpers);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [[2, 4, 6]]);
    });
  });
});
