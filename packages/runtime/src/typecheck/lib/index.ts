/**
 * Virtual type definitions for NatStack type checking.
 *
 * These definitions are loaded by the TypeCheckService to provide accurate
 * type information for shimmed APIs (fs, globals) without requiring external
 * tsconfig or node_modules setup.
 */

import { FS_INTERFACES, BUFFER_ENCODING_TYPE } from "./shared-types.js";

export { NATSTACK_RUNTIME_TYPES } from "./natstack-runtime.js";
export { NATSTACK_PACKAGE_TYPES, type NatstackPackageTypes } from "./natstack-packages.js";
export { BUFFER_ENCODING_TYPE };

/**
 * Minimal Zod type stubs for type checking.
 * Provides basic type information for @natstack/runtime's z export.
 */
export const ZOD_TYPE_STUBS = `
declare module "zod" {
  export interface ZodType<T = unknown> {
    parse(data: unknown): T;
    safeParse(data: unknown): { success: true; data: T } | { success: false; error: ZodError };
    optional(): ZodType<T | undefined>;
    nullable(): ZodType<T | null>;
  }

  export interface ZodError {
    issues: { message: string; path: (string | number)[] }[];
  }

  export const z: {
    string(): ZodType<string>;
    number(): ZodType<number>;
    boolean(): ZodType<boolean>;
    object<T extends Record<string, ZodType>>(shape: T): ZodType<{ [K in keyof T]: T[K] extends ZodType<infer U> ? U : never }>;
    array<T>(schema: ZodType<T>): ZodType<T[]>;
    union<T extends ZodType[]>(types: T): ZodType<T[number] extends ZodType<infer U> ? U : never>;
    enum<T extends string>(values: readonly T[]): ZodType<T>;
    literal<T>(value: T): ZodType<T>;
    any(): ZodType<unknown>;
    unknown(): ZodType<unknown>;
  };

  export type { ZodType as ZodSchema };
  export type infer<T extends ZodType> = T extends ZodType<infer U> ? U : never;
}
`;

/**
 * Type definitions for the fs shim.
 * Maps to @natstack/runtime's RuntimeFs interface.
 *
 * Uses shared interfaces from shared-types.ts to avoid duplication.
 */
export const FS_TYPE_DEFINITIONS = `${FS_INTERFACES}

/**
 * fs constants for access mode checking.
 */
declare const constants: {
  /** File exists */
  F_OK: 0;
  /** File is readable */
  R_OK: 4;
  /** File is writable */
  W_OK: 2;
  /** File is executable */
  X_OK: 1;
  /** Fail if dest exists */
  COPYFILE_EXCL: 1;
  /** Use copy-on-write if available */
  COPYFILE_FICLONE: 2;
  /** Force copy-on-write */
  COPYFILE_FICLONE_FORCE: 4;
  /** Open for reading only */
  O_RDONLY: 0;
  /** Open for writing only */
  O_WRONLY: 1;
  /** Open for reading and writing */
  O_RDWR: 2;
  /** Create file if it doesn't exist */
  O_CREAT: 64;
  /** Fail if file exists */
  O_EXCL: 128;
  /** Truncate file */
  O_TRUNC: 512;
  /** Append to file */
  O_APPEND: 1024;
  /** Synchronous I/O */
  O_SYNC: 1052672;
  /** File type mask */
  S_IFMT: 61440;
  /** Regular file */
  S_IFREG: 32768;
  /** Directory */
  S_IFDIR: 16384;
  /** Character device */
  S_IFCHR: 8192;
  /** Block device */
  S_IFBLK: 24576;
  /** FIFO */
  S_IFIFO: 4096;
  /** Symbolic link */
  S_IFLNK: 40960;
  /** Socket */
  S_IFSOCK: 49152;
};

declare const fs: RuntimeFs;

// Named exports matching the shim
export const readFile: RuntimeFs["readFile"];
export const writeFile: RuntimeFs["writeFile"];
export const readdir: RuntimeFs["readdir"];
export const stat: RuntimeFs["stat"];
export const lstat: RuntimeFs["lstat"];
export const mkdir: RuntimeFs["mkdir"];
export const rmdir: RuntimeFs["rmdir"];
export const rm: RuntimeFs["rm"];
export const unlink: RuntimeFs["unlink"];
export const exists: RuntimeFs["exists"];
export const access: RuntimeFs["access"];
export const appendFile: RuntimeFs["appendFile"];
export const copyFile: RuntimeFs["copyFile"];
export const rename: RuntimeFs["rename"];
export const realpath: RuntimeFs["realpath"];
export const open: RuntimeFs["open"];
export const readlink: RuntimeFs["readlink"];
export const symlink: RuntimeFs["symlink"];
export const chmod: RuntimeFs["chmod"];
export const chown: RuntimeFs["chown"];
export const utimes: RuntimeFs["utimes"];
export const truncate: RuntimeFs["truncate"];

// fs module has promises property and default export
export const promises: RuntimeFs;
export { constants };
export default fs;
`;

/**
 * Type definitions for the path shim.
 * Maps to pathe which is browser-compatible and API-identical to Node's path.
 */
export const PATH_TYPE_DEFINITIONS = `
/**
 * Browser-compatible path utilities (pathe).
 * API-identical to Node.js path module.
 */

/** Path separator for the current platform */
export const sep: string;

/** Path delimiter for the current platform (: on POSIX, ; on Windows) */
export const delimiter: string;

/** POSIX-specific path methods */
export const posix: typeof import("path");

/** Windows-specific path methods */
export const win32: typeof import("path");

/**
 * Normalize a path, resolving '..' and '.' segments.
 */
export function normalize(p: string): string;

/**
 * Join path segments.
 */
export function join(...paths: string[]): string;

/**
 * Resolve a sequence of paths to an absolute path.
 */
export function resolve(...paths: string[]): string;

/**
 * Determine if a path is absolute.
 */
export function isAbsolute(p: string): boolean;

/**
 * Get the relative path from 'from' to 'to'.
 */
export function relative(from: string, to: string): string;

/**
 * Get the directory name of a path.
 */
export function dirname(p: string): string;

/**
 * Get the base name of a path.
 */
export function basename(p: string, ext?: string): string;

/**
 * Get the extension of a path.
 */
export function extname(p: string): string;

/**
 * Format a path object into a path string.
 */
export function format(pathObject: {
  root?: string;
  dir?: string;
  base?: string;
  ext?: string;
  name?: string;
}): string;

/**
 * Parse a path string into a path object.
 */
export function parse(p: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
};

/**
 * Convert path to a namespaced path (Windows only, no-op on POSIX).
 */
export function toNamespacedPath(p: string): string;
`;

/**
 * Global type definitions for NatStack panels/workers.
 */
export const GLOBAL_TYPE_DEFINITIONS = `
/**
 * NatStack global module map for shared dependencies.
 */
declare const __natstackModuleMap__: Record<string, unknown>;

/**
 * NatStack require function for pre-bundled modules.
 */
declare function __natstackRequire__(specifier: string): unknown;

/**
 * NatStack async require for CDN-loaded modules.
 */
declare function __natstackRequireAsync__(specifier: string): Promise<unknown>;

/**
 * Preload multiple modules from CDN.
 */
declare function __natstackPreloadModules__(specifiers: string[]): Promise<void>;

/**
 * Async tracking context for promise management.
 */
interface AsyncTrackingContext {
  id: string;
}

/**
 * NatStack async tracking API.
 */
declare const __natstackAsyncTracking__: {
  start(options?: { maxTimeout?: number }): AsyncTrackingContext;
  enter(ctx: AsyncTrackingContext): void;
  exit(): void;
  stop(ctx: AsyncTrackingContext): void;
  pause(ctx: AsyncTrackingContext): void;
  resume(ctx: AsyncTrackingContext): void;
  ignore<T extends Promise<unknown>>(p: T): T;
  waitAll(timeoutMs: number, ctx?: AsyncTrackingContext): Promise<void>;
  pending(ctx?: AsyncTrackingContext): number;
  activeContexts(): { id: string; pending: number }[];
};
`;
