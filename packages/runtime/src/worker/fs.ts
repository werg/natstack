import type { RuntimeFs, FileStats, MkdirOptions, RmOptions } from "../types.js";
import { decodeBase64, encodeBase64 } from "../shared/base64.js";
import type { RpcBridge } from "@natstack/rpc";

export type WorkerFsFactory = ((rpc: RpcBridge) => RuntimeFs) & { __natstackProvider: "rpc-factory" };

export const createWorkerFs: WorkerFsFactory = Object.assign(
  (rpc: RpcBridge): RuntimeFs => {
    return {
      async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
        if (encoding) {
          return rpc.call<string>("main", "fs.readFile", path, encoding);
        }
        const base64 = await rpc.call<string>("main", "fs.readFile", path, null);
        return decodeBase64(base64);
      },

      async writeFile(path: string, data: string | Uint8Array): Promise<void> {
        if (typeof data === "string") {
          await rpc.call("main", "fs.writeFile", path, data, "utf-8");
          return;
        }
        await rpc.call("main", "fs.writeFile", path, encodeBase64(data), "base64");
      },

      async readdir(path: string): Promise<string[]> {
        return rpc.call<string[]>("main", "fs.readdir", path);
      },

      async stat(path: string): Promise<FileStats> {
        // RPC returns plain object with boolean values, wrap with methods
        const raw = await rpc.call<{ isFile: boolean; isDirectory: boolean; size: number; mtime: string; ctime: string; mode: number }>("main", "fs.stat", path);
        return {
          isFile: () => raw.isFile,
          isDirectory: () => raw.isDirectory,
          size: raw.size,
          mtime: raw.mtime,
          ctime: raw.ctime,
          mode: raw.mode,
        };
      },

      async mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
        await rpc.call("main", "fs.mkdir", path, options);
        return undefined;
      },

      async rmdir(path: string): Promise<void> {
        await rpc.call("main", "fs.rmdir", path);
      },

      async rm(path: string, options?: RmOptions): Promise<void> {
        await rpc.call("main", "fs.rm", path, options);
      },

      async exists(path: string): Promise<boolean> {
        return rpc.call<boolean>("main", "fs.exists", path);
      },

      async unlink(path: string): Promise<void> {
        await rpc.call("main", "fs.unlink", path);
      },
    };
  },
  { __natstackProvider: "rpc-factory" as const }
);
