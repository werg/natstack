/**
 * File System Runtime for Browser Panels
 *
 * Provides Node.js-compatible fs APIs backed by ZenFS with OPFS storage.
 * Uses lazy initialization to avoid race conditions.
 */

import { configureSingle, fs as zenFs, promises as zenPromises } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";

// Initialization state
let initPromise: Promise<void> | null = null;
let initialized = false;
let initError: Error | null = null;

const INIT_TIMEOUT_MS = 30000; // 30 seconds - WebAccess can be slow on first init

/**
 * Configure the ZenFS OPFS backend.
 */
async function configureOpfsBackend(): Promise<void> {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    throw new Error(
      "[NatStack] OPFS is unavailable in this browser. " +
        "The filesystem API requires OPFS support. " +
        "Please use a modern browser with OPFS enabled (Chrome 102+, Edge 102+, Safari 15.2+)."
    );
  }

  console.log("[NatStack] Getting OPFS directory handle...");
  const handle = await navigator.storage.getDirectory();
  console.log("[NatStack] Got OPFS handle, configuring ZenFS WebAccess backend...");
  await configureSingle({ backend: WebAccess, handle });
  console.log("[NatStack] ZenFS WebAccess backend configured successfully");
}

/**
 * Initialize the filesystem lazily.
 * Returns a promise that resolves when initialization is complete.
 */
function getInitPromise(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
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
    } finally {
      // Clear timeout to prevent memory leak and spurious logs
      if (timeoutId) clearTimeout(timeoutId);
    }
  })();

  return initPromise;
}

/**
 * Promise that resolves when the filesystem is ready.
 * Initialization starts lazily on first access.
 */
export const ready: Promise<void> = {
  then<T1, T2>(
    onfulfilled?: ((value: void) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
  ): Promise<T1 | T2> {
    return getInitPromise().then(onfulfilled, onrejected);
  },
  catch<T>(onrejected?: ((reason: unknown) => T | PromiseLike<T>) | null): Promise<void | T> {
    return getInitPromise().catch(onrejected);
  },
  finally(onfinally?: (() => void) | null): Promise<void> {
    return getInitPromise().finally(onfinally);
  },
  [Symbol.toStringTag]: "Promise",
} as Promise<void>;

/**
 * Ensure fs is initialized. Throws if initialization failed.
 */
function ensureInitialized(): void {
  if (initError) {
    throw initError;
  }
}

/**
 * Wait for initialization and ensure it succeeded.
 * Helper to reduce boilerplate in async methods.
 */
async function waitForInit(): Promise<void> {
  await ready;
  ensureInitialized();
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

/**
 * Create a proxy for the sync fs API that handles initialization.
 */
function createFsProxy(): typeof zenFs {
  return new Proxy(zenFs, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // For sync methods, ensure initialization is complete
      if (typeof value === "function" && typeof prop === "string" && syncMethods.has(prop)) {
        return function (this: unknown, ...args: unknown[]) {
          // Throw if initialization failed
          ensureInitialized();
          // Throw if initialization hasn't completed yet
          if (!initialized) {
            throw new Error(
              `[NatStack] fs.${prop}() called before filesystem initialization is complete. ` +
                "Await 'ready' before using sync fs methods."
            );
          }
          return (value as (...args: unknown[]) => unknown).apply(
            this === receiver ? target : this,
            args
          );
        };
      }

      return value;
    },
  });
}

/**
 * Create a proxy for the promises API that ensures initialization.
 */
function createPromisesProxy(): typeof zenPromises {
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
}

export const fs = createFsProxy();
export const promises = createPromisesProxy();

// Default export for `import fs from "fs"`
export default fs;

// =============================================================================
// Named exports for fs/promises methods
// =============================================================================
// These allow `import { readFile, writeFile } from "fs/promises"` to work
// Each method wraps the promises API to ensure initialization

export const readFile = async (...args: Parameters<typeof zenPromises.readFile>) => {
  await waitForInit();
  return zenPromises.readFile(...args);
};

export const writeFile = async (...args: Parameters<typeof zenPromises.writeFile>) => {
  await waitForInit();
  return zenPromises.writeFile(...args);
};

export const mkdir = async (...args: Parameters<typeof zenPromises.mkdir>) => {
  await waitForInit();
  return zenPromises.mkdir(...args);
};

export const readdir = async (...args: Parameters<typeof zenPromises.readdir>) => {
  await waitForInit();
  return zenPromises.readdir(...args);
};

export const stat = async (...args: Parameters<typeof zenPromises.stat>) => {
  await waitForInit();
  return zenPromises.stat(...args);
};

export const lstat = async (...args: Parameters<typeof zenPromises.lstat>) => {
  await waitForInit();
  return zenPromises.lstat(...args);
};

export const unlink = async (...args: Parameters<typeof zenPromises.unlink>) => {
  await waitForInit();
  return zenPromises.unlink(...args);
};

export const rmdir = async (...args: Parameters<typeof zenPromises.rmdir>) => {
  await waitForInit();
  return zenPromises.rmdir(...args);
};

export const rm = async (...args: Parameters<typeof zenPromises.rm>) => {
  await waitForInit();
  return zenPromises.rm(...args);
};

export const rename = async (...args: Parameters<typeof zenPromises.rename>) => {
  await waitForInit();
  return zenPromises.rename(...args);
};

export const copyFile = async (...args: Parameters<typeof zenPromises.copyFile>) => {
  await waitForInit();
  return zenPromises.copyFile(...args);
};

export const access = async (...args: Parameters<typeof zenPromises.access>) => {
  await waitForInit();
  return zenPromises.access(...args);
};

export const chmod = async (...args: Parameters<typeof zenPromises.chmod>) => {
  await waitForInit();
  return zenPromises.chmod(...args);
};

export const chown = async (...args: Parameters<typeof zenPromises.chown>) => {
  await waitForInit();
  return zenPromises.chown(...args);
};

export const truncate = async (...args: Parameters<typeof zenPromises.truncate>) => {
  await waitForInit();
  return zenPromises.truncate(...args);
};

export const appendFile = async (...args: Parameters<typeof zenPromises.appendFile>) => {
  await waitForInit();
  return zenPromises.appendFile(...args);
};

export const realpath = async (...args: Parameters<typeof zenPromises.realpath>) => {
  await waitForInit();
  return zenPromises.realpath(...args);
};

export const link = async (...args: Parameters<typeof zenPromises.link>) => {
  await waitForInit();
  return zenPromises.link(...args);
};

export const symlink = async (...args: Parameters<typeof zenPromises.symlink>) => {
  await waitForInit();
  return zenPromises.symlink(...args);
};

export const readlink = async (...args: Parameters<typeof zenPromises.readlink>) => {
  await waitForInit();
  return zenPromises.readlink(...args);
};
