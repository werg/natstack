/**
 * Tests for console capture functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConsoleCapture } from "./console-capture.js";

describe("createConsoleCapture", () => {
  let originalConsole: Console;

  beforeEach(() => {
    originalConsole = { ...console };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.assign(console, originalConsole);
  });

  describe("basic logging", () => {
    it("should capture console.log calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("hello", "world");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("log");
      expect(output[0].args).toEqual(["hello", "world"]);
    });

    it("should capture console.warn calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.warn("warning message");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("warn");
      expect(output[0].args).toEqual(["warning message"]);
    });

    it("should capture console.error calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.error("error message");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("error");
      expect(output[0].args).toEqual(["error message"]);
    });

    it("should capture console.info calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.info("info message");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("info");
    });

    it("should capture console.debug calls", () => {
      const capture = createConsoleCapture();
      capture.proxy.debug("debug message");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("debug");
    });

    it("should capture multiple calls in order", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("first");
      capture.proxy.warn("second");
      capture.proxy.error("third");

      const output = capture.getOutput();
      expect(output).toHaveLength(3);
      expect(output[0].args).toEqual(["first"]);
      expect(output[1].args).toEqual(["second"]);
      expect(output[2].args).toEqual(["third"]);
    });

    it("should include timestamp", () => {
      vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
      const capture = createConsoleCapture();
      capture.proxy.log("test");

      const output = capture.getOutput();
      expect(output[0].timestamp).toBe(Date.now());
    });
  });

  describe("forwarding", () => {
    it("should not forward by default", () => {
      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const capture = createConsoleCapture();
      capture.proxy.log("test");

      expect(mockLog).not.toHaveBeenCalled();
      mockLog.mockRestore();
    });

    it("should forward when forward option is true", () => {
      const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const capture = createConsoleCapture({ forward: true });
      capture.proxy.log("forwarded");

      expect(mockLog).toHaveBeenCalledWith("forwarded");
      mockLog.mockRestore();
    });
  });

  describe("trace", () => {
    it("should capture trace with stack", () => {
      const capture = createConsoleCapture();
      capture.proxy.trace("trace message");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("debug");
      expect(output[0].args[0]).toBe("trace message");
      // Stack trace should be included
      expect(output[0].args[1]).toMatch(/\n/);
    });
  });

  describe("dir and dirxml", () => {
    it("should capture dir as log", () => {
      const capture = createConsoleCapture();
      capture.proxy.dir({ key: "value" });

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("log");
      expect(output[0].args).toEqual([{ key: "value" }]);
    });

    it("should capture dirxml as log", () => {
      const capture = createConsoleCapture();
      capture.proxy.dirxml("xml content");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("log");
    });
  });

  describe("table", () => {
    it("should capture array data", () => {
      const capture = createConsoleCapture();
      const data = [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ];
      capture.proxy.table(data);

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("log");
      expect(output[0].args).toEqual(["Table:", data]);
    });

    it("should filter columns for array data", () => {
      const capture = createConsoleCapture();
      const data = [
        { name: "Alice", age: 30, city: "NYC" },
        { name: "Bob", age: 25, city: "LA" },
      ];
      capture.proxy.table(data, ["name", "age"]);

      const output = capture.getOutput();
      expect(output[0].args[1]).toEqual([
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ]);
    });

    it("should capture object data", () => {
      const capture = createConsoleCapture();
      const data = { a: 1, b: 2 };
      capture.proxy.table(data);

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["Table:", data]);
    });

    it("should filter columns for object data", () => {
      const capture = createConsoleCapture();
      const data = { a: 1, b: 2, c: 3 };
      capture.proxy.table(data, ["a", "c"]);

      const output = capture.getOutput();
      expect(output[0].args[1]).toEqual({ a: 1, c: 3 });
    });

    it("should handle primitive data", () => {
      const capture = createConsoleCapture();
      capture.proxy.table("primitive");

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["primitive"]);
    });

    it("should handle empty array", () => {
      const capture = createConsoleCapture();
      capture.proxy.table([]);

      const output = capture.getOutput();
      // Empty array still gets "Table:" prefix from the else branch
      expect(output[0].args).toEqual(["Table:", []]);
    });
  });

  describe("count and countReset", () => {
    it("should count with default label", () => {
      const capture = createConsoleCapture();
      capture.proxy.count();
      capture.proxy.count();
      capture.proxy.count();

      const output = capture.getOutput();
      expect(output).toHaveLength(3);
      expect(output[0].args).toEqual(["default: 1"]);
      expect(output[1].args).toEqual(["default: 2"]);
      expect(output[2].args).toEqual(["default: 3"]);
    });

    it("should count with custom label", () => {
      const capture = createConsoleCapture();
      capture.proxy.count("myCounter");
      capture.proxy.count("myCounter");

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["myCounter: 1"]);
      expect(output[1].args).toEqual(["myCounter: 2"]);
    });

    it("should track multiple labels independently", () => {
      const capture = createConsoleCapture();
      capture.proxy.count("a");
      capture.proxy.count("b");
      capture.proxy.count("a");

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["a: 1"]);
      expect(output[1].args).toEqual(["b: 1"]);
      expect(output[2].args).toEqual(["a: 2"]);
    });

    it("should reset counter", () => {
      const capture = createConsoleCapture();
      capture.proxy.count("x");
      capture.proxy.count("x");
      capture.proxy.countReset("x");
      capture.proxy.count("x");

      const output = capture.getOutput();
      expect(output[2].args).toEqual(["x: 1"]);
    });
  });

  describe("group, groupCollapsed, groupEnd", () => {
    it("should indent grouped messages", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("before group");
      capture.proxy.group("Group Label");
      capture.proxy.log("inside group");
      capture.proxy.groupEnd();
      capture.proxy.log("after group");

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["before group"]);
      expect(output[1].args).toEqual(["Group Label"]);
      expect(output[2].args).toEqual(["  ", "inside group"]);
      expect(output[3].args).toEqual(["after group"]);
    });

    it("should handle nested groups", () => {
      const capture = createConsoleCapture();
      capture.proxy.group("Outer");
      capture.proxy.log("level 1");
      capture.proxy.group("Inner");
      capture.proxy.log("level 2");
      capture.proxy.groupEnd();
      capture.proxy.log("back to level 1");
      capture.proxy.groupEnd();
      capture.proxy.log("outside");

      const output = capture.getOutput();
      expect(output[1].args).toEqual(["  ", "level 1"]);
      expect(output[3].args).toEqual(["    ", "level 2"]);
      expect(output[4].args).toEqual(["  ", "back to level 1"]);
      expect(output[5].args).toEqual(["outside"]);
    });

    it("should handle groupCollapsed", () => {
      const capture = createConsoleCapture();
      capture.proxy.groupCollapsed("Collapsed");
      capture.proxy.log("inside");
      capture.proxy.groupEnd();

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["[collapsed]", "Collapsed"]);
      expect(output[1].args).toEqual(["  ", "inside"]);
    });

    it("should not go below zero depth", () => {
      const capture = createConsoleCapture();
      capture.proxy.groupEnd(); // Extra groupEnd
      capture.proxy.log("test");

      const output = capture.getOutput();
      // Should not have indentation
      expect(output[0].args).toEqual(["test"]);
    });

    it("should handle empty group labels", () => {
      const capture = createConsoleCapture();
      capture.proxy.group();
      capture.proxy.log("inside");
      capture.proxy.groupEnd();

      // Empty group should not log a label
      const output = capture.getOutput();
      expect(output[0].args).toEqual(["  ", "inside"]);
    });
  });

  describe("time, timeLog, timeEnd", () => {
    it("should track timing with default label", () => {
      vi.useFakeTimers();
      const capture = createConsoleCapture();

      capture.proxy.time();
      vi.advanceTimersByTime(100);
      capture.proxy.timeEnd();

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].args[0]).toMatch(/^default: \d+\.\d+ms$/);
    });

    it("should track timing with custom label", () => {
      vi.useFakeTimers();
      const capture = createConsoleCapture();

      capture.proxy.time("myTimer");
      vi.advanceTimersByTime(50);
      capture.proxy.timeEnd("myTimer");

      const output = capture.getOutput();
      expect(output[0].args[0]).toMatch(/^myTimer: \d+\.\d+ms$/);
    });

    it("should log intermediate time with timeLog", () => {
      vi.useFakeTimers();
      const capture = createConsoleCapture();

      capture.proxy.time("timer");
      vi.advanceTimersByTime(25);
      capture.proxy.timeLog("timer", "checkpoint");
      vi.advanceTimersByTime(25);
      capture.proxy.timeEnd("timer");

      const output = capture.getOutput();
      expect(output).toHaveLength(2);
      expect(output[0].args[1]).toBe("checkpoint");
    });

    it("should warn when starting duplicate timer", () => {
      const capture = createConsoleCapture();
      capture.proxy.time("dup");
      capture.proxy.time("dup");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("warn");
      expect(output[0].args[0]).toContain("already exists");
    });

    it("should warn when ending non-existent timer", () => {
      const capture = createConsoleCapture();
      capture.proxy.timeEnd("nonexistent");

      const output = capture.getOutput();
      expect(output[0].level).toBe("warn");
      expect(output[0].args[0]).toContain("does not exist");
    });

    it("should warn when logging non-existent timer", () => {
      const capture = createConsoleCapture();
      capture.proxy.timeLog("nonexistent");

      const output = capture.getOutput();
      expect(output[0].level).toBe("warn");
      expect(output[0].args[0]).toContain("does not exist");
    });
  });

  describe("timeStamp", () => {
    it("should capture timeStamp with label", () => {
      const capture = createConsoleCapture();
      capture.proxy.timeStamp("marker");

      const output = capture.getOutput();
      expect(output[0].level).toBe("debug");
      expect(output[0].args[0]).toBe("TimeStamp: marker");
    });

    it("should capture timeStamp without label", () => {
      vi.setSystemTime(new Date("2024-01-15T10:00:00Z"));
      const capture = createConsoleCapture();
      capture.proxy.timeStamp();

      const output = capture.getOutput();
      expect(output[0].args[0]).toMatch(/^TimeStamp: \d+$/);
    });
  });

  describe("clear", () => {
    it("should log clear message", () => {
      const capture = createConsoleCapture();
      capture.proxy.clear();

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["Console was cleared"]);
    });
  });

  describe("assert", () => {
    it("should not log when assertion passes", () => {
      const capture = createConsoleCapture();
      capture.proxy.assert(true, "should not appear");

      const output = capture.getOutput();
      expect(output).toHaveLength(0);
    });

    it("should log error when assertion fails", () => {
      const capture = createConsoleCapture();
      capture.proxy.assert(false, "assertion failed!");

      const output = capture.getOutput();
      expect(output).toHaveLength(1);
      expect(output[0].level).toBe("error");
      expect(output[0].args).toEqual(["Assertion failed:", "assertion failed!"]);
    });

    it("should handle falsy values", () => {
      const capture = createConsoleCapture();
      capture.proxy.assert(0 as unknown as boolean, "zero is falsy");
      capture.proxy.assert("" as unknown as boolean, "empty string is falsy");
      capture.proxy.assert(null as unknown as boolean, "null is falsy");
      capture.proxy.assert(undefined, "undefined is falsy");

      const output = capture.getOutput();
      expect(output).toHaveLength(4);
    });
  });

  describe("profile and profileEnd", () => {
    it("should be no-op functions", () => {
      const capture = createConsoleCapture();
      // Should not throw
      capture.proxy.profile("test");
      capture.proxy.profileEnd("test");

      const output = capture.getOutput();
      expect(output).toHaveLength(0);
    });
  });

  describe("getOutput", () => {
    it("should return a copy of the output array", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("test");

      const output1 = capture.getOutput();
      const output2 = capture.getOutput();

      expect(output1).not.toBe(output2);
      expect(output1).toEqual(output2);
    });
  });

  describe("clear method", () => {
    it("should clear captured output", () => {
      const capture = createConsoleCapture();
      capture.proxy.log("test");
      expect(capture.getOutput()).toHaveLength(1);

      capture.clear();
      expect(capture.getOutput()).toHaveLength(0);
    });

    it("should reset counters", () => {
      const capture = createConsoleCapture();
      capture.proxy.count("x");
      capture.proxy.count("x");
      capture.clear();
      capture.proxy.count("x");

      const output = capture.getOutput();
      expect(output[0].args).toEqual(["x: 1"]);
    });

    it("should reset timers", () => {
      const capture = createConsoleCapture();
      capture.proxy.time("t");
      capture.clear();
      capture.proxy.timeEnd("t");

      const output = capture.getOutput();
      expect(output[0].level).toBe("warn");
    });

    it("should reset group depth", () => {
      const capture = createConsoleCapture();
      capture.proxy.group("g");
      capture.proxy.group("nested");
      capture.clear();
      capture.proxy.log("test");

      const output = capture.getOutput();
      // Should not be indented
      expect(output[0].args).toEqual(["test"]);
    });
  });
});
