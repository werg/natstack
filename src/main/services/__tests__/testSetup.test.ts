import { describe, it, expect, beforeAll } from "vitest";

describe("testSetup - panel globals stubs", () => {
  beforeAll(async () => {
    // Load the setup file
    await import("../testSetup");
  });

  it("installs __natstackModuleMap__", () => {
    expect(globalThis.__natstackModuleMap__).toBeDefined();
    expect(typeof globalThis.__natstackModuleMap__).toBe("object");
  });

  it("installs __natstackRequire__", () => {
    expect(globalThis.__natstackRequire__).toBeDefined();
    expect(typeof globalThis.__natstackRequire__).toBe("function");
  });

  it("installs __natstackRequireAsync__", () => {
    expect(globalThis.__natstackRequireAsync__).toBeDefined();
    expect(typeof globalThis.__natstackRequireAsync__).toBe("function");
  });

  it("installs __natstackId", () => {
    expect(globalThis.__natstackId).toBe("test-panel");
  });

  it("installs __natstackContextId", () => {
    expect(globalThis.__natstackContextId).toBe("ctx_test");
  });

  it("__natstackRequire__ returns registered modules", () => {
    globalThis.__natstackModuleMap__["test-module"] = { hello: "world" };
    const mod = globalThis.__natstackRequire__("test-module");
    expect(mod).toEqual({ hello: "world" });
  });

  it("__natstackRequireAsync__ returns registered modules", async () => {
    globalThis.__natstackModuleMap__["async-module"] = { foo: "bar" };
    const mod = await globalThis.__natstackRequireAsync__("async-module");
    expect(mod).toEqual({ foo: "bar" });
  });

  it("__natstackRequire__ returns undefined for unregistered modules", () => {
    const mod = globalThis.__natstackRequire__("nonexistent");
    expect(mod).toBeUndefined();
  });
});
