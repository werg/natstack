import { describe, it, expect } from "vitest";
import { resolveWithinContext, validateFilePathWithinRoot, validateProjectName } from "../../../shared/contextPaths";

describe("resolveWithinContext", () => {
  const root = "/workspace/.contexts/abc";

  it("resolves a valid relative path", () => {
    expect(resolveWithinContext(root, "panels/my-app")).toBe(
      "/workspace/.contexts/abc/panels/my-app",
    );
  });

  it("resolves nested paths", () => {
    expect(resolveWithinContext(root, "panels/my-app/src/index.tsx")).toBe(
      "/workspace/.contexts/abc/panels/my-app/src/index.tsx",
    );
  });

  it("returns the root itself for empty-ish paths", () => {
    expect(resolveWithinContext(root, ".")).toBe(root);
  });

  it("throws on directory traversal", () => {
    expect(() => resolveWithinContext(root, "../../etc/passwd")).toThrow(
      "Path escapes context root",
    );
  });

  it("throws on absolute path outside root", () => {
    expect(() => resolveWithinContext(root, "/etc/passwd")).toThrow(
      "Path escapes context root",
    );
  });
});

describe("validateProjectName", () => {
  it("accepts valid names", () => {
    expect(() => validateProjectName("my-app")).not.toThrow();
    expect(() => validateProjectName("utils")).not.toThrow();
    expect(() => validateProjectName("my_app_v2")).not.toThrow();
  });

  it("rejects empty name", () => {
    expect(() => validateProjectName("")).toThrow("Invalid project name");
  });

  it("rejects '.'", () => {
    expect(() => validateProjectName(".")).toThrow("Invalid project name");
  });

  it("rejects '..'", () => {
    expect(() => validateProjectName("..")).toThrow("Invalid project name");
  });

  it("rejects forward slashes", () => {
    expect(() => validateProjectName("a/b")).toThrow("path separators");
  });

  it("rejects backslashes", () => {
    expect(() => validateProjectName("a\\b")).toThrow("path separators");
  });

  it("rejects names containing '..'", () => {
    expect(() => validateProjectName("foo..bar")).toThrow("must not contain '..'");
  });

  it("rejects names with spaces", () => {
    expect(() => validateProjectName("my app")).toThrow("must start with a lowercase letter");
  });

  it("rejects names starting with a digit", () => {
    expect(() => validateProjectName("2fast")).toThrow("must start with a lowercase letter");
  });

  it("rejects uppercase names", () => {
    expect(() => validateProjectName("MyApp")).toThrow("must start with a lowercase letter");
  });

  it("rejects names with special characters", () => {
    expect(() => validateProjectName("my@app")).toThrow("must start with a lowercase letter");
  });

  it("rejects names starting with a hyphen", () => {
    expect(() => validateProjectName("-app")).toThrow("must start with a lowercase letter");
  });
});

describe("validateFilePathWithinRoot", () => {
  const panelRoot = "/workspace/.contexts/abc/panels/my-app";

  it("accepts a valid relative file path", () => {
    expect(() => validateFilePathWithinRoot(panelRoot, "src/index.tsx")).not.toThrow();
  });

  it("accepts nested paths", () => {
    expect(() => validateFilePathWithinRoot(panelRoot, "src/components/Button.tsx")).not.toThrow();
  });

  it("throws on directory traversal escaping panel root", () => {
    expect(() => validateFilePathWithinRoot(panelRoot, "../../other-panel/secrets.ts")).toThrow(
      "file_path escapes panel root",
    );
  });

  it("throws on absolute path outside panel root", () => {
    expect(() => validateFilePathWithinRoot(panelRoot, "/etc/passwd")).toThrow(
      "file_path escapes panel root",
    );
  });

  it("allows path resolving to the root itself", () => {
    expect(() => validateFilePathWithinRoot(panelRoot, ".")).not.toThrow();
  });
});
