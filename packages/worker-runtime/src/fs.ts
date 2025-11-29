/**
 * Filesystem proxy for workers.
 *
 * This module uses the unified __serviceCall global to proxy filesystem
 * operations through IPC to the main process which uses @natstack/scoped-fs
 * to enforce filesystem boundaries.
 */

import type { WorkerFs, FileStats, MkdirOptions, RmOptions } from "./types.js";

// Declare the unified service call global
declare const __serviceCall: (
  service: string,
  method: string,
  ...args: unknown[]
) => Promise<unknown>;

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
      return (await __serviceCall("fs", "readFile", path, encoding)) as string;
    }
    // Binary mode: receive base64, decode to Uint8Array
    const base64 = (await __serviceCall("fs", "readFile", path, null)) as string;
    return decodeBase64(base64);
  },

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    if (typeof data === "string") {
      // Text mode: send string directly
      await __serviceCall("fs", "writeFile", path, data, "utf-8");
    } else {
      // Binary mode: encode as base64
      await __serviceCall("fs", "writeFile", path, encodeBase64(data), "base64");
    }
  },

  async readdir(path: string): Promise<string[]> {
    return (await __serviceCall("fs", "readdir", path)) as string[];
  },

  async stat(path: string): Promise<FileStats> {
    return (await __serviceCall("fs", "stat", path)) as FileStats;
  },

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await __serviceCall("fs", "mkdir", path, options);
  },

  async rm(path: string, options?: RmOptions): Promise<void> {
    await __serviceCall("fs", "rm", path, options);
  },

  async exists(path: string): Promise<boolean> {
    return (await __serviceCall("fs", "exists", path)) as boolean;
  },

  async unlink(path: string): Promise<void> {
    await __serviceCall("fs", "unlink", path);
  },
};
