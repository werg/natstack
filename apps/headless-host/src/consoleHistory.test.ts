import { describe, expect, it } from "vitest";
import { ConsoleHistoryStore, levelFromConsoleType } from "./consoleHistory.js";

function entry(level: "info" | "error" | "warning", message: string) {
  return { timestamp: 1, level, message, line: 0, sourceId: "", url: "" } as const;
}

describe("ConsoleHistoryStore", () => {
  it("keeps entries and errors with capacities and dropped counters", () => {
    const store = new ConsoleHistoryStore();
    for (let index = 0; index < 1_005; index += 1) {
      store.record("p1", entry("info", `m${index}`));
    }
    const result = store.query("p1");
    expect(result.entries).toHaveLength(1_000);
    expect(result.entries[0]?.message).toBe("m5");
    expect(result.dropped.entries).toBe(5);
    expect(result.capacity).toEqual({ entries: 1_000, errors: 500 });
  });

  it("filters by level and honors limits", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", entry("info", "a"));
    store.record("p1", entry("error", "boom"));
    store.record("p1", entry("warning", "careful"));
    const errorsOnly = store.query("p1", { levels: ["error"] });
    expect(errorsOnly.entries.map((e) => e.message)).toEqual(["boom"]);
    expect(store.query("p1", { limit: 1 }).entries.map((e) => e.message)).toEqual(["careful"]);
    expect(store.query("p1").errors.map((e) => e.message)).toEqual(["boom"]);
  });

  it("records lifecycle events as error-level lifecycle entries", () => {
    const store = new ConsoleHistoryStore();
    store.recordLifecycle("p1", "render-process-gone: target crashed");
    const result = store.query("p1");
    expect(result.errors[0]?.source).toBe("lifecycle");
    expect(result.errors[0]?.message).toContain("render-process-gone");
  });

  it("clear() drops a panel's history", () => {
    const store = new ConsoleHistoryStore();
    store.record("p1", entry("info", "a"));
    store.clear("p1");
    expect(store.query("p1").entries).toHaveLength(0);
  });

  it("maps CDP console types to levels", () => {
    expect(levelFromConsoleType("log")).toBe("info");
    expect(levelFromConsoleType("warning")).toBe("warning");
    expect(levelFromConsoleType("assert")).toBe("error");
    expect(levelFromConsoleType("weird")).toBe("unknown");
  });
});
