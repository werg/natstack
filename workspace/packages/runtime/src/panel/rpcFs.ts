/**
 * RPC-backed RuntimeFs implementation.
 *
 * Each method calls rpc.call<T>("main", "fs.{method}", ...args).
 * Binary data is encoded as { __bin: true, data: base64String } for JSON transport.
 */

import { Buffer } from "buffer";
import type { RpcBridge } from "@natstack/rpc";
import type { RuntimeFs, FileStats, Dirent, FileHandle } from "../types.js";
import { toFileStats } from "../shared/fs-utils.js";

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

interface BinaryEnvelope {
  __bin: true;
  data: string; // base64
}

function isBinaryEnvelope(v: unknown): v is BinaryEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).__bin === true &&
    typeof (v as any).data === "string"
  );
}

function encodeBinary(buf: Uint8Array): BinaryEnvelope {
  return { __bin: true, data: Buffer.from(buf).toString("base64") };
}

function decodeBinary(envelope: BinaryEnvelope): Buffer {
  return Buffer.from(envelope.data, "base64");
}

// ---------------------------------------------------------------------------
// Dirent reconstruction
// ---------------------------------------------------------------------------

interface SerializedDirent {
  name: string;
  _isFile: boolean;
  _isDirectory: boolean;
  _isSymbolicLink: boolean;
}

function toDirent(d: SerializedDirent): Dirent {
  return {
    name: d.name,
    isFile: () => d._isFile,
    isDirectory: () => d._isDirectory,
    isSymbolicLink: () => d._isSymbolicLink,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRpcFs(rpc: RpcBridge): RuntimeFs {
  function call<T>(method: string, ...args: unknown[]): Promise<T> {
    return rpc.call<T>("main", `fs.${method}`, ...args);
  }

  return {
    async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
      const result = await call<string | BinaryEnvelope>("readFile", path, encoding);
      if (isBinaryEnvelope(result)) {
        return decodeBinary(result);
      }
      return result as string;
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      const payload = typeof data === "string" ? data : encodeBinary(data);
      await call<void>("writeFile", path, payload);
    },

    readdir: (async (path: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> => {
      if (options?.withFileTypes) {
        const entries = await call<SerializedDirent[]>("readdir", path, options);
        return entries.map(toDirent);
      }
      return call<string[]>("readdir", path);
    }) as RuntimeFs["readdir"],

    async stat(path: string): Promise<FileStats> {
      return toFileStats(await call<unknown>("stat", path));
    },

    async lstat(path: string): Promise<FileStats> {
      return toFileStats(await call<unknown>("lstat", path));
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
      await call<void>("mkdir", path, options);
      return undefined;
    },

    async rmdir(path: string): Promise<void> {
      await call<void>("rmdir", path);
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      await call<void>("rm", path, options);
    },

    async exists(path: string): Promise<boolean> {
      return call<boolean>("exists", path);
    },

    async unlink(path: string): Promise<void> {
      await call<void>("unlink", path);
    },

    async access(path: string, mode?: number): Promise<void> {
      await call<void>("access", path, mode);
    },

    async appendFile(path: string, data: string | Uint8Array): Promise<void> {
      const payload = typeof data === "string" ? data : encodeBinary(data);
      await call<void>("appendFile", path, payload);
    },

    async copyFile(src: string, dest: string): Promise<void> {
      await call<void>("copyFile", src, dest);
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      await call<void>("rename", oldPath, newPath);
    },

    async realpath(path: string): Promise<string> {
      return call<string>("realpath", path);
    },

    async open(filePath: string, flags?: string, mode?: number): Promise<FileHandle> {
      const { handleId } = await call<{ handleId: number }>("open", filePath, flags, mode);

      return {
        fd: handleId,

        async read(
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null,
        ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
          const result = await call<{ bytesRead: number; buffer: BinaryEnvelope }>(
            "handleRead",
            handleId,
            length,
            position,
          );
          const decoded = decodeBinary(result.buffer);
          buffer.set(decoded, offset);
          return { bytesRead: result.bytesRead, buffer };
        },

        async write(
          buffer: Uint8Array,
          offset?: number,
          length?: number,
          position?: number | null,
        ): Promise<{ bytesWritten: number; buffer: Uint8Array }> {
          const slice = buffer.subarray(offset ?? 0, (offset ?? 0) + (length ?? buffer.length));
          const result = await call<{ bytesWritten: number }>(
            "handleWrite",
            handleId,
            encodeBinary(slice),
            position ?? null,
          );
          return { bytesWritten: result.bytesWritten, buffer };
        },

        async close(): Promise<void> {
          await call<void>("handleClose", handleId);
        },

        async stat(): Promise<FileStats> {
          return toFileStats(await call<unknown>("handleStat", handleId));
        },
      };
    },

    async readlink(path: string): Promise<string> {
      return call<string>("readlink", path);
    },

    async symlink(target: string, path: string): Promise<void> {
      await call<void>("symlink", target, path);
    },

    async chmod(path: string, mode: number): Promise<void> {
      await call<void>("chmod", path, mode);
    },

    async chown(path: string, uid: number, gid: number): Promise<void> {
      await call<void>("chown", path, uid, gid);
    },

    async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
      // Convert Date to seconds-since-epoch for JSON transport
      const a = atime instanceof Date ? atime.getTime() / 1000 : atime;
      const m = mtime instanceof Date ? mtime.getTime() / 1000 : mtime;
      await call<void>("utimes", path, a, m);
    },

    async truncate(path: string, len?: number): Promise<void> {
      await call<void>("truncate", path, len);
    },
  };
}
