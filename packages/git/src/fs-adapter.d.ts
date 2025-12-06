import type { FsClient } from "isomorphic-git";
/**
 * Minimal fs/promises interface that can be adapted to isomorphic-git's FsClient.
 * This is what ZenFS and Node's fs/promises provide.
 */
export interface FsPromisesLike {
    readFile(path: string, encoding?: BufferEncoding): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<string | undefined>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{
        isDirectory(): boolean;
        isFile(): boolean;
    }>;
    access?(path: string): Promise<void>;
}
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
export declare function createFsAdapter(fsPromises: FsPromisesLike): FsClient;
//# sourceMappingURL=fs-adapter.d.ts.map