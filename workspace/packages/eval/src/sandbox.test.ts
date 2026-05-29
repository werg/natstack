import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSandbox } from "./sandbox";

describe("executeSandbox", () => {
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

  it("settles a pending async eval when its signal is aborted", async () => {
    const controller = new AbortController();
    const pending = executeSandbox("return await new Promise(() => {});", {
      syntax: "typescript",
      signal: controller.signal,
    });

    controller.abort("User interrupted execution");

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: "User interrupted execution",
    });
  });

  it("fails fast when the signal is already aborted before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeSandbox("return 21 + 21;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("completes normally when an unaborted signal is provided", async () => {
    const controller = new AbortController();
    const result = await executeSandbox("return 1 + 2;", {
      syntax: "typescript",
      signal: controller.signal,
    });
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(3);
  });
});
