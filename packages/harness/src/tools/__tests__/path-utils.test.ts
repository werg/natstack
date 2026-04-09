import { describe, it, expect } from "vitest";
import { resolveToCwd, resolveReadPath, expandPath } from "../path-utils.js";

describe("path-utils", () => {
  it("resolveToCwd: relative path joined with cwd", () => {
    expect(resolveToCwd("foo.txt", "/work/ctx")).toBe("/work/ctx/foo.txt");
    expect(resolveToCwd("./sub/bar", "/work/ctx")).toBe("/work/ctx/sub/bar");
  });

  it("resolveToCwd: absolute path passes through", () => {
    expect(resolveToCwd("/abs/path.md", "/work/ctx")).toBe("/abs/path.md");
  });

  it("resolveToCwd: strips @ prefix", () => {
    expect(resolveToCwd("@foo.txt", "/work/ctx")).toBe("/work/ctx/foo.txt");
  });

  it("resolveReadPath: identical to resolveToCwd in workerd port", () => {
    expect(resolveReadPath("foo.txt", "/work/ctx")).toBe(
      resolveToCwd("foo.txt", "/work/ctx"),
    );
  });

  it("expandPath: normalises unicode whitespace", () => {
    // U+00A0 NBSP between words should become a regular space.
    const input = "foo\u00A0bar.txt";
    expect(expandPath(input)).toBe("foo bar.txt");
  });
});
