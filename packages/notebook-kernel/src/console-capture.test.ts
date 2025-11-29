import { describe, it } from "node:test";
import assert from "node:assert";
import { createConsoleCapture } from "./console-capture.js";

describe("createConsoleCapture", () => {
  it("should capture console.log calls", () => {
    const capture = createConsoleCapture();

    capture.proxy.log("hello", "world");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "log");
    assert.deepStrictEqual(output[0]!.args, ["hello", "world"]);
    assert.ok(typeof output[0]!.timestamp === "number");
  });

  it("should capture console.warn calls", () => {
    const capture = createConsoleCapture();

    capture.proxy.warn("warning message");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "warn");
    assert.deepStrictEqual(output[0]!.args, ["warning message"]);
  });

  it("should capture console.error calls", () => {
    const capture = createConsoleCapture();

    capture.proxy.error("error message", { code: 500 });

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "error");
    assert.deepStrictEqual(output[0]!.args, ["error message", { code: 500 }]);
  });

  it("should capture console.info calls", () => {
    const capture = createConsoleCapture();

    capture.proxy.info("info message");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "info");
  });

  it("should capture console.debug calls", () => {
    const capture = createConsoleCapture();

    capture.proxy.debug("debug message");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "debug");
  });

  it("should capture multiple calls in order", () => {
    const capture = createConsoleCapture();

    capture.proxy.log("first");
    capture.proxy.warn("second");
    capture.proxy.error("third");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 3);
    assert.deepStrictEqual(output[0]!.args, ["first"]);
    assert.deepStrictEqual(output[1]!.args, ["second"]);
    assert.deepStrictEqual(output[2]!.args, ["third"]);
  });

  it("should return a copy of output array", () => {
    const capture = createConsoleCapture();

    capture.proxy.log("test");

    const output1 = capture.getOutput();
    const output2 = capture.getOutput();

    assert.notStrictEqual(output1, output2);
    assert.deepStrictEqual(output1, output2);
  });

  it("should clear output when clear() is called", () => {
    const capture = createConsoleCapture();

    capture.proxy.log("test1");
    capture.proxy.log("test2");

    assert.strictEqual(capture.getOutput().length, 2);

    capture.clear();

    assert.strictEqual(capture.getOutput().length, 0);
  });

  it("should handle console.assert with false condition", () => {
    const capture = createConsoleCapture();

    capture.proxy.assert(false, "assertion failed");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    assert.strictEqual(output[0]!.level, "error");
    assert.deepStrictEqual(output[0]!.args, ["Assertion failed:", "assertion failed"]);
  });

  it("should not log on console.assert with true condition", () => {
    const capture = createConsoleCapture();

    capture.proxy.assert(true, "should not appear");

    const output = capture.getOutput();
    assert.strictEqual(output.length, 0);
  });

  it("should handle various data types", () => {
    const capture = createConsoleCapture();

    const obj = { key: "value" };
    const arr = [1, 2, 3];
    const fn = () => {};

    capture.proxy.log(obj, arr, fn, null, undefined, 42, true);

    const output = capture.getOutput();
    assert.strictEqual(output.length, 1);
    const entry = output[0]!;
    assert.strictEqual(entry.args.length, 7);
    assert.deepStrictEqual(entry.args[0], obj);
    assert.deepStrictEqual(entry.args[1], arr);
    assert.strictEqual(typeof entry.args[2], "function");
    assert.strictEqual(entry.args[3], null);
    assert.strictEqual(entry.args[4], undefined);
    assert.strictEqual(entry.args[5], 42);
    assert.strictEqual(entry.args[6], true);
  });

  it("should have timestamps that increase", async () => {
    const capture = createConsoleCapture();

    capture.proxy.log("first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    capture.proxy.log("second");

    const output = capture.getOutput();
    assert.ok(output[1]!.timestamp >= output[0]!.timestamp);
  });

  describe("console.count", () => {
    it("should count with default label", () => {
      const capture = createConsoleCapture();

      capture.proxy.count();
      capture.proxy.count();
      capture.proxy.count();

      const output = capture.getOutput();
      assert.strictEqual(output.length, 3);
      assert.deepStrictEqual(output[0]!.args, ["default: 1"]);
      assert.deepStrictEqual(output[1]!.args, ["default: 2"]);
      assert.deepStrictEqual(output[2]!.args, ["default: 3"]);
    });

    it("should count with custom label", () => {
      const capture = createConsoleCapture();

      capture.proxy.count("myCounter");
      capture.proxy.count("myCounter");

      const output = capture.getOutput();
      assert.deepStrictEqual(output[0]!.args, ["myCounter: 1"]);
      assert.deepStrictEqual(output[1]!.args, ["myCounter: 2"]);
    });

    it("should reset counts with countReset", () => {
      const capture = createConsoleCapture();

      capture.proxy.count("test");
      capture.proxy.count("test");
      capture.proxy.countReset("test");
      capture.proxy.count("test");

      const output = capture.getOutput();
      assert.deepStrictEqual(output[2]!.args, ["test: 1"]);
    });
  });

  describe("console.time", () => {
    it("should track timing with time/timeEnd", async () => {
      const capture = createConsoleCapture();

      capture.proxy.time("test");
      await new Promise((resolve) => setTimeout(resolve, 10));
      capture.proxy.timeEnd("test");

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.ok((output[0]!.args[0] as string).startsWith("test:"));
      assert.ok((output[0]!.args[0] as string).includes("ms"));
    });

    it("should support timeLog for intermediate timing", async () => {
      const capture = createConsoleCapture();

      capture.proxy.time("test");
      await new Promise((resolve) => setTimeout(resolve, 5));
      capture.proxy.timeLog("test", "checkpoint");
      await new Promise((resolve) => setTimeout(resolve, 5));
      capture.proxy.timeEnd("test");

      const output = capture.getOutput();
      assert.strictEqual(output.length, 2);
      assert.ok((output[0]!.args[0] as string).startsWith("test:"));
      assert.strictEqual(output[0]!.args[1], "checkpoint");
    });

    it("should warn when timer does not exist", () => {
      const capture = createConsoleCapture();

      capture.proxy.timeEnd("nonexistent");

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0]!.level, "warn");
      assert.ok((output[0]!.args[0] as string).includes("nonexistent"));
    });

    it("should warn when timer already exists", () => {
      const capture = createConsoleCapture();

      capture.proxy.time("duplicate");
      capture.proxy.time("duplicate");

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0]!.level, "warn");
    });
  });

  describe("console.group", () => {
    it("should indent output within groups", () => {
      const capture = createConsoleCapture();

      capture.proxy.log("outside");
      capture.proxy.group("Group 1");
      capture.proxy.log("inside group");
      capture.proxy.groupEnd();
      capture.proxy.log("outside again");

      const output = capture.getOutput();
      // The group label is logged
      assert.deepStrictEqual(output[0]!.args, ["outside"]);
      assert.deepStrictEqual(output[1]!.args, ["Group 1"]);
      // Inside group has indentation
      assert.ok((output[2]!.args[0] as string).includes("  "));
      // Outside has no indentation
      assert.deepStrictEqual(output[3]!.args, ["outside again"]);
    });

    it("should support nested groups", () => {
      const capture = createConsoleCapture();

      capture.proxy.group("Level 1");
      capture.proxy.log("at level 1");
      capture.proxy.group("Level 2");
      capture.proxy.log("at level 2");
      capture.proxy.groupEnd();
      capture.proxy.log("back to level 1");
      capture.proxy.groupEnd();
      capture.proxy.log("outside");

      const output = capture.getOutput();
      // Level 2 should have more indentation than level 1
      const level1Log = output[1]!.args[0] as string;
      const level2Log = output[3]!.args[0] as string;
      // Both should have indentation, level 2 should have more
      assert.ok(level1Log.startsWith("  "));
      assert.ok(level2Log.startsWith("    "));
    });

    it("should handle groupCollapsed same as group", () => {
      const capture = createConsoleCapture();

      capture.proxy.groupCollapsed("Collapsed Group");
      capture.proxy.log("inside");
      capture.proxy.groupEnd();

      const output = capture.getOutput();
      assert.ok((output[0]!.args[0] as string).includes("[collapsed]"));
    });
  });

  describe("console.trace", () => {
    it("should include stack trace", () => {
      const capture = createConsoleCapture();

      capture.proxy.trace("trace message");

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0]!.level, "debug");
      // Should have the message and a newline with stack
      assert.strictEqual(output[0]!.args[0], "trace message");
      assert.ok((output[0]!.args[1] as string).includes("\n"));
    });
  });

  describe("console.table", () => {
    it("should log array data", () => {
      const capture = createConsoleCapture();

      capture.proxy.table([1, 2, 3]);

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0]!.level, "log");
      assert.deepStrictEqual(output[0]!.args, ["Table:", [1, 2, 3]]);
    });

    it("should log object data", () => {
      const capture = createConsoleCapture();

      capture.proxy.table({ a: 1, b: 2 });

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.deepStrictEqual(output[0]!.args, ["Table:", { a: 1, b: 2 }]);
    });

    it("should filter array of objects by columns", () => {
      const capture = createConsoleCapture();

      const data = [
        { name: "Alice", age: 30, city: "NYC" },
        { name: "Bob", age: 25, city: "LA" },
      ];
      capture.proxy.table(data, ["name", "age"]);

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.deepStrictEqual(output[0]!.args, [
        "Table:",
        [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      ]);
    });

    it("should filter object by columns", () => {
      const capture = createConsoleCapture();

      capture.proxy.table({ a: 1, b: 2, c: 3 }, ["a", "c"]);

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      assert.deepStrictEqual(output[0]!.args, ["Table:", { a: 1, c: 3 }]);
    });

    it("should handle non-object array items when filtering", () => {
      const capture = createConsoleCapture();

      capture.proxy.table([1, 2, 3], ["a"]);

      const output = capture.getOutput();
      assert.strictEqual(output.length, 1);
      // Non-object items are passed through unchanged
      assert.deepStrictEqual(output[0]!.args, ["Table:", [1, 2, 3]]);
    });
  });

  describe("clear resets state", () => {
    it("should reset counters on clear", () => {
      const capture = createConsoleCapture();

      capture.proxy.count("test");
      capture.proxy.count("test");
      capture.clear();
      capture.proxy.count("test");

      const output = capture.getOutput();
      assert.deepStrictEqual(output[0]!.args, ["test: 1"]);
    });

    it("should reset timers on clear", () => {
      const capture = createConsoleCapture();

      capture.proxy.time("test");
      capture.clear();
      capture.proxy.timeEnd("test");

      const output = capture.getOutput();
      // Should warn that timer doesn't exist
      assert.strictEqual(output[0]!.level, "warn");
    });

    it("should reset group depth on clear", () => {
      const capture = createConsoleCapture();

      capture.proxy.group();
      capture.proxy.group();
      capture.clear();
      capture.proxy.log("no indent");

      const output = capture.getOutput();
      assert.deepStrictEqual(output[0]!.args, ["no indent"]);
    });
  });
});
