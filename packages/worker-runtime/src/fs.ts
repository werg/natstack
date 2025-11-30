/**
 * Filesystem proxy for workers.
 *
 * This module uses the unified RPC mechanism to proxy filesystem
 * operations through IPC to the main process which uses @natstack/scoped-fs
 * to enforce filesystem boundaries.
 */

import type { WorkerFs, FileStats, MkdirOptions, RmOptions } from "./types.js";
import { rpc } from "./rpc.js";

/**
 * Encode binary data as base64 for IPC transfer.
 */
function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Filesystem API for workers.
 * All paths are relative to the worker's scoped root.
 */
export const fs: WorkerFs = {
  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
    if (encoding) {
      // Text mode: return string
      return rpc.call<string>("main", "fs.readFile", path, encoding);
    }
    // Binary mode: receive base64, decode to Uint8Array
    const base64 = await rpc.call<string>("main", "fs.readFile", path, null);
    return decodeBase64(base64);
  },

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    if (typeof data === "string") {
      // Text mode: send string directly
      await rpc.call("main", "fs.writeFile", path, data, "utf-8");
    } else {
      // Binary mode: encode as base64
      await rpc.call("main", "fs.writeFile", path, encodeBase64(data), "base64");
    }
  },

  async readdir(path: string): Promise<string[]> {
    return rpc.call<string[]>("main", "fs.readdir", path);
  },

  async stat(path: string): Promise<FileStats> {
    return rpc.call<FileStats>("main", "fs.stat", path);
  },

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await rpc.call("main", "fs.mkdir", path, options);
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
