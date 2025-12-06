/**
 * Tests for dependency resolver
 */

import { describe, it, expect } from "vitest";
import {
  parsePackageSpecifier,
  resolveDependency,
  resolveDependencies,
  getGitDependencies,
  type PackageRegistry,
  type PackageSpec,
} from "./dependency-resolver.js";

describe("parsePackageSpecifier", () => {
  it("parses simple package names", () => {
    expect(parsePackageSpecifier("lodash")).toEqual({
      name: "lodash",
      subpath: undefined,
    });
  });

  it("parses package with subpath", () => {
    expect(parsePackageSpecifier("lodash/debounce")).toEqual({
      name: "lodash",
      subpath: "debounce",
    });
  });

  it("parses scoped packages", () => {
    expect(parsePackageSpecifier("@natstack/build")).toEqual({
      name: "@natstack/build",
      subpath: undefined,
    });
  });

  it("parses scoped packages with subpath", () => {
    expect(parsePackageSpecifier("@natstack/build/transform")).toEqual({
      name: "@natstack/build",
      subpath: "transform",
    });
  });

  it("parses scoped packages with deep subpath", () => {
    expect(parsePackageSpecifier("@natstack/build/utils/helpers")).toEqual({
      name: "@natstack/build",
      subpath: "utils/helpers",
    });
  });
});

describe("resolveDependency", () => {
  it("returns external for unknown packages", async () => {
    const result = await resolveDependency("unknown-package");
    expect(result).toEqual({
      name: "unknown-package",
      type: "npm",
      external: true,
    });
  });

  it("resolves from explicit dependencies - git spec", async () => {
    const result = await resolveDependency("my-lib", {
      dependencies: {
        "my-lib": "owner/repo#main",
      },
    });
    expect(result).toEqual({
      name: "my-lib",
      type: "git",
      path: "/packages/my-lib",
    });
  });

  it("resolves from explicit dependencies - npm spec", async () => {
    const result = await resolveDependency("lodash", {
      dependencies: {
        lodash: "^4.17.0",
      },
    });
    expect(result).toEqual({
      name: "lodash",
      type: "npm",
      external: true,
    });
  });

  it("respects custom packages base path", async () => {
    const result = await resolveDependency("my-lib", {
      dependencies: {
        "my-lib": "owner/repo@v1.0.0",
      },
      packagesBasePath: "/deps",
    });
    expect(result).toEqual({
      name: "my-lib",
      type: "git",
      path: "/deps/my-lib",
    });
  });

  it("includes subpath in resolved path", async () => {
    const result = await resolveDependency("my-lib/utils", {
      dependencies: {
        "my-lib": "owner/repo#develop",
      },
    });
    expect(result).toEqual({
      name: "my-lib",
      type: "git",
      path: "/packages/my-lib/utils",
    });
  });

  describe("with PackageRegistry", () => {
    const createMockRegistry = (
      packages: Record<string, PackageSpec>
    ): PackageRegistry => ({
      get: (name) => packages[name],
      has: (name) => name in packages,
      keys: () => Object.keys(packages),
    });

    it("resolves git dependency from registry", async () => {
      const registry = createMockRegistry({
        "my-lib": { gitSpec: "owner/repo#main" },
      });

      const result = await resolveDependency("my-lib", { registry });
      expect(result).toEqual({
        name: "my-lib",
        type: "git",
        path: "/packages/my-lib",
      });
    });

    it("resolves npm dependency from registry as external", async () => {
      const registry = createMockRegistry({
        lodash: { npmSpec: "^4.17.0" },
      });

      const result = await resolveDependency("lodash", { registry });
      expect(result).toEqual({
        name: "lodash",
        type: "npm",
        external: true,
      });
    });

    it("uses resolved path when available", async () => {
      const registry = createMockRegistry({
        "my-lib": {
          gitSpec: "owner/repo#main",
          resolvedPath: "/custom/path/my-lib",
        },
      });

      const result = await resolveDependency("my-lib", { registry });
      expect(result).toEqual({
        name: "my-lib",
        type: "local",
        path: "/custom/path/my-lib",
      });
    });

    it("explicit dependencies take precedence over registry", async () => {
      const registry = createMockRegistry({
        "my-lib": { gitSpec: "owner/repo#main" },
      });

      const result = await resolveDependency("my-lib", {
        registry,
        dependencies: {
          "my-lib": "^1.0.0", // npm spec overrides git spec
        },
      });

      expect(result).toEqual({
        name: "my-lib",
        type: "npm",
        external: true,
      });
    });
  });
});

describe("resolveDependencies", () => {
  it("resolves multiple dependencies", async () => {
    const results = await resolveDependencies(
      ["lodash", "my-lib", "unknown"],
      {
        dependencies: {
          lodash: "^4.17.0",
          "my-lib": "owner/repo#main",
        },
      }
    );

    expect(results.size).toBe(3);
    expect(results.get("lodash")).toEqual({
      name: "lodash",
      type: "npm",
      external: true,
    });
    expect(results.get("my-lib")).toEqual({
      name: "my-lib",
      type: "git",
      path: "/packages/my-lib",
    });
    expect(results.get("unknown")).toEqual({
      name: "unknown",
      type: "npm",
      external: true,
    });
  });
});

describe("getGitDependencies", () => {
  it("extracts git dependencies from explicit dependencies", () => {
    const deps = getGitDependencies({
      dependencies: {
        "git-lib": "owner/repo#main",
        "npm-lib": "^1.0.0",
        "another-git": "other/repo@v1.0.0",
      },
    });

    expect(deps).toEqual([
      { name: "git-lib", spec: "owner/repo#main" },
      { name: "another-git", spec: "other/repo@v1.0.0" },
    ]);
  });

  it("extracts git dependencies from registry", () => {
    const registry: PackageRegistry = {
      get: (name) => {
        if (name === "git-lib") return { gitSpec: "owner/repo#main" };
        if (name === "npm-lib") return { npmSpec: "^1.0.0" };
        return undefined;
      },
      has: (name) => name === "git-lib" || name === "npm-lib",
      keys: () => ["git-lib", "npm-lib"],
    };

    const deps = getGitDependencies({ registry });

    expect(deps).toEqual([{ name: "git-lib", spec: "owner/repo#main" }]);
  });

  it("deduplicates between explicit and registry dependencies", () => {
    const registry: PackageRegistry = {
      get: (name) => {
        if (name === "shared-lib") return { gitSpec: "owner/shared#main" };
        if (name === "registry-only") return { gitSpec: "owner/registry#v1" };
        return undefined;
      },
      has: (name) => name === "shared-lib" || name === "registry-only",
      keys: () => ["shared-lib", "registry-only"],
    };

    const deps = getGitDependencies({
      registry,
      dependencies: {
        "shared-lib": "owner/shared#develop", // Override registry
        "explicit-only": "owner/explicit#main",
      },
    });

    // Explicit deps should win for shared-lib
    expect(deps).toContainEqual({
      name: "shared-lib",
      spec: "owner/shared#develop",
    });
    expect(deps).toContainEqual({
      name: "explicit-only",
      spec: "owner/explicit#main",
    });
    expect(deps).toContainEqual({
      name: "registry-only",
      spec: "owner/registry#v1",
    });

    // No duplicates
    const sharedLibEntries = deps.filter((d) => d.name === "shared-lib");
    expect(sharedLibEntries.length).toBe(1);
  });

  it("returns empty array when no git dependencies", () => {
    const deps = getGitDependencies({
      dependencies: {
        lodash: "^4.17.0",
        react: "^18.0.0",
      },
    });

    expect(deps).toEqual([]);
  });
});
