/**
 * Filesystem provider that chooses between ZenFS (OPFS) and Node.js fs
 * based on the runtime environment.
 *
 * - Safe panels/workers (browser sandbox): Use ZenFS with OPFS backend
 * - Unsafe panels/workers (nodeIntegration): Use real Node.js fs module
 *
 * Detection is based on Node.js availability:
 * - typeof require === "function" (nodeIntegration enabled in Electron)
 * - process.versions?.node exists (Node.js environment)
 */

import type { RuntimeFs, FileStats, FileHandle } from "../types.js";
import { toFileStats } from "../shared/fs-utils.js";

// Detect if we have Node.js fs access (unsafe panels/workers with nodeIntegration)
const hasNodeFs = (() => {
  try {
    return (
      typeof require === "function" &&
      typeof process !== "undefined" &&
      !!process.versions?.node
    );
  } catch {
    return false;
  }
})();

// Lazy-loaded fs implementations
let _fs: RuntimeFs | null = null;
let _fsReady: Promise<void> | null = null;
let _initPromise: Promise<void> | null = null;

/**
 * Initialize the appropriate fs implementation for this environment.
 * Called once, lazily, on first fs access.
 */
async function initFs(): Promise<void> {
  if (_fs) return;

  if (hasNodeFs) {
    // Use real Node.js fs for unsafe panels/workers
    console.log("[NatStack] Using Node.js fs (nodeIntegration enabled)");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require("node:fs/promises") as typeof import("node:fs/promises");
    _fs = createNodeFsWrapper(nodeFs);
    _fsReady = Promise.resolve();
  } else {
    // Use ZenFS for safe panels/workers (browser sandbox)
    const { fs: zenFs, fsReady: zenFsReady } = await import("./zenfs.js");
    _fs = zenFs;
    _fsReady = zenFsReady;
    await zenFsReady;
  }
}

// Start initialization immediately
_initPromise = initFs().catch((err) => {
  console.error("[NatStack] Failed to initialize filesystem:", err);
  throw err;
});

/**
 * Promise that resolves when fs is ready.
 * For Node.js fs, this resolves immediately.
 * For ZenFS, this waits for OPFS initialization.
 */
export const fsReady: Promise<void> = _initPromise;

/**
 * Wrap Node.js fs/promises to match RuntimeFs interface.
 * Uses shared toFileStats for consistent stat conversion.
 */
function createNodeFsWrapper(nodeFs: typeof import("node:fs/promises")): RuntimeFs {
  return {
    async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
      if (encoding) {
        return nodeFs.readFile(path, { encoding });
      }
      const buffer = await nodeFs.readFile(path);
      return new Uint8Array(buffer);
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      await nodeFs.writeFile(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      return nodeFs.readdir(path) as Promise<string[]>;
    },

    async stat(path: string): Promise<FileStats> {
      return toFileStats(await nodeFs.stat(path));
    },

    async lstat(path: string): Promise<FileStats> {
      return toFileStats(await nodeFs.lstat(path));
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
      return nodeFs.mkdir(path, options);
    },

    async rmdir(path: string): Promise<void> {
      await nodeFs.rmdir(path);
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await nodeFs.rm(path, options);
    },

    async exists(path: string): Promise<boolean> {
      try {
        await nodeFs.access(path);
        return true;
      } catch {
        return false;
      }
    },

    async unlink(path: string): Promise<void> {
      await nodeFs.unlink(path);
    },

    async access(path: string, mode?: number): Promise<void> {
      await nodeFs.access(path, mode);
    },

    async appendFile(path: string, data: string | Uint8Array): Promise<void> {
      await nodeFs.appendFile(path, data);
    },

    async copyFile(src: string, dest: string): Promise<void> {
      await nodeFs.copyFile(src, dest);
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      await nodeFs.rename(oldPath, newPath);
    },

    async realpath(path: string): Promise<string> {
      return nodeFs.realpath(path);
    },

    async open(path: string, flags?: string, mode?: number): Promise<FileHandle> {
      const handle = await nodeFs.open(path, flags, mode);
      return {
        fd: handle.fd,
        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
          const result = await handle.read(buffer, offset, length, position);
          return { bytesRead: result.bytesRead, buffer };
        },
        async write(
          buffer: Uint8Array,
          offset?: number,
          length?: number,
          position?: number | null
        ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
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
      return nodeFs.readlink(path);
    },

    async symlink(target: string, path: string): Promise<void> {
      await nodeFs.symlink(target, path);
    },

    async chmod(path: string, mode: number): Promise<void> {
      await nodeFs.chmod(path, mode);
    },

    async chown(path: string, uid: number, gid: number): Promise<void> {
      await nodeFs.chown(path, uid, gid);
    },

    async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
      await nodeFs.utimes(path, atime, mtime);
    },

    async truncate(path: string, len?: number): Promise<void> {
      await nodeFs.truncate(path, len);
    },
  };
}

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
