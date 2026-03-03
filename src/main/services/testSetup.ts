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
  // eslint-disable-next-line no-var
  var __natstackModuleMap__: Record<string, unknown>;
  // eslint-disable-next-line no-var
  var __natstackRequire__: (id: string) => unknown;
  // eslint-disable-next-line no-var
  var __natstackRequireAsync__: (id: string) => Promise<unknown>;
  // eslint-disable-next-line no-var
  var __natstackId: string | undefined;
  // eslint-disable-next-line no-var
  var __natstackContextId: string | undefined;
}

// Panel runtime globals
(globalThis as any).__natstackModuleMap__ = (globalThis as any).__natstackModuleMap__ ?? {};
(globalThis as any).__natstackRequire__ = (id: string) => (globalThis as any).__natstackModuleMap__[id];
(globalThis as any).__natstackRequireAsync__ = async (id: string) => (globalThis as any).__natstackModuleMap__[id];

// Panel identity stubs
(globalThis as any).__natstackId = "test-panel";
(globalThis as any).__natstackContextId = "ctx_test";
