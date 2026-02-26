import { createLogger, formatArgsForLog, isMessageTargetedAt } from "./responder-utils.js";

describe("createLogger", () => {
  it("returns a function that logs with the given prefix", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("TestPrefix");
    log("hello world");
    expect(logSpy).toHaveBeenCalledWith("[TestPrefix] hello world");
    logSpy.mockRestore();
  });

  it("includes workerId in the prefix when provided", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger("Agent", "worker-42");
    log("starting");
    expect(logSpy).toHaveBeenCalledWith("[Agent worker-42] starting");
    logSpy.mockRestore();
  });
});

describe("formatArgsForLog", () => {
  it("formats a normal object as JSON", () => {
    const result = formatArgsForLog({ foo: "bar", num: 42 });
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
    expect(result).toContain("42");
  });

  it("handles circular references by replacing with [Circular]", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = formatArgsForLog(obj);
    expect(result).toContain("[Circular]");
  });

  it("truncates output at maxLen", () => {
    const longObj = { data: "x".repeat(3000) };
    const result = formatArgsForLog(longObj, 50);
    expect(result.length).toBeLessThanOrEqual(53); // 50 + "..."
    expect(result).toMatch(/\.\.\.$/);
  });

  it("returns '<empty>' for undefined input", () => {
    expect(formatArgsForLog(undefined)).toBe("<empty>");
  });
});

describe("isMessageTargetedAt", () => {
  it("returns true when at is undefined (broadcast)", () => {
    const msg = { at: undefined } as { at?: string[] };
    expect(isMessageTargetedAt(msg as any, "participant-1")).toBe(true);
  });

  it("returns true when at is empty array (broadcast)", () => {
    const msg = { at: [] } as { at?: string[] };
    expect(isMessageTargetedAt(msg as any, "participant-1")).toBe(true);
  });

  it("returns true when at includes the participantId", () => {
    const msg = { at: ["participant-1", "participant-2"] } as { at?: string[] };
    expect(isMessageTargetedAt(msg as any, "participant-1")).toBe(true);
  });

  it("returns false when at does not include the participantId", () => {
    const msg = { at: ["participant-2", "participant-3"] } as { at?: string[] };
    expect(isMessageTargetedAt(msg as any, "participant-1")).toBe(false);
  });
});
