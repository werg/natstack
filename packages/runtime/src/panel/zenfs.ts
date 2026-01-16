/**
 * ZenFS provider for panels with immediate initialization.
 *
 * Initialization starts on module load (not lazy). The `fsReady` promise
 * can be awaited if you need to know when initialization is complete,
 * but each fs method also awaits it internally.
 */

import { configureSingle, promises as zenPromises } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import type { RuntimeFs, FileStats, Dirent, ReaddirOptions } from "../types.js";
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

  readdir: (async (path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]> => {
    await fsReady;
    if (options?.withFileTypes) {
      const entries = await zenPromises.readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        isDirectory: () => e.isDirectory(),
        isSymbolicLink: () => e.isSymbolicLink(),
      }));
    }
    return zenPromises.readdir(path) as Promise<string[]>;
  }) as RuntimeFs["readdir"],

  async stat(path: string): Promise<FileStats> {
    await fsReady;
    return toFileStats(await zenPromises.stat(path));
  },

  async lstat(path: string): Promise<FileStats> {
    await fsReady;
    return toFileStats(await zenPromises.lstat(path));
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

  async access(path: string, _mode?: number): Promise<void> {
    await fsReady;
    await zenPromises.access(path);
  },

  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    await fsReady;
    await zenPromises.appendFile(path, data);
  },

  async copyFile(src: string, dest: string): Promise<void> {
    await fsReady;
    await zenPromises.copyFile(src, dest);
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fsReady;
    await zenPromises.rename(oldPath, newPath);
  },

  async realpath(path: string): Promise<string> {
    await fsReady;
    return zenPromises.realpath(path);
  },

  async open(path: string, flags?: string, mode?: number): Promise<import("../types.js").FileHandle> {
    await fsReady;
    const handle = await zenPromises.open(path, flags, mode);
    return {
      fd: handle.fd,
      async read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }> {
        const result = await handle.read(buffer, offset, length, position ?? undefined);
        return { bytesRead: result.bytesRead, buffer };
      },
      async write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
        const result = await handle.write(buffer, offset, length, position ?? undefined);
        return { bytesWritten: result.bytesWritten, buffer };
      },
      async close(): Promise<void> {
        await handle.close();
      },
      async stat(): Promise<FileStats> {
        return toFileStats(await handle.stat());
      },
    };
  },

  async readlink(path: string): Promise<string> {
    await fsReady;
    return zenPromises.readlink(path);
  },

  async symlink(target: string, path: string): Promise<void> {
    await fsReady;
    await zenPromises.symlink(target, path);
  },

  async chmod(path: string, mode: number): Promise<void> {
    await fsReady;
    await zenPromises.chmod(path, mode);
  },

  async chown(path: string, uid: number, gid: number): Promise<void> {
    await fsReady;
    await zenPromises.chown(path, uid, gid);
  },

  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    await fsReady;
    await zenPromises.utimes(path, atime, mtime);
  },

  async truncate(path: string, len?: number): Promise<void> {
    await fsReady;
    await zenPromises.truncate(path, len);
  },
};
