import { describe, it, expect, vi } from "vitest";
import { transformEsmForAsyncExecution } from "./esm-transform.js";

// AsyncFunction constructor helper
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

async function runTransformed(code: string, importImpl = vi.fn()) {
  const exports: Record<string, unknown> = {};
  const transformed = transformEsmForAsyncExecution(code, {
    importIdentifier: "__importModule__",
    exportIdentifier: "__exports__",
  });

  const fn = new AsyncFunction(
    "__importModule__",
    "__exports__",
    `${transformed}; return __exports__;`
  );

  const result = await fn(importImpl, exports);
  return { exports: result as Record<string, unknown>, importImpl };
}

describe("transformEsmForAsyncExecution", () => {
  it("captures default exports (expression)", async () => {
    const { exports } = await runTransformed(`export default 42;`);
    expect(exports.default).toBe(42);
  });

  it("captures named exports and declarations", async () => {
    const { exports } = await runTransformed(`
      const local = 1;
      export { local as foo };
      export function bar() { return 2; }
    `);

    expect(exports.foo).toBe(1);
    expect(typeof exports.bar).toBe("function");
    expect((exports.bar as () => number)()).toBe(2);
  });

  it("rewrites bare imports through importModule", async () => {
    const importModule = vi.fn().mockResolvedValue({
      default: "DEFAULT",
      named: "NAMED",
    });

    const { exports } = await runTransformed(
      `import def, { named as alias } from "pkg"; export { def, alias };`,
      importModule
    );

    expect(importModule).toHaveBeenCalledWith("pkg");
    expect(exports.def).toBe("DEFAULT");
    expect(exports.alias).toBe("NAMED");
  });

  it("supports export * and re-exports", async () => {
    const importModule = vi.fn().mockResolvedValue({
      foo: "bar",
      default: "defaultVal",
    });

    const { exports } = await runTransformed(`export * from "mod";`, importModule);

    expect(importModule).toHaveBeenCalledWith("mod");
    expect(exports.foo).toBe("bar");
    expect(exports.default).toBe("defaultVal");
  });

  it("handles top-level await", async () => {
    const { exports } = await runTransformed(`
      const value = await Promise.resolve(5);
      export { value };
    `);

    expect(exports.value).toBe(5);
  });
});
