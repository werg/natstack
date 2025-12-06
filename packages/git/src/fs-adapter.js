/**
 * Create an isomorphic-git compatible FsClient from a fs/promises-like interface.
 *
 * This adapter handles the quirks that isomorphic-git requires:
 * - mkdir must always use { recursive: true } since isomorphic-git doesn't pass it
 * - readFile must return binary (Uint8Array) when no encoding is specified
 * - lstat falls back to stat (OPFS doesn't have symlinks)
 *
 * @example
 * ```typescript
 * import { createFsAdapter, GitClient } from "@natstack/git";
 * import { promises as fsPromises } from "fs"; // or ZenFS
 *
 * const fs = createFsAdapter(fsPromises);
 * const git = new GitClient(fs, { serverUrl, token });
 * ```
 */
export function createFsAdapter(fsPromises) {
    // Log-once helpers to avoid console spam for unsupported ops
    let warnedSymlink = false;
    let warnedReadlink = false;
    let warnedTypesMissing = false;
    const ensureParentDir = async (filePath) => {
        try {
            const dir = filePath.slice(0, filePath.lastIndexOf("/"));
            if (dir) {
                await fsPromises.mkdir(dir, { recursive: true });
            }
        }
        catch {
            // Best effort
        }
    };
    return {
        promises: {
            readFile: async (path, opts) => {
                if (path === undefined || path === null) {
                    const err = new Error("ENOENT: no such file or directory");
                    err.code = "ENOENT";
                    throw err;
                }
                const encoding = typeof opts === "string"
                    ? opts
                    : opts?.encoding;
                // If no encoding specified, return binary (Uint8Array)
                // isomorphic-git needs binary data for pack files, index, etc.
                try {
                    if (!encoding) {
                        return await fsPromises.readFile(path);
                    }
                    return await fsPromises.readFile(path, encoding);
                }
                catch (err) {
                    const code = err?.code;
                    if (code === "ENOENT" && path.includes("/node_modules/@types/node/")) {
                        // Ignore missing @types/node files in OPFS environments (this is expected)
                        if (!warnedTypesMissing) {
                            console.warn("[GitClient] @types/node files not available in OPFS - this is expected");
                            warnedTypesMissing = true;
                        }
                        return encoding ? "" : new Uint8Array();
                    }
                    throw err;
                }
            },
            writeFile: async (path, data) => {
                await ensureParentDir(path);
                return fsPromises.writeFile(path, data);
            },
            unlink: async (path) => {
                return fsPromises.unlink(path);
            },
            readdir: async (path) => {
                return fsPromises.readdir(path);
            },
            mkdir: async (path, _opts) => {
                // Always use recursive: true since isomorphic-git doesn't pass it
                // but expects parent directories to be created automatically
                return fsPromises.mkdir(path, { recursive: true });
            },
            rmdir: async (path) => {
                return fsPromises.rmdir(path);
            },
            stat: async (path) => {
                return fsPromises.stat(path);
            },
            lstat: async (path) => {
                // OPFS doesn't support symlinks, fall back to stat
                return fsPromises.stat(path);
            },
            readlink: async (path) => {
                // Gracefully degrade: pretend the target is the path itself.
                if (!warnedReadlink) {
                    console.warn("readlink not supported in OPFS; returning placeholder target");
                    warnedReadlink = true;
                }
                return path;
            },
            symlink: async (target, linkPath) => {
                // Best-effort noop: copy file if it exists, otherwise ignore.
                if (!warnedSymlink) {
                    console.warn("symlink not supported in OPFS; performing best-effort copy instead");
                    warnedSymlink = true;
                }
                try {
                    const data = await fsPromises.readFile(target);
                    await fsPromises.writeFile(linkPath, data);
                }
                catch {
                    // Ignore if source missing; OPFS cannot faithfully emulate symlinks.
                }
            },
            chmod: async () => {
                // No-op: OPFS doesn't support chmod
            },
        },
    };
}
//# sourceMappingURL=fs-adapter.js.map