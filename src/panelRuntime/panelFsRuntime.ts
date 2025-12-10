import { configureSingle, fs as zenFs, promises as zenPromises } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";

/**
 * Lazy-initialized filesystem shim for browser panels.
 *
 * This module does NOT use top-level await, which allows it to be used
 * alongside CJS libraries that use require("fs") (like TypeScript).
 *
 * Instead, initialization happens lazily:
 * - Async methods (fs/promises) await initialization automatically
 * - Sync methods warn if called before initialization
 * - Explicit `await ready` can be used to pre-initialize
 */

// Initialization state
let initPromise: Promise<void> | null = null;
let initialized = false;
let initError: Error | null = null;

const INIT_TIMEOUT_MS = 10000; // 10 seconds

const configureOpfsBackend = async (): Promise<void> => {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    throw new Error(
      "[NatStack] OPFS is unavailable in this browser. " +
        "The filesystem API requires OPFS support. " +
        "Please use a modern browser with OPFS enabled (Chrome 102+, Edge 102+, Safari 15.2+)."
    );
  }

  const handle = await navigator.storage.getDirectory();
  await configureSingle({ backend: WebAccess, handle });
};

/**
 * Initialize the filesystem. Called automatically on first async fs use.
 * Can also be awaited explicitly to pre-initialize.
 */
export const ready: Promise<void> = (async () => {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `[NatStack] Filesystem initialization timed out after ${INIT_TIMEOUT_MS}ms. ` +
                "This may indicate a browser compatibility issue or OPFS access problem."
            )
          );
        }, INIT_TIMEOUT_MS);
      });

      await Promise.race([configureOpfsBackend(), timeoutPromise]);
      initialized = true;
    } catch (error) {
      initError = error instanceof Error ? error : new Error(String(error));
      console.error("[NatStack] Failed to configure ZenFS WebAccess backend for OPFS", error);
      throw error;
    }
  })();

  return initPromise;
})();

/**
 * Ensure fs is initialized. Throws if initialization failed.
 */
function ensureInitialized(): void {
  if (initError) {
    throw initError;
  }
}

/**
 * For sync methods, we can't wait for initialization.
 * Log a warning if called before ready.
 */
function warnIfNotReady(methodName: string): void {
  if (!initialized && !initError) {
    console.warn(
      `[NatStack] fs.${methodName}() called before filesystem initialization complete. ` +
        "This may fail. Consider awaiting 'ready' first or using async methods."
    );
  }
}

// Sync methods that might be called before initialization
const syncMethods = new Set([
  "readFileSync",
  "writeFileSync",
  "existsSync",
  "mkdirSync",
  "readdirSync",
  "statSync",
  "unlinkSync",
  "rmdirSync",
  "renameSync",
  "copyFileSync",
  "accessSync",
  "lstatSync",
  "realpathSync",
  "chmodSync",
  "chownSync",
  "truncateSync",
  "appendFileSync",
  "linkSync",
  "symlinkSync",
  "readlinkSync",
  "fstatSync",
  "fchmodSync",
  "fchownSync",
  "futimesSync",
  "fsyncSync",
  "fdatasyncSync",
  "ftruncateSync",
  "closeSync",
  "openSync",
  "readSync",
  "writeSync",
]);

// Create a proxy for the sync fs API that handles initialization
const createFsProxy = (): typeof zenFs => {
  return new Proxy(zenFs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // For sync methods, warn if not ready
      if (typeof value === "function" && typeof prop === "string" && syncMethods.has(prop)) {
        return function (this: unknown, ...args: unknown[]) {
          ensureInitialized();
          if (!initialized) {
            throw new Error(
              `[NatStack] fs.${prop}() called before filesystem initialization is complete. ` +
                "Await 'ready' before using sync fs methods."
            );
          }
          warnIfNotReady(prop);
          return (value as (...args: unknown[]) => unknown).apply(
            this === receiver ? target : this,
            args
          );
        };
      }

      return value;
    },
  });
};

// Create a proxy for the promises API that ensures initialization
const createPromisesProxy = (): typeof zenPromises => {
  return new Proxy(zenPromises, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // For async methods, ensure initialization first
      if (typeof value === "function" && typeof prop === "string") {
        return async function (this: unknown, ...args: unknown[]) {
          await ready;
          ensureInitialized();
          return (value as (...args: unknown[]) => unknown).apply(
            this === receiver ? target : this,
            args
          );
        };
      }

      return value;
    },
  });
};

export const fs = createFsProxy();
export const promises = createPromisesProxy();

// Default export for `import fs from "fs"`
export default fs;
// Also mirror the Node pattern where `fs/promises` can be default-imported
export const promisesDefault = promises;
