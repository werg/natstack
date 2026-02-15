/**
 * Filesystem provider using ZenFS (OPFS backend).
 *
 * All panels and workers run in browser sandbox mode and use ZenFS
 * with the Origin Private File System (OPFS) backend for storage.
 */

import type { RuntimeFs } from "../types.js";

// Lazy-loaded fs implementation
let _fs: RuntimeFs | null = null;
let _fsReady: Promise<void> | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Initialize ZenFS with OPFS backend.
 * Called once, lazily, on first fs access.
 */
async function initFs(): Promise<void> {
  if (_fs) return;

  const { fs: zenFs, fsReady: zenFsReady } = await import("./zenfs.js");
  _fs = zenFs;
  _fsReady = zenFsReady;
  await zenFsReady;
}

// Start initialization immediately
_initPromise = initFs().catch((err) => {
  console.error("[NatStack] Failed to initialize filesystem:", err);
  throw err;
});

/**
 * Promise that resolves when fs is ready (OPFS initialization).
 */
export const fsReady: Promise<void> = _initPromise;

/**
 * Proxy-based fs that waits for initialization on each call.
 * Ensures the correct implementation is used regardless of import timing.
 */
export const fs: RuntimeFs = new Proxy({} as RuntimeFs, {
  get(_target, prop: keyof RuntimeFs) {
    return async (...args: unknown[]) => {
      await _initPromise;
      if (!_fs) throw new Error("[NatStack] Filesystem not initialized");
      const method = _fs[prop] as (...args: unknown[]) => Promise<unknown>;
      return method.apply(_fs, args);
    };
  },
});
