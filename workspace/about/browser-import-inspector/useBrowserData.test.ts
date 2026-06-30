import { describe, expect, it } from "vitest";
import { classifyError, relativeTime, mask } from "./format";

describe("classifyError", () => {
  it("maps EACCES to denied", () => {
    expect(classifyError(Object.assign(new Error("nope"), { code: "EACCES" }))).toEqual({
      status: "denied",
      message: "nope",
    });
  });

  it("maps 'denied by user' messages to denied", () => {
    expect(classifyError(new Error("browser-data.getCookies denied by user")).status).toBe("denied");
  });

  it("maps other errors to error", () => {
    expect(classifyError(new Error("boom")).status).toBe("error");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("returns never for nullish", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(0, now)).toBe("never");
  });
  it("formats minutes and hours", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
  it("formats days", () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("mask", () => {
  it("hides by default and reveals when asked", () => {
    expect(mask("supersecret", false)).toMatch(/^•+$/);
    expect(mask("supersecret", true)).toBe("supersecret");
  });
  it("returns empty for empty input", () => {
    expect(mask("", false)).toBe("");
  });
});
