import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { NotebookKernel, AbortError, TimeoutError } from "./kernel.js";

describe("NotebookKernel", () => {
  let kernel: NotebookKernel;

  beforeEach(() => {
    kernel = new NotebookKernel();
  });

  describe("createSession", () => {
    it("should create a new session and return an ID", () => {
      const sessionId = kernel.createSession();

      assert.ok(typeof sessionId === "string");
      assert.ok(sessionId.length > 0);
    });

    it("should create unique session IDs", () => {
      const id1 = kernel.createSession();
      const id2 = kernel.createSession();

      assert.notStrictEqual(id1, id2);
    });

    it("should initialize session with provided bindings", () => {
      const bindings = { x: 1, y: "hello" };
      const sessionId = kernel.createSession({ bindings });

      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["x"], 1);
      assert.strictEqual(scope["y"], "hello");
    });

    it("should create session with empty scope when no bindings provided", () => {
      const sessionId = kernel.createSession();

      const scope = kernel.getScope(sessionId);
      assert.deepStrictEqual(scope, {});
    });
  });

  describe("getSession", () => {
    it("should return session for valid ID", () => {
      const sessionId = kernel.createSession();

      const session = kernel.getSession(sessionId);
      assert.ok(session);
      assert.strictEqual(session.id, sessionId);
    });

    it("should return undefined for invalid ID", () => {
      const session = kernel.getSession("nonexistent-id");
      assert.strictEqual(session, undefined);
    });
  });

  describe("execute", () => {
    it("should execute simple code", async () => {
      const sessionId = kernel.createSession();

      const result = await kernel.execute(sessionId, "const x = 1 + 2;");

      assert.strictEqual(result.success, true);
      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["x"], 3);
    });

    it("should persist variables across cells", async () => {
      const sessionId = kernel.createSession();

      await kernel.execute(sessionId, "const x = 10;");
      const result = await kernel.execute(sessionId, "console.log(x * 2);");

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [20]);
    });

    it("should capture console output", async () => {
      const sessionId = kernel.createSession();

      const result = await kernel.execute(sessionId, 'console.log("test output");');

      assert.strictEqual(result.output.length, 1);
      assert.strictEqual(result.output[0]!.level, "log");
      assert.deepStrictEqual(result.output[0]!.args, ["test output"]);
    });

    it("should handle errors gracefully", async () => {
      const sessionId = kernel.createSession();

      const result = await kernel.execute(sessionId, 'throw new Error("test error");');

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.strictEqual(result.error.message, "test error");
    });

    it("should throw for nonexistent session", async () => {
      await assert.rejects(
        async () => {
          await kernel.execute("nonexistent", "1 + 1");
        },
        { message: "Session nonexistent not found" }
      );
    });

    it("should use injected bindings", async () => {
      const sessionId = kernel.createSession({
        bindings: { multiplier: 5 },
      });

      const result = await kernel.execute(sessionId, "console.log(multiplier * 10);");

      assert.deepStrictEqual(result.output[0]!.args, [50]);
    });

    it("should track mutable vs const declarations", async () => {
      const sessionId = kernel.createSession();

      const result = await kernel.execute(sessionId, "const x = 1; let y = 2;");

      assert.deepStrictEqual(result.constNames, ["x"]);
      assert.deepStrictEqual(result.mutableNames, ["y"]);
    });
  });

  describe("execution queuing", () => {
    it("should queue concurrent executions on same session", async () => {
      const sessionId = kernel.createSession();

      // Start multiple executions concurrently
      const promises = [
        kernel.execute(sessionId, "const a = 1;"),
        kernel.execute(sessionId, "const b = 2;"),
        kernel.execute(sessionId, "const c = 3;"),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      assert.ok(results.every((r) => r.success));

      // All values should be in scope
      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["a"], 1);
      assert.strictEqual(scope["b"], 2);
      assert.strictEqual(scope["c"], 3);
    });

    it("should execute queued cells in order", async () => {
      const sessionId = kernel.createSession();

      // Start multiple executions that depend on order
      const promises = [
        kernel.execute(sessionId, "let counter = 0;"),
        kernel.execute(sessionId, "counter = counter + 1;"),
        kernel.execute(sessionId, "counter = counter + 10;"),
        kernel.execute(sessionId, "console.log(counter);"),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      assert.ok(results.every((r) => r.success));

      // Last result should have logged 11
      const lastResult = results[3]!;
      assert.deepStrictEqual(lastResult.output[0]!.args, [11]);
    });

    it("should reject queued cells when session is destroyed", async () => {
      const sessionId = kernel.createSession();

      // Start a long-running execution
      const longRunning = kernel.execute(
        sessionId,
        "await new Promise(r => setTimeout(r, 100)); const done = true;"
      );

      // Queue another execution
      const queued = kernel.execute(sessionId, "const after = 1;");

      // Destroy the session while executions are pending
      // Wait a tiny bit to ensure the long-running one started
      await new Promise((r) => setTimeout(r, 10));
      kernel.destroySession(sessionId);

      // The queued execution should be rejected
      await assert.rejects(queued, { message: `Session ${sessionId} destroyed` });

      // The long-running one might complete or fail depending on timing
      try {
        await longRunning;
      } catch {
        // Expected if destroyed during execution
      }
    });
  });

  describe("execution options", () => {
    it("should support timeout option", async () => {
      const sessionId = kernel.createSession();

      const result = await kernel.execute(
        sessionId,
        "await new Promise(r => setTimeout(r, 10000))",
        { timeout: 50 }
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof TimeoutError);
    });

    it("should support abort signal", async () => {
      const sessionId = kernel.createSession();
      const controller = new AbortController();

      const promise = kernel.execute(
        sessionId,
        "await new Promise(r => setTimeout(r, 10000))",
        { signal: controller.signal }
      );

      setTimeout(() => controller.abort(), 10);

      const result = await promise;
      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof AbortError);
    });

    it("should use defaultTimeout from kernel options", async () => {
      const kernelWithTimeout = new NotebookKernel({ defaultTimeout: 50 });
      const sessionId = kernelWithTimeout.createSession();

      const result = await kernelWithTimeout.execute(
        sessionId,
        "await new Promise(r => setTimeout(r, 10000))"
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error instanceof TimeoutError);
    });
  });

  describe("injectBindings", () => {
    it("should inject bindings into session scope", () => {
      const sessionId = kernel.createSession();

      kernel.injectBindings(sessionId, { injected: 42 });

      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["injected"], 42);
    });

    it("should merge with existing bindings", () => {
      const sessionId = kernel.createSession({
        bindings: { existing: 1 },
      });

      kernel.injectBindings(sessionId, { added: 2 });

      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["existing"], 1);
      assert.strictEqual(scope["added"], 2);
    });

    it("should override existing bindings with same name", () => {
      const sessionId = kernel.createSession({
        bindings: { value: "old" },
      });

      kernel.injectBindings(sessionId, { value: "new" });

      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["value"], "new");
    });

    it("should throw for nonexistent session", () => {
      assert.throws(
        () => {
          kernel.injectBindings("nonexistent", { x: 1 });
        },
        { message: "Session nonexistent not found" }
      );
    });

    it("should make injected bindings available in execution", async () => {
      const sessionId = kernel.createSession();

      kernel.injectBindings(sessionId, { helper: (x: number) => x * 2 });

      const result = await kernel.execute(sessionId, "console.log(helper(21));");
      assert.deepStrictEqual(result.output[0]!.args, [42]);
    });

    it("should mark injected bindings as mutable by default", () => {
      const sessionId = kernel.createSession();

      kernel.injectBindings(sessionId, { mutableValue: 10 });

      const session = kernel.getSession(sessionId);
      assert.ok(session?.mutableKeys.has("mutableValue"));
    });

    it("should allow injecting as immutable", () => {
      const sessionId = kernel.createSession();

      kernel.injectBindings(sessionId, { immutableValue: 10 }, false);

      const session = kernel.getSession(sessionId);
      assert.ok(!session?.mutableKeys.has("immutableValue"));
    });
  });

  describe("getScope", () => {
    it("should return a copy of the scope", () => {
      const sessionId = kernel.createSession({
        bindings: { value: 1 },
      });

      const scope1 = kernel.getScope(sessionId);
      const scope2 = kernel.getScope(sessionId);

      assert.notStrictEqual(scope1, scope2);
      assert.deepStrictEqual(scope1, scope2);
    });

    it("should throw for nonexistent session", () => {
      assert.throws(
        () => {
          kernel.getScope("nonexistent");
        },
        { message: "Session nonexistent not found" }
      );
    });
  });

  describe("resetSession", () => {
    it("should clear scope", async () => {
      const sessionId = kernel.createSession();
      await kernel.execute(sessionId, "const x = 1;");
      await kernel.execute(sessionId, "const y = 2;");

      kernel.resetSession(sessionId);

      const scope = kernel.getScope(sessionId);
      assert.deepStrictEqual(scope, {});
    });

    it("should preserve specified bindings", async () => {
      const sessionId = kernel.createSession();
      await kernel.execute(sessionId, "const keep = 1;");
      await kernel.execute(sessionId, "const discard = 2;");

      kernel.resetSession(sessionId, ["keep"]);

      const scope = kernel.getScope(sessionId);
      assert.strictEqual(scope["keep"], 1);
      assert.strictEqual(scope["discard"], undefined);
    });

    it("should preserve mutable status of kept bindings", async () => {
      const sessionId = kernel.createSession();
      await kernel.execute(sessionId, "let mutableVar = 1;");

      kernel.resetSession(sessionId, ["mutableVar"]);

      const session = kernel.getSession(sessionId);
      assert.ok(session?.mutableKeys.has("mutableVar"));
    });

    it("should throw for nonexistent session", () => {
      assert.throws(
        () => {
          kernel.resetSession("nonexistent");
        },
        { message: "Session nonexistent not found" }
      );
    });
  });

  describe("destroySession", () => {
    it("should remove session", () => {
      const sessionId = kernel.createSession();

      kernel.destroySession(sessionId);

      assert.strictEqual(kernel.getSession(sessionId), undefined);
    });

    it("should handle destroying nonexistent session gracefully", () => {
      // Should not throw
      kernel.destroySession("nonexistent");
    });
  });

  describe("destroy", () => {
    it("should destroy all sessions", () => {
      const id1 = kernel.createSession();
      const id2 = kernel.createSession();

      kernel.destroy();

      assert.strictEqual(kernel.getSession(id1), undefined);
      assert.strictEqual(kernel.getSession(id2), undefined);
    });
  });

  describe("snapshotSession", () => {
    it("should return cloned scope for cloneable values", () => {
      const sessionId = kernel.createSession({
        bindings: { a: 1, b: [1, 2, 3], c: { nested: true } },
      });

      const snapshot = kernel.snapshotSession(sessionId);

      assert.ok(snapshot);
      assert.strictEqual(snapshot["a"], 1);
      assert.deepStrictEqual(snapshot["b"], [1, 2, 3]);
      assert.deepStrictEqual(snapshot["c"], { nested: true });
    });

    it("should return null when scope contains functions", () => {
      const sessionId = kernel.createSession({
        bindings: { fn: () => {} },
      });

      const snapshot = kernel.snapshotSession(sessionId);

      assert.strictEqual(snapshot, null);
    });

    it("should throw for nonexistent session", () => {
      assert.throws(
        () => {
          kernel.snapshotSession("nonexistent");
        },
        { message: "Session nonexistent not found" }
      );
    });
  });

  describe("forkSession", () => {
    it("should create new session with copied scope", () => {
      const originalId = kernel.createSession({
        bindings: { value: 42 },
      });

      const forkedId = kernel.forkSession(originalId);

      assert.notStrictEqual(originalId, forkedId);
      const forkedScope = kernel.getScope(forkedId);
      assert.strictEqual(forkedScope["value"], 42);
    });

    it("should isolate forked session from original", () => {
      const originalId = kernel.createSession({
        bindings: { value: 1 },
      });

      const forkedId = kernel.forkSession(originalId);

      // Modify original
      kernel.injectBindings(originalId, { value: 999 });

      // Forked should be unchanged
      const forkedScope = kernel.getScope(forkedId);
      assert.strictEqual(forkedScope["value"], 1);
    });

    it("should allow adding bindings when forking", () => {
      const originalId = kernel.createSession({
        bindings: { original: true },
      });

      const forkedId = kernel.forkSession(originalId, {
        bindings: { added: "new" },
      });

      const forkedScope = kernel.getScope(forkedId);
      assert.strictEqual(forkedScope["original"], true);
      assert.strictEqual(forkedScope["added"], "new");
    });

    it("should throw for nonexistent session", () => {
      assert.throws(
        () => {
          kernel.forkSession("nonexistent");
        },
        { message: "Session nonexistent not found" }
      );
    });

    it("should handle sessions with functions via shallow copy", () => {
      const fn = () => 42;
      const nested = { deep: true };
      const originalId = kernel.createSession({
        bindings: { fn, value: 1, nested },
      });

      const forkedId = kernel.forkSession(originalId);

      const forkedScope = kernel.getScope(forkedId);
      // Function should be shared (same reference)
      assert.strictEqual(forkedScope["fn"], fn);
      // Primitives are copied
      assert.strictEqual(forkedScope["value"], 1);
      // Nested objects are shallow copied (SAME reference - not deep cloned)
      const originalSession = kernel.getSession(originalId)!;
      const forkedSession = kernel.getSession(forkedId)!;
      assert.strictEqual(forkedSession.scope["nested"], originalSession.scope["nested"]);
      assert.deepStrictEqual(forkedScope["nested"], { deep: true });
    });

    it("should copy mutableKeys to forked session", async () => {
      const originalId = kernel.createSession();
      await kernel.execute(originalId, "let mutableVar = 1;");

      const forkedId = kernel.forkSession(originalId);

      const forkedSession = kernel.getSession(forkedId);
      assert.ok(forkedSession?.mutableKeys.has("mutableVar"));
    });
  });

  describe("KernelOptions", () => {
    it("should accept CDN option", () => {
      const customKernel = new NotebookKernel({
        cdn: "https://custom.cdn",
      });

      assert.ok(customKernel);
    });

    it("should accept forwardConsole option", () => {
      const customKernel = new NotebookKernel({
        forwardConsole: true,
      });

      assert.ok(customKernel);
    });

    it("should accept defaultTimeout option", () => {
      const customKernel = new NotebookKernel({
        defaultTimeout: 5000,
      });

      assert.ok(customKernel);
    });
  });

  describe("complex scenarios", () => {
    it("should support building state across multiple cells", async () => {
      const sessionId = kernel.createSession();

      await kernel.execute(sessionId, "const items = [];");
      await kernel.execute(sessionId, "items.push(1);");
      await kernel.execute(sessionId, "items.push(2);");
      await kernel.execute(sessionId, "items.push(3);");

      const result = await kernel.execute(sessionId, "console.log(items);");

      assert.deepStrictEqual(result.output[0]!.args, [[1, 2, 3]]);
    });

    it("should support defining and using functions across cells", async () => {
      const sessionId = kernel.createSession();

      await kernel.execute(sessionId, "function double(x) { return x * 2; }");
      const result = await kernel.execute(sessionId, "console.log(double(21));");

      assert.deepStrictEqual(result.output[0]!.args, [42]);
    });

    it("should support classes across cells", async () => {
      const sessionId = kernel.createSession();

      await kernel.execute(
        sessionId,
        "class Counter { constructor() { this.value = 0; } inc() { this.value++; } }"
      );
      await kernel.execute(sessionId, "const counter = new Counter();");
      await kernel.execute(sessionId, "counter.inc(); counter.inc(); counter.inc();");
      const result = await kernel.execute(sessionId, "console.log(counter.value);");

      assert.deepStrictEqual(result.output[0]!.args, [3]);
    });

    it("should make __exports__ available in cell code", async () => {
      const sessionId = kernel.createSession();

      // The __exports__ object should be accessible
      const result = await kernel.execute(
        sessionId,
        "Object.assign(__exports__, { test: 42 }); console.log(__exports__.test);"
      );

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.output[0]!.args, [42]);
    });
  });
});
