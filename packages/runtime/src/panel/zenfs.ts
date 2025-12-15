/**
 * ZenFS provider for panels with immediate initialization.
 *
 * Initialization starts on module load (not lazy). The `fsReady` promise
 * can be awaited if you need to know when initialization is complete,
 * but each fs method also awaits it internally.
 */

import { configureSingle, promises as zenPromises } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import type { RuntimeFs, FileStats } from "../types.js";
import { toFileStats } from "../shared/fs-utils.js";

const INIT_TIMEOUT_MS = 30000; // 30 seconds - WebAccess can be slow on first init

// Start initialization immediately on module load
const initPromise = (async () => {
  if (!("storage" in navigator) || typeof navigator.storage.getDirectory !== "function") {
    throw new Error(
      "[NatStack] OPFS is unavailable in this browser. " +
        "The filesystem API requires OPFS support. " +
        "Please use a modern browser with OPFS enabled (Chrome 102+, Edge 102+, Safari 15.2+)."
    );
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const configPromise = (async () => {
    console.log("[NatStack] Getting OPFS directory handle...");
    const handle = await navigator.storage.getDirectory();
    console.log("[NatStack] Got OPFS handle, configuring ZenFS WebAccess backend...");
    await configureSingle({ backend: WebAccess, handle });
    console.log("[NatStack] ZenFS WebAccess backend configured successfully");
  })();

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

  try {
    await Promise.race([configPromise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
})();

/**
 * Promise that resolves when ZenFS is initialized.
 * Initialization starts immediately on module load.
 */
export const fsReady: Promise<void> = initPromise;

/**
 * RuntimeFs implementation backed by ZenFS.
 * Each method awaits fsReady internally, so callers don't need to wait.
 */
export const fs: RuntimeFs = {
  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
    await fsReady;
    const data = await zenPromises.readFile(path, encoding as BufferEncoding | undefined);
    if (typeof data === "string") return data;
    return new Uint8Array(data);
  },

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await fsReady;
    await zenPromises.writeFile(path, data, typeof data === "string" ? "utf-8" : undefined);
  },

  async readdir(path: string): Promise<string[]> {
    await fsReady;
    return zenPromises.readdir(path) as Promise<string[]>;
  },

  async stat(path: string): Promise<FileStats> {
    await fsReady;
    return toFileStats(await zenPromises.stat(path));
  },

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    await fsReady;
    await zenPromises.mkdir(path, options);
    return undefined;
  },

  async rmdir(path: string): Promise<void> {
    await fsReady;
    await zenPromises.rmdir(path);
  },

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fsReady;
    await zenPromises.rm(path, options as Parameters<typeof zenPromises.rm>[1]);
  },

  async exists(path: string): Promise<boolean> {
    await fsReady;
    try {
      await zenPromises.access(path);
      return true;
    } catch {
      return false;
    }
  },

  async unlink(path: string): Promise<void> {
    await fsReady;
    await zenPromises.unlink(path);
  },
};
