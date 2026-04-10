/**
 * Tests for the entry wrapper / module-map bootstrap generators.
 *
 * These cover the small pure-function half of the build pipeline that lives
 * around `__natstackRequire__` and `exposeModules`. The full builder is tested
 * indirectly by the running dev server; this file locks in the contract of
 * the helpers shared by both panel and worker builds.
 */

import {
  generateModuleMapBootstrap,
  generateExposeModuleCode,
  generateWorkerEntry,
} from "./builder.js";

describe("generateModuleMapBootstrap (panel target)", () => {
  it("declares the module map and both require functions on globalThis", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toContain("globalThis.__natstackModuleMap__");
    expect(code).toContain("globalThis.__natstackRequire__");
    expect(code).toContain("globalThis.__natstackRequireAsync__");
  });

  it("uses idempotent initialization so repeated boots don't clobber state", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toMatch(/__natstackModuleMap__\s*=\s*globalThis\.__natstackModuleMap__\s*\|\|\s*\{\}/);
  });

  it("__natstackRequire__ throws a clear error for unknown modules", () => {
    const code = generateModuleMapBootstrap("panel");
    expect(code).toContain("not available. Workspace packages");
  });

  it("defaults to panel target when no argument is passed", () => {
    expect(generateModuleMapBootstrap()).toBe(generateModuleMapBootstrap("panel"));
  });
});

describe("generateModuleMapBootstrap (worker target)", () => {
  it("emits the module map and __natstackRequire__", () => {
    const code = generateModuleMapBootstrap("worker");
    expect(code).toContain("globalThis.__natstackModuleMap__");
    expect(code).toContain("globalThis.__natstackRequire__");
  });

  it("omits __natstackRequireAsync__ entirely (workerd has no dynamic import)", () => {
    const code = generateModuleMapBootstrap("worker");
    expect(code).not.toContain("__natstackRequireAsync__");
    expect(code).not.toContain("__natstackModuleLoadingPromises__");
    // No `import(id)` either — that's the body of the async fallback.
    expect(code).not.toMatch(/\bimport\(id\)/);
  });

  it("worker bootstrap is strictly smaller than panel bootstrap", () => {
    expect(generateModuleMapBootstrap("worker").length)
      .toBeLessThan(generateModuleMapBootstrap("panel").length);
  });
});

describe("generateExposeModuleCode", () => {
  it("includes the bootstrap even with no expose modules", () => {
    const code = generateExposeModuleCode([]);
    expect(code).toContain("globalThis.__natstackModuleMap__");
    expect(code).toContain("globalThis.__natstackRequire__");
    // No imports or registrations when the list is empty.
    expect(code).not.toContain("__mod0__");
  });

  it("emits import + register lines for each exposed module", () => {
    const code = generateExposeModuleCode(["@workspace/runtime", "zod"]);
    expect(code).toContain('import * as __mod0__ from "@workspace/runtime"');
    expect(code).toContain('import * as __mod1__ from "zod"');
    expect(code).toContain('globalThis.__natstackModuleMap__["@workspace/runtime"] = __mod0__');
    expect(code).toContain('globalThis.__natstackModuleMap__["zod"] = __mod1__');
  });

  it("preserves the order of exposed modules in the generated code", () => {
    const code = generateExposeModuleCode(["a", "b", "c"]);
    const aIdx = code.indexOf("__mod0__");
    const bIdx = code.indexOf("__mod1__");
    const cIdx = code.indexOf("__mod2__");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("worker target produces the worker-flavored bootstrap", () => {
    const code = generateExposeModuleCode(["@workspace/runtime"], "worker");
    expect(code).not.toContain("__natstackRequireAsync__");
    expect(code).toContain('import * as __mod0__ from "@workspace/runtime"');
  });

  it("panel target produces the panel-flavored bootstrap", () => {
    const code = generateExposeModuleCode(["react"], "panel");
    expect(code).toContain("__natstackRequireAsync__");
    expect(code).toContain('import * as __mod0__ from "react"');
  });
});

describe("generateWorkerEntry", () => {
  it("imports the expose file as a side effect before re-exporting", () => {
    const code = generateWorkerEntry("/tmp/_expose.js", "/src/index.ts");
    const exposeIdx = code.indexOf('import "/tmp/_expose.js"');
    const exportStarIdx = code.indexOf('export * from "/src/index.ts"');
    expect(exposeIdx).toBeGreaterThan(-1);
    expect(exportStarIdx).toBeGreaterThan(exposeIdx);
  });

  it("re-exports default and named exports so workerd sees the user module shape", () => {
    const code = generateWorkerEntry("/tmp/_expose.js", "/src/index.ts");
    expect(code).toContain('export * from "/src/index.ts"');
    expect(code).toContain('export { default } from "/src/index.ts"');
  });

  it("JSON-quotes paths to handle special characters", () => {
    const code = generateWorkerEntry(
      "/tmp/path with spaces/_expose.js",
      "/src/path with spaces/index.ts",
    );
    expect(code).toContain('"/tmp/path with spaces/_expose.js"');
    expect(code).toContain('"/src/path with spaces/index.ts"');
  });
});
