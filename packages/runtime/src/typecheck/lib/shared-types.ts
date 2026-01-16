/**
 * Shared type definition fragments used across multiple virtual type files.
 *
 * This avoids duplication between fs shim types and @natstack/runtime types.
 */

/**
 * Node.js BufferEncoding type - needed for fs.readFile and similar APIs.
 */
export const BUFFER_ENCODING_TYPE = `
/** Node.js buffer encoding types */
type BufferEncoding =
  | "ascii" | "utf8" | "utf-8" | "utf16le" | "ucs2" | "ucs-2"
  | "base64" | "base64url" | "latin1" | "binary" | "hex";
`;

/**
 * FileStats interface - used by both fs module and @natstack/runtime.
 */
export const FILE_STATS_INTERFACE = `
interface FileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtime: string;
  ctime: string;
  mode: number;
}
`;

/**
 * Mkdir options interface.
 */
export const MKDIR_OPTIONS_INTERFACE = `
interface MkdirOptions {
  recursive?: boolean;
}
`;

/**
 * Rm options interface.
 */
export const RM_OPTIONS_INTERFACE = `
interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}
`;

/**
 * FileHandle interface for low-level file operations.
 */
export const FILE_HANDLE_INTERFACE = `
interface FileHandle {
  fd: number;
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  close(): Promise<void>;
  stat(): Promise<FileStats>;
}
`;

/**
 * Dirent interface for readdir with withFileTypes.
 */
export const DIRENT_INTERFACE = `
interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
`;

/**
 * ReaddirOptions interface for readdir options.
 */
export const READDIR_OPTIONS_INTERFACE = `
interface ReaddirOptions {
  withFileTypes?: boolean;
}
`;

/**
 * RuntimeFs interface - the core async filesystem API.
 */
export const RUNTIME_FS_INTERFACE = `
interface RuntimeFs {
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
  stat(path: string): Promise<FileStats>;
  lstat(path: string): Promise<FileStats>;
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  exists(path: string): Promise<boolean>;
  access(path: string, mode?: number): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realpath(path: string): Promise<string>;
  open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
  truncate(path: string, len?: number): Promise<void>;
}
`;

/**
 * All fs-related interfaces combined.
 */
export const FS_INTERFACES = `${BUFFER_ENCODING_TYPE}
${FILE_STATS_INTERFACE}
${MKDIR_OPTIONS_INTERFACE}
${RM_OPTIONS_INTERFACE}
${FILE_HANDLE_INTERFACE}
${DIRENT_INTERFACE}
${READDIR_OPTIONS_INTERFACE}
${RUNTIME_FS_INTERFACE}`;
