import { describe, it, expect } from "vitest";
import { redactToken, redactTokenIn } from "./redact.js";

describe("redactToken", () => {
  it("masks long tokens to prefix…suffix", () => {
    expect(redactToken("abcdef1234567890")).toBe("abcd…7890");
  });
  it("returns ellipsis for short tokens", () => {
    expect(redactToken("abc")).toBe("…");
    expect(redactToken("abcdefgh")).toBe("…");
  });
  it("returns (none) for nullish", () => {
    expect(redactToken(undefined)).toBe("(none)");
    expect(redactToken(null)).toBe("(none)");
    expect(redactToken("")).toBe("(none)");
  });
});

describe("redactTokenIn", () => {
  it("redacts the token inside a string", () => {
    const tok = "abcdef1234567890";
    const line = `auth failed for token=${tok} in handler`;
    expect(redactTokenIn(line, tok)).toBe(`auth failed for token=abcd…7890 in handler`);
  });
  it("leaves text unchanged when token absent", () => {
    expect(redactTokenIn("nothing to see here", "abcdef1234567890"))
      .toBe("nothing to see here");
  });
  it("is a no-op for short/empty tokens", () => {
    expect(redactTokenIn("abc", "xyz")).toBe("abc");
    expect(redactTokenIn("abc", undefined)).toBe("abc");
  });
});
