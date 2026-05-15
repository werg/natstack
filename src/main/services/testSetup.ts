/**
 * Vitest setup file for panel tests.
 *
 * Provides minimal stubs for panel runtime globals so that unit and component
 * tests can run without the full NatStack panel runtime. Tests needing live
 * RPC/transport should use the eval tool or launch_panel + Playwright instead.
 */

// Ensure this is treated as a module
export {};

// Type augmentation so TS doesn't complain
declare global {
  var __natstackModuleMap__: Record<string, unknown>;

  var __natstackRequire__: (id: string) => unknown;

  var __natstackRequireAsync__: (id: string) => Promise<unknown>;

  var __natstackId: string | undefined;

  var __natstackContextId: string | undefined;
}

// Panel runtime globals
globalThis.__natstackModuleMap__ = globalThis.__natstackModuleMap__ ?? {};
globalThis.__natstackRequire__ = (id: string) => globalThis.__natstackModuleMap__[id];
globalThis.__natstackRequireAsync__ = async (id: string) => globalThis.__natstackModuleMap__[id];

// Panel identity stubs
globalThis.__natstackId = "test-panel";
globalThis.__natstackContextId = "ctx-test";
