export type ThemeAppearance = "light" | "dark";

export type BootstrapResult = import("@natstack/git").BootstrapResult;

export interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
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
 * Filesystem interface for panels and workers.
 * Compatible with Node's fs/promises and @natstack/git's FsPromisesLike.
 */
export interface RuntimeFs {
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<FileStats>;
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  // Extensions beyond FsPromisesLike
  rm(path: string, options?: RmOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
}

