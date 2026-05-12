import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileComponent, executeSandbox, loadSourceFileBundle } from "./index";

describe("source file bundles", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)["__natstackModuleMap__"];
    originalRequire = (globalThis as Record<string, unknown>)["__natstackRequire__"];
    originalPreload = (globalThis as Record<string, unknown>)["__natstackPreloadModules__"];

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__natstackModuleMap__"] = moduleMap;
    (globalThis as Record<string, unknown>)["__natstackRequire__"] = (id: string) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__natstackPreloadModules__"] = async (ids: string[]) => (
      ids.map((id) => {
        if (id in moduleMap) return moduleMap[id];
        throw new Error(`Module not found: ${id}`);
      })
    );
  });

  afterEach(() => {
    if (originalModuleMap === undefined) delete (globalThis as Record<string, unknown>)["__natstackModuleMap__"];
    else (globalThis as Record<string, unknown>)["__natstackModuleMap__"] = originalModuleMap;
    if (originalRequire === undefined) delete (globalThis as Record<string, unknown>)["__natstackRequire__"];
    else (globalThis as Record<string, unknown>)["__natstackRequire__"] = originalRequire;
    if (originalPreload === undefined) delete (globalThis as Record<string, unknown>)["__natstackPreloadModules__"];
    else (globalThis as Record<string, unknown>)["__natstackPreloadModules__"] = originalPreload;
  });

  it("loads an entry file and nested relative imports", async () => {
    const files: Record<string, string> = {
      "src/main.ts": `import { double } from "./math"; export default double(21);`,
      "src/math.ts": `import { base } from "./nested/base"; export const double = (n: number) => n * base;`,
      "src/nested/base.ts": `export const base = 2;`,
    };

    const bundle = await loadSourceFileBundle("src/main.ts", async (path) => {
      const code = files[path];
      if (code === undefined) throw new Error(`Missing ${path}`);
      return code;
    });

    expect(bundle.entryPath).toBe("src/main.ts");
    expect(Object.keys(bundle.files).sort()).toEqual([
      "src/main.ts",
      "src/math.ts",
      "src/nested/base.ts",
    ]);
  });

  it("executes eval files with relative imports", async () => {
    const code = `import { double } from "./math"; return double(input);`;
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "src/main.ts",
      sourceFiles: {
        "src/main.ts": code,
        "src/math.ts": `export const double = (n: number) => n * 2;`,
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
  });

  it("infers bare npm imports from the nearest package.json", async () => {
    const code = `import { double } from "math-lib"; return double(input);`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await executeSandbox(code, {
      syntax: "typescript",
      sourcePath: "packages/app/src/main.ts",
      loadSourceFile: async (path) => {
        if (path === "packages/app/src/main.ts") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: { "math-lib": "^1.2.3" } });
        }
        throw new Error(`Missing ${path}`);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return `module.exports = { double: (n) => n * 2 };`;
      },
      bindings: { input: 21 },
    });

    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(42);
    expect(loadCalls).toEqual([{ specifier: "math-lib", ref: "npm:^1.2.3" }]);
  });

  it("compiles components with relative imports", async () => {
    const code = `import { label } from "./labels"; export default function App() { return label; }`;
    const result = await compileComponent<() => string>(code, {
      sourcePath: "ui/App.tsx",
      sourceFiles: {
        "ui/App.tsx": code,
        "ui/labels.ts": `export const label = "ready";`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
  });

  it("compiles file components with package.json inferred imports", async () => {
    const code = `import { label } from "label-lib"; export default function App() { return label; }`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const result = await compileComponent<() => string>(code, {
      sourcePath: "packages/app/ui/App.tsx",
      loadSourceFile: async (path) => {
        if (path === "packages/app/ui/App.tsx") return code;
        if (path === "packages/app/package.json") {
          return JSON.stringify({ dependencies: { "label-lib": "2" } });
        }
        throw new Error(`Missing ${path}`);
      },
      loadImport: async (specifier, ref) => {
        loadCalls.push({ specifier, ref });
        return `module.exports = { label: "ready" };`;
      },
    });

    expect(result.success).toBe(true);
    expect(result.Component?.()).toBe("ready");
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });
});
