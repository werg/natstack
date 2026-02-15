import { describe, it, expect } from "vitest";
import {
  resolveExportSubpath,
  parseWorkspaceImport,
  BUNDLE_CONDITIONS,
  TYPES_CONDITIONS,
  WORKSPACE_CONDITIONS,
} from "./resolution.js";

describe("resolveExportSubpath", () => {
  it("returns string export value directly regardless of conditions", () => {
    const exports = { ".": "./dist/index.js" };
    expect(resolveExportSubpath(exports, ".", BUNDLE_CONDITIONS)).toBe("./dist/index.js");
    expect(resolveExportSubpath(exports, ".", TYPES_CONDITIONS)).toBe("./dist/index.js");
    expect(resolveExportSubpath(exports, ".", WORKSPACE_CONDITIONS)).toBe("./dist/index.js");
  });

  it("string export bypasses condition filtering (callers must guard)", () => {
    // resolveExportSubpath treats plain strings as unconditional per Node.js spec.
    // Callers like load-natstack-types that need .d.ts-only results must filter
    // the return value themselves (e.g., /\.d\.[cm]?ts$/ check).
    const exports = { "./config": "./dist/config.js" };
    expect(resolveExportSubpath(exports, "./config", TYPES_CONDITIONS)).toBe("./dist/config.js");
  });

  it("returns null for unknown subpath", () => {
    const exports = { ".": "./dist/index.js" };
    expect(resolveExportSubpath(exports, "./missing", BUNDLE_CONDITIONS)).toBeNull();
  });

  it("resolves flat conditions with BUNDLE_CONDITIONS", () => {
    const exports = {
      ".": {
        "natstack-panel": "./dist/panel-entry.js",
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    };
    expect(resolveExportSubpath(exports, ".", BUNDLE_CONDITIONS)).toBe("./dist/panel-entry.js");
  });

  it("never returns .d.ts for BUNDLE_CONDITIONS when types and default both exist", () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    };
    // BUNDLE_CONDITIONS is ["natstack-panel", "default"] — no "types"
    expect(resolveExportSubpath(exports, ".", BUNDLE_CONDITIONS)).toBe("./dist/index.js");
  });

  it("resolves TYPES_CONDITIONS to types entry only", () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    };
    expect(resolveExportSubpath(exports, ".", TYPES_CONDITIONS)).toBe("./dist/index.d.ts");
  });

  it("returns null for TYPES_CONDITIONS when no types entry exists", () => {
    const exports = {
      ".": {
        default: "./dist/index.js",
      },
    };
    expect(resolveExportSubpath(exports, ".", TYPES_CONDITIONS)).toBeNull();
  });

  it("resolves WORKSPACE_CONDITIONS with types priority over default", () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    };
    expect(resolveExportSubpath(exports, ".", WORKSPACE_CONDITIONS)).toBe("./dist/index.d.ts");
  });

  it("falls back to default with WORKSPACE_CONDITIONS when no types", () => {
    const exports = {
      ".": {
        default: "./dist/index.js",
      },
    };
    expect(resolveExportSubpath(exports, ".", WORKSPACE_CONDITIONS)).toBe("./dist/index.js");
  });

  it("resolves nested conditions", () => {
    const exports = {
      ".": {
        import: {
          types: "./dist/index.d.ts",
          default: "./dist/index.mjs",
        },
        require: {
          types: "./dist/index.d.cts",
          default: "./dist/index.cjs",
        },
      },
    };
    // WORKSPACE_CONDITIONS ["types", "default"] should recurse into "import" (not matched)
    // and "require" (not matched), then find nothing — neither "types" nor "default" are
    // top-level keys here. The nested conditions require matching the outer key first.
    expect(resolveExportSubpath(exports, ".", WORKSPACE_CONDITIONS)).toBeNull();

    // With conditions that include "import", it should resolve nested types
    const importTypesConditions = ["import", "types"] as const;
    // "import" matches → recurse into { types: ..., default: ... }
    // Then "import" doesn't match, "types" matches → "./dist/index.d.ts"
    expect(resolveExportSubpath(exports, ".", importTypesConditions)).toBe("./dist/index.d.ts");
  });

  it("resolves subpath exports", () => {
    const exports = {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./config": {
        types: "./dist/config.d.ts",
        default: "./dist/config.js",
      },
    };
    expect(resolveExportSubpath(exports, "./config", TYPES_CONDITIONS)).toBe("./dist/config.d.ts");
    expect(resolveExportSubpath(exports, "./config", BUNDLE_CONDITIONS)).toBe("./dist/config.js");
  });

  it("returns null for non-object, non-string export values", () => {
    const exports = { ".": 42 as unknown };
    expect(resolveExportSubpath(exports as Record<string, unknown>, ".", BUNDLE_CONDITIONS)).toBeNull();
  });
});

describe("parseWorkspaceImport", () => {
  it("parses root import", () => {
    expect(parseWorkspaceImport("@workspace/runtime")).toEqual({
      packageName: "runtime",
      subpath: ".",
    });
  });

  it("parses subpath import", () => {
    expect(parseWorkspaceImport("@workspace/agentic-messaging/config")).toEqual({
      packageName: "agentic-messaging",
      subpath: "./config",
    });
  });

  it("parses deep subpath import", () => {
    expect(parseWorkspaceImport("@workspace/runtime/panel/fs")).toEqual({
      packageName: "runtime",
      subpath: "./panel/fs",
    });
  });

  it("returns null for non-natstack import", () => {
    expect(parseWorkspaceImport("react")).toBeNull();
    expect(parseWorkspaceImport("@scope/pkg")).toBeNull();
    expect(parseWorkspaceImport("natstack/runtime")).toBeNull();
  });
});
