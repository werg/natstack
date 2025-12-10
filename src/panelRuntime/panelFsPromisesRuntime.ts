/**
 * fs/promises shim for browser panels.
 *
 * Re-exports the promises API from panelFsRuntime which handles
 * lazy initialization.
 *
 * This module exports individual functions (mkdir, readFile, etc.) so that
 * `import * as fs from "fs/promises"` works correctly.
 */
import { promises, ready } from "./panelFsRuntime.js";

// Re-export ready for explicit initialization
export { ready };

// Export individual methods from the promises proxy
// This allows `import { mkdir, readFile } from "fs/promises"` to work
export const access = promises.access;
export const appendFile = promises.appendFile;
export const chmod = promises.chmod;
export const chown = promises.chown;
export const copyFile = promises.copyFile;
export const cp = promises.cp;
export const lchmod = promises.lchmod;
export const lchown = promises.lchown;
export const link = promises.link;
export const lstat = promises.lstat;
export const lutimes = promises.lutimes;
export const mkdir = promises.mkdir;
export const mkdtemp = promises.mkdtemp;
export const open = promises.open;
export const opendir = promises.opendir;
export const readdir = promises.readdir;
export const readFile = promises.readFile;
export const readlink = promises.readlink;
export const realpath = promises.realpath;
export const rename = promises.rename;
export const rm = promises.rm;
export const rmdir = promises.rmdir;
export const stat = promises.stat;
export const statfs = promises.statfs;
export const symlink = promises.symlink;
export const truncate = promises.truncate;
export const unlink = promises.unlink;
export const utimes = promises.utimes;
export const watch = promises.watch;
export const writeFile = promises.writeFile;

// Default export for `import fsPromises from "fs/promises"`
export default promises;
