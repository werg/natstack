/**
 * Tests for PackageRegistry
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  getPackageRegistry,
  resetPackageRegistry,
  parseSpec,
  isGitSpec,
  isNpmSpec,
} from "./packages.js";

describe("parseSpec", () => {
  describe("git specs", () => {
    it("parses owner/repo#tag format", () => {
      const spec = parseSpec("user/lib#v1.0.0");
      expect(spec.gitSpec).toBe("user/lib#v1.0.0");
      expect(spec.npmSpec).toBeUndefined();
    });

    it("parses owner/repo@branch format", () => {
      const spec = parseSpec("user/lib@main");
      expect(spec.gitSpec).toBe("user/lib@main");
      expect(spec.npmSpec).toBeUndefined();
    });

    it("parses owner/repo@commit format", () => {
      const spec = parseSpec("user/lib@abc1234");
      expect(spec.gitSpec).toBe("user/lib@abc1234");
      expect(spec.npmSpec).toBeUndefined();
    });

    it("parses simple owner/repo format with default main branch", () => {
      const spec = parseSpec("user/lib");
      expect(spec.gitSpec).toBe("user/lib@main");
      expect(spec.npmSpec).toBeUndefined();
    });
  });

  describe("npm specs", () => {
    it("parses caret semver", () => {
      const spec = parseSpec("^1.2.3");
      expect(spec.npmSpec).toBe("^1.2.3");
      expect(spec.gitSpec).toBeUndefined();
    });

    it("parses tilde semver", () => {
      const spec = parseSpec("~1.2.3");
      expect(spec.npmSpec).toBe("~1.2.3");
      expect(spec.gitSpec).toBeUndefined();
    });

    it("parses exact version", () => {
      const spec = parseSpec("1.2.3");
      expect(spec.npmSpec).toBe("1.2.3");
      expect(spec.gitSpec).toBeUndefined();
    });

    it("parses range operators", () => {
      expect(parseSpec(">=1.0.0").npmSpec).toBe(">=1.0.0");
      expect(parseSpec("<=1.0.0").npmSpec).toBe("<=1.0.0");
      expect(parseSpec(">1.0.0").npmSpec).toBe(">1.0.0");
      expect(parseSpec("<1.0.0").npmSpec).toBe("<1.0.0");
    });

    it("parses wildcard", () => {
      expect(parseSpec("*").npmSpec).toBe("*");
    });

    it("parses latest", () => {
      expect(parseSpec("latest").npmSpec).toBe("latest");
    });
  });
});

describe("isGitSpec", () => {
  it("returns true for git specs", () => {
    expect(isGitSpec("user/lib#v1.0.0")).toBe(true);
    expect(isGitSpec("user/lib@main")).toBe(true);
    expect(isGitSpec("user/lib")).toBe(true);
  });

  it("returns false for npm specs", () => {
    expect(isGitSpec("^1.2.3")).toBe(false);
    expect(isGitSpec("~1.2.3")).toBe(false);
    expect(isGitSpec("1.2.3")).toBe(false);
    expect(isGitSpec("*")).toBe(false);
    expect(isGitSpec("latest")).toBe(false);
  });
});

describe("isNpmSpec", () => {
  it("returns true for npm specs", () => {
    expect(isNpmSpec("^1.2.3")).toBe(true);
    expect(isNpmSpec("~1.2.3")).toBe(true);
    expect(isNpmSpec("1.2.3")).toBe(true);
    expect(isNpmSpec("*")).toBe(true);
    expect(isNpmSpec("latest")).toBe(true);
  });

  it("returns false for git specs", () => {
    expect(isNpmSpec("user/lib#v1.0.0")).toBe(false);
    expect(isNpmSpec("user/lib@main")).toBe(false);
    expect(isNpmSpec("user/lib")).toBe(false);
  });
});

describe("PackageRegistry", () => {
  beforeEach(() => {
    resetPackageRegistry();
  });

  it("returns singleton instance", () => {
    const registry1 = getPackageRegistry();
    const registry2 = getPackageRegistry();
    expect(registry1).toBe(registry2);
  });

  describe("workspace packages", () => {
    it("sets and gets workspace packages", () => {
      const registry = getPackageRegistry();
      registry.set("my-lib", "user/lib#main");

      const spec = registry.get("my-lib");
      expect(spec).toBeDefined();
      expect(spec?.gitSpec).toBe("user/lib#main");
    });

    it("deletes workspace packages", () => {
      const registry = getPackageRegistry();
      registry.set("my-lib", "user/lib#main");
      registry.delete("my-lib");

      expect(registry.get("my-lib")).toBeUndefined();
    });

    it("returns all workspace packages", () => {
      const registry = getPackageRegistry();
      registry.set("lib-a", "user/a#main");
      registry.set("lib-b", "user/b@v1.0.0");

      const packages = registry.getWorkspacePackages();
      expect(packages).toEqual({
        "lib-a": "user/a#main",
        "lib-b": "user/b@v1.0.0",
      });
    });

    it("bulk sets workspace packages", () => {
      const registry = getPackageRegistry();
      registry.setWorkspacePackages({
        "lib-a": "user/a#main",
        "lib-b": "^1.0.0",
      });

      expect(registry.has("lib-a")).toBe(true);
      expect(registry.has("lib-b")).toBe(true);
    });
  });

  describe("project dependencies", () => {
    it("sets and gets project dependencies", () => {
      const registry = getPackageRegistry();
      registry.setProjectDependencies({
        lodash: "^4.17.0",
        react: "^18.0.0",
      });

      const lodashSpec = registry.get("lodash");
      expect(lodashSpec?.npmSpec).toBe("^4.17.0");

      const reactSpec = registry.get("react");
      expect(reactSpec?.npmSpec).toBe("^18.0.0");
    });

    it("project deps take precedence over workspace", () => {
      const registry = getPackageRegistry();

      // Set workspace package first
      registry.set("my-lib", "user/lib#main");

      // Then set project dep with same name
      registry.setProjectDependencies({
        "my-lib": "^1.0.0",
      });

      // Project dep should win
      const spec = registry.get("my-lib");
      expect(spec?.npmSpec).toBe("^1.0.0");
      expect(spec?.gitSpec).toBeUndefined();
    });

    it("clears project dependencies", () => {
      const registry = getPackageRegistry();
      registry.setProjectDependencies({ lodash: "^4.17.0" });
      registry.clearProjectDependencies();

      expect(registry.get("lodash")).toBeUndefined();
    });
  });

  describe("resolved paths", () => {
    it("sets and gets resolved paths", () => {
      const registry = getPackageRegistry();
      registry.set("my-lib", "user/lib#main");
      registry.setResolvedPath("my-lib", "/packages/my-lib");

      const spec = registry.get("my-lib");
      expect(spec?.resolvedPath).toBe("/packages/my-lib");
    });

    it("clears resolved path when spec changes", () => {
      const registry = getPackageRegistry();
      registry.set("my-lib", "user/lib#main");
      registry.setResolvedPath("my-lib", "/packages/my-lib");

      // Update spec
      registry.set("my-lib", "user/lib#develop");

      // Resolved path should be cleared
      const spec = registry.get("my-lib");
      expect(spec?.resolvedPath).toBeUndefined();
    });

    it("clears all resolved paths", () => {
      const registry = getPackageRegistry();
      registry.set("lib-a", "user/a#main");
      registry.set("lib-b", "user/b#main");
      registry.setResolvedPath("lib-a", "/packages/lib-a");
      registry.setResolvedPath("lib-b", "/packages/lib-b");

      registry.clearResolvedPaths();

      expect(registry.getResolvedPath("lib-a")).toBeUndefined();
      expect(registry.getResolvedPath("lib-b")).toBeUndefined();
    });
  });

  describe("has and keys", () => {
    it("has returns true for registered packages", () => {
      const registry = getPackageRegistry();
      registry.set("workspace-lib", "user/lib#main");
      registry.setProjectDependencies({ "project-lib": "^1.0.0" });

      expect(registry.has("workspace-lib")).toBe(true);
      expect(registry.has("project-lib")).toBe(true);
      expect(registry.has("unknown")).toBe(false);
    });

    it("keys returns all package names", () => {
      const registry = getPackageRegistry();
      registry.set("workspace-lib", "user/lib#main");
      registry.setProjectDependencies({ "project-lib": "^1.0.0" });

      const keys = registry.keys();
      expect(keys).toContain("workspace-lib");
      expect(keys).toContain("project-lib");
    });

    it("keys deduplicates names present in both project and workspace", () => {
      const registry = getPackageRegistry();
      registry.set("shared-lib", "user/lib#main");
      registry.setProjectDependencies({ "shared-lib": "^1.0.0" });

      const keys = registry.keys();
      const sharedLibCount = keys.filter((k) => k === "shared-lib").length;
      expect(sharedLibCount).toBe(1);
    });
  });
});
