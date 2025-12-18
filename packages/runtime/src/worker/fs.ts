/**
 * Worker filesystem adapter.
 *
 * Wraps Node.js fs module (which is the scoped fs shim at build time)
 * to provide a RuntimeFs interface for the worker runtime.
 *
 * The actual path scoping is handled by the build-time esbuild plugin
 * (createScopedFsShimPlugin) which intercepts `import "fs"` and injects
 * a scoped implementation that validates all paths against __natstackFsRoot.
 */

import type { RuntimeFs, FileStats, FileHandle, MkdirOptions, RmOptions } from "../types.js";

// =============================================================================
// Node.js fs module types (local definitions)
// =============================================================================
// These interfaces define the subset of Node's fs module that we use.
// We define them locally rather than importing from @types/node because:
// 1. @natstack/runtime must work in both browser (panel) and Node (worker) contexts
// 2. Adding @types/node would pollute the type environment for panel code
// 3. These serve as documentation for what the scoped fs shim must implement
// =============================================================================

/**
 * Node.js fs module type (subset we use).
 * This matches the interface of Node's fs module and our scoped fs shim.
 */
interface NodeFsModule {
  promises: {
    readFile(path: string, options?: { encoding?: BufferEncoding }): Promise<Buffer | string>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<NodeStats>;
    lstat(path: string): Promise<NodeStats>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
    rmdir(path: string): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
    unlink(path: string): Promise<void>;
    access(path: string, mode?: number): Promise<void>;
    appendFile(path: string, data: string | Uint8Array): Promise<void>;
    copyFile(src: string, dest: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    realpath(path: string): Promise<string>;
    open(path: string, flags?: string, mode?: number): Promise<NodeFileHandle>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    truncate(path: string, len?: number): Promise<void>;
  };
  existsSync(path: string): boolean;
}

interface NodeStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: Date;
  ctime: Date;
  mode: number;
}

interface NodeFileHandle {
  fd: number;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null
  ): Promise<{ bytesWritten: number }>;
  close(): Promise<void>;
  stat(): Promise<NodeStats>;
}

function wrapStats(stats: NodeStats): FileStats {
  return {
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
    size: stats.size,
    mtime: stats.mtime instanceof Date ? stats.mtime.toISOString() : String(stats.mtime),
    ctime: stats.ctime instanceof Date ? stats.ctime.toISOString() : String(stats.ctime),
    mode: stats.mode,
  };
}

/**
 * Create a RuntimeFs from a Node.js fs module.
 *
 * This is used by workers where `import "fs"` is intercepted at build time
 * and replaced with the scoped fs shim. The shim provides a Node.js-compatible
 * fs interface with path validation.
 */
export function createWorkerFsFromNodeFs(nodeFs: NodeFsModule): RuntimeFs {
  const { promises: fsp } = nodeFs;

  return {
    async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
      if (encoding) {
        return fsp.readFile(path, { encoding }) as Promise<string>;
      }
      const buffer = await fsp.readFile(path);
      return new Uint8Array(buffer as Buffer);
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      await fsp.writeFile(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      return fsp.readdir(path);
    },

    async stat(path: string): Promise<FileStats> {
      return wrapStats(await fsp.stat(path));
    },

    async lstat(path: string): Promise<FileStats> {
      return wrapStats(await fsp.lstat(path));
    },

    async mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
      await fsp.mkdir(path, options);
      return undefined;
    },

    async rmdir(path: string): Promise<void> {
      await fsp.rmdir(path);
    },

    async rm(path: string, options?: RmOptions): Promise<void> {
      await fsp.rm(path, options);
    },

    async exists(path: string): Promise<boolean> {
      // Use sync version since it's simpler and the scoped shim supports it
      try {
        return nodeFs.existsSync(path);
      } catch {
        return false;
      }
    },

    async unlink(path: string): Promise<void> {
      await fsp.unlink(path);
    },

    async access(path: string, mode?: number): Promise<void> {
      await fsp.access(path, mode);
    },

    async appendFile(path: string, data: string | Uint8Array): Promise<void> {
      await fsp.appendFile(path, data);
    },

    async copyFile(src: string, dest: string): Promise<void> {
      await fsp.copyFile(src, dest);
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      await fsp.rename(oldPath, newPath);
    },

    async realpath(path: string): Promise<string> {
      return fsp.realpath(path);
    },

    async open(path: string, flags?: string, mode?: number): Promise<FileHandle> {
      const handle = await fsp.open(path, flags, mode);
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
          const result = await handle.write(buffer, offset, length, position);
          return { bytesWritten: result.bytesWritten, buffer };
        },
        async close(): Promise<void> {
          await handle.close();
        },
        async stat(): Promise<FileStats> {
          return wrapStats(await handle.stat());
        },
      };
    },

    async readlink(path: string): Promise<string> {
      return fsp.readlink(path);
    },

    async symlink(target: string, path: string): Promise<void> {
      await fsp.symlink(target, path);
    },

    async chmod(path: string, mode: number): Promise<void> {
      await fsp.chmod(path, mode);
    },

    async chown(path: string, uid: number, gid: number): Promise<void> {
      await fsp.chown(path, uid, gid);
    },

    async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
      await fsp.utimes(path, atime, mtime);
    },

    async truncate(path: string, len?: number): Promise<void> {
      await fsp.truncate(path, len);
    },
  };
}
