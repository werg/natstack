import type { Buffer } from "buffer";

export type ThemeAppearance = "light" | "dark";

export interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: string;
  ctime: string;
  /** Unix-style file mode (e.g. 0o644). Required by isomorphic-git. */
  mode: number;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * Options for opening a file.
 */
export interface OpenOptions {
  flags?: string;
  mode?: number;
}

/**
 * File handle returned by open().
 */
export interface FileHandle {
  fd: number;
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  // A string is encoded (utf-8) and the 2nd arg is the file position (Node's `write(string[, position[, encoding]])`).
  write(buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }>;
  close(): Promise<void>;
  stat(): Promise<FileStats>;
}

/**
 * Directory entry returned by readdir({ withFileTypes: true }).
 * Compatible with Node's fs.Dirent.
 */
export interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Options for readdir.
 */
export interface ReaddirOptions {
  withFileTypes?: boolean;
}

/**
 * Filesystem interface for panels and workers.
 * Compatible with Node's fs/promises and @natstack/git's FsPromisesLike.
 */
export interface RuntimeFs {
  /**
   * `fs.constants` — mode bits for `access()`.
   * Matches Node's `fs.constants` values so code written against
   * `node:fs/promises` can be ported as a near-pure import swap.
   */
  readonly constants: {
    readonly F_OK: 0;
    readonly R_OK: 4;
    readonly W_OK: 2;
    readonly X_OK: 1;
  };
  /**
   * Create a unique temp file path inside the context's `.tmp/` directory and
   * return it (relative to the context root, with a leading `/`). The file
   * itself is not created — callers use the returned path for atomic writes
   * (write to tmp → rename into place). Analogous to the pattern used around
   * `os.tmpdir()` in Node tools.
   */
  mktemp(prefix?: string): Promise<string>;
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  // Extensions beyond FsPromisesLike
  rm(path: string, options?: RmOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  // Additional methods for broader compatibility
  access(path: string, mode?: number): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realpath(path: string): Promise<string>;
  open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
  readlink(path: string): Promise<string>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
  truncate(path: string, len?: number): Promise<void>;
}
