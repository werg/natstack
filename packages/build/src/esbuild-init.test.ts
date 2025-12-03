/**
 * Tests for esbuild-wasm initialization singleton
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The global key used by the module
const GLOBAL_KEY = "__natstack_build_esbuild__";

// Clean up global state before tests
function resetGlobalState() {
  delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
}

describe("esbuild-init", () => {
  beforeEach(() => {
    resetGlobalState();
    vi.resetModules();
  });

  afterEach(() => {
    resetGlobalState();
    vi.restoreAllMocks();
  });

  describe("getGlobalState (via exports)", () => {
    it("should initialize global state on first access", async () => {
      const { isEsbuildAvailable } = await import("./esbuild-init.js");

      // isEsbuildAvailable accesses global state
      expect(isEsbuildAvailable()).toBe(false);

      // Global state should now exist
      const state = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
      expect(state).toBeDefined();
      expect(state).toHaveProperty("esbuild", null);
      expect(state).toHaveProperty("initPromise", null);
      expect(state).toHaveProperty("initialized", false);
    });
  });

  describe("isEsbuildAvailable", () => {
    it("should return false before initialization", async () => {
      const { isEsbuildAvailable } = await import("./esbuild-init.js");
      expect(isEsbuildAvailable()).toBe(false);
    });

    it("should return false when esbuild is null", async () => {
      const { isEsbuildAvailable } = await import("./esbuild-init.js");

      // Set up state with initialized=true but esbuild=null
      (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
        esbuild: null,
        initPromise: null,
        initialized: true,
      };

      // Need to re-import to get fresh module
      vi.resetModules();
      const module = await import("./esbuild-init.js");
      expect(module.isEsbuildAvailable()).toBe(false);
    });
  });

  describe("getEsbuildSync", () => {
    it("should return null before initialization", async () => {
      const { getEsbuildSync } = await import("./esbuild-init.js");
      expect(getEsbuildSync()).toBeNull();
    });

    it("should return null when not initialized even if esbuild exists", async () => {
      const mockEsbuild = { version: "0.24.0" };
      (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
        esbuild: mockEsbuild,
        initPromise: null,
        initialized: false, // Not yet initialized
      };

      const { getEsbuildSync } = await import("./esbuild-init.js");
      expect(getEsbuildSync()).toBeNull();
    });

    it("should return esbuild when initialized", async () => {
      const mockEsbuild = { version: "0.24.0" };
      (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
        esbuild: mockEsbuild,
        initPromise: null,
        initialized: true,
      };

      const { getEsbuildSync } = await import("./esbuild-init.js");
      expect(getEsbuildSync()).toBe(mockEsbuild);
    });
  });

  describe("getEsbuild", () => {
    it("should reuse existing initPromise if present", async () => {
      const mockPromise = Promise.resolve({ version: "0.24.0" });
      (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
        esbuild: null,
        initPromise: mockPromise,
        initialized: false,
      };

      const { getEsbuild } = await import("./esbuild-init.js");
      const result = getEsbuild();

      expect(result).toBe(mockPromise);
    });

    it("should create new initPromise if none exists", async () => {
      const { getEsbuild } = await import("./esbuild-init.js");

      const promise1 = getEsbuild();
      const promise2 = getEsbuild();

      // Should return the same promise instance (deduplication)
      expect(promise1).toBe(promise2);

      // Both promises will reject in Node.js environment, but that's expected
      // We're just testing that the same promise is returned
      await promise1.catch(() => {});
      await promise2.catch(() => {});
    });
  });

  describe("EsbuildInitOptions", () => {
    it("should have wasmURL as optional property", async () => {
      // Type test - just verify the module exports the type
      const module = await import("./esbuild-init.js");
      expect(module).toHaveProperty("getEsbuild");

      // getEsbuild should accept empty options (the promise will reject in Node.js but that's fine)
      const { getEsbuild } = module;
      const promise = getEsbuild({});
      expect(promise).toBeInstanceOf(Promise);

      // Clean up the promise to avoid unhandled rejection
      await promise.catch(() => {});
    });
  });
});

describe("singleton behavior", () => {
  beforeEach(() => {
    resetGlobalState();
    vi.resetModules();
  });

  afterEach(() => {
    resetGlobalState();
    vi.restoreAllMocks();
  });

  it("should share state across multiple imports", async () => {
    // First import
    const module1 = await import("./esbuild-init.js");
    module1.isEsbuildAvailable(); // Initialize global state

    // Manually set initialized to true
    const state = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as {
      initialized: boolean;
      esbuild: unknown;
    };
    state.initialized = true;
    state.esbuild = { version: "test" };

    // Second import should see the same state
    vi.resetModules();
    const module2 = await import("./esbuild-init.js");

    expect(module2.isEsbuildAvailable()).toBe(true);
    expect(module2.getEsbuildSync()).toEqual({ version: "test" });
  });
});
