/**
 * Virtual type definitions for NatStack type checking.
 *
 * These definitions are loaded by the TypeCheckService to provide accurate
 * type information for shimmed APIs (fs, globals) without requiring external
 * tsconfig or node_modules setup.
 */

import { FS_INTERFACES, BUFFER_ENCODING_TYPE } from "./shared-types.js";

export { NATSTACK_RUNTIME_TYPES } from "./natstack-runtime.js";
export { loadNatstackPackageTypes, loadSinglePackageTypes, findPackagesDir, type NatstackPackageTypes } from "./load-natstack-types.js";
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
 * Type definitions for Node.js built-in modules (child_process, os, etc.)
 * Workers run in Node.js context and need these types.
 */
export const NODE_BUILTIN_TYPE_STUBS = `
declare module "child_process" {
  import type { Readable, Writable } from "stream";

  interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: "pipe" | "ignore" | "inherit" | Array<"pipe" | "ignore" | "inherit" | null | undefined | number>;
    shell?: boolean | string;
    detached?: boolean;
    timeout?: number;
    signal?: AbortSignal;
    windowsHide?: boolean;
    uid?: number;
    gid?: number;
  }

  interface ExecOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    encoding?: BufferEncoding | "buffer";
    shell?: string;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    killSignal?: string | number;
    uid?: number;
    gid?: number;
    windowsHide?: boolean;
  }

  interface ChildProcess {
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    pid?: number;
    exitCode: number | null;
    signalCode: string | null;
    killed: boolean;
    connected: boolean;
    kill(signal?: string | number): boolean;
    send(message: unknown, callback?: (error: Error | null) => void): boolean;
    disconnect(): void;
    unref(): void;
    ref(): void;
    on(event: "close", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "disconnect", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
    on(event: "message", listener: (message: unknown) => void): this;
    on(event: "spawn", listener: () => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
  }

  export function spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess;
  export function exec(command: string, callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
  export function exec(command: string, options: ExecOptions, callback?: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void): ChildProcess;
  export function execSync(command: string, options?: ExecOptions & { encoding?: BufferEncoding }): string;
  export function execSync(command: string, options?: ExecOptions & { encoding: "buffer" }): Buffer;
  export function execFile(file: string, args?: string[], callback?: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess;
  export function execFile(file: string, args?: string[], options?: ExecOptions, callback?: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void): ChildProcess;
  export function fork(modulePath: string, args?: string[], options?: SpawnOptions): ChildProcess;
  export function spawnSync(command: string, args?: string[], options?: SpawnOptions): {
    pid: number;
    output: (string | Buffer | null)[];
    stdout: string | Buffer;
    stderr: string | Buffer;
    status: number | null;
    signal: string | null;
    error?: Error;
  };
}

declare module "os" {
  export function hostname(): string;
  export function homedir(): string;
  export function tmpdir(): string;
  export function platform(): NodeJS.Platform;
  export function arch(): string;
  export function type(): string;
  export function release(): string;
  export function uptime(): number;
  export function totalmem(): number;
  export function freemem(): number;
  export function cpus(): Array<{
    model: string;
    speed: number;
    times: { user: number; nice: number; sys: number; idle: number; irq: number };
  }>;
  export function networkInterfaces(): Record<string, Array<{
    address: string;
    netmask: string;
    family: "IPv4" | "IPv6";
    mac: string;
    internal: boolean;
    cidr: string | null;
  }> | undefined>;
  export function loadavg(): [number, number, number];
  export function userInfo(options?: { encoding?: BufferEncoding }): {
    uid: number;
    gid: number;
    username: string;
    homedir: string;
    shell: string | null;
  };
  export const EOL: string;
  export const devNull: string;
  export function version(): string;
  export function machine(): string;
}

declare module "stream" {
  export class Readable {
    readable: boolean;
    readableEncoding: BufferEncoding | null;
    readableEnded: boolean;
    readableFlowing: boolean | null;
    readableHighWaterMark: number;
    readableLength: number;
    read(size?: number): string | Buffer | null;
    setEncoding(encoding: BufferEncoding): this;
    pause(): this;
    resume(): this;
    isPaused(): boolean;
    pipe<T extends Writable>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: Writable): this;
    on(event: "close", listener: () => void): this;
    on(event: "data", listener: (chunk: Buffer | string) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "readable", listener: () => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    destroy(error?: Error): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
  }

  export class Writable {
    writable: boolean;
    writableEnded: boolean;
    writableFinished: boolean;
    writableHighWaterMark: number;
    writableLength: number;
    write(chunk: string | Buffer, callback?: (error: Error | null | undefined) => void): boolean;
    write(chunk: string | Buffer, encoding?: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
    end(callback?: () => void): this;
    end(chunk: string | Buffer, callback?: () => void): this;
    end(chunk: string | Buffer, encoding?: BufferEncoding, callback?: () => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "drain", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "finish", listener: () => void): this;
    on(event: "pipe", listener: (src: Readable) => void): this;
    on(event: "unpipe", listener: (src: Readable) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    destroy(error?: Error): this;
  }

  export class Duplex extends Readable {
    writable: boolean;
    write(chunk: string | Buffer, callback?: (error: Error | null | undefined) => void): boolean;
    write(chunk: string | Buffer, encoding?: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
    end(callback?: () => void): this;
    end(chunk: string | Buffer, callback?: () => void): this;
    end(chunk: string | Buffer, encoding?: BufferEncoding, callback?: () => void): this;
  }

  export class Transform extends Duplex {
    _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer | string) => void): void;
    _flush(callback: (error?: Error | null, data?: Buffer | string) => void): void;
  }
}

declare module "events" {
  export class EventEmitter {
    addListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    on(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    once(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    removeListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    off(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    removeAllListeners(eventName?: string | symbol): this;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
    listeners(eventName: string | symbol): Function[];
    rawListeners(eventName: string | symbol): Function[];
    emit(eventName: string | symbol, ...args: unknown[]): boolean;
    listenerCount(eventName: string | symbol): number;
    prependListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    prependOnceListener(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
    eventNames(): (string | symbol)[];
    static defaultMaxListeners: number;
  }
  export default EventEmitter;
}

declare module "util" {
  export function promisify<T extends (...args: unknown[]) => void>(fn: T): (...args: Parameters<T>) => Promise<unknown>;
  export function inspect(object: unknown, options?: { showHidden?: boolean; depth?: number | null; colors?: boolean; customInspect?: boolean; showProxy?: boolean; maxArrayLength?: number | null; maxStringLength?: number | null; breakLength?: number; compact?: boolean | number; sorted?: boolean | ((a: string, b: string) => number); getters?: boolean | "get" | "set" }): string;
  export function format(format?: unknown, ...params: unknown[]): string;
  export function formatWithOptions(inspectOptions: object, format?: unknown, ...params: unknown[]): string;
  export function debuglog(section: string, callback?: (fn: (...args: unknown[]) => void) => void): (...args: unknown[]) => void;
  export function deprecate<T extends Function>(fn: T, message: string, code?: string): T;
  export function isDeepStrictEqual(val1: unknown, val2: unknown): boolean;
  export function callbackify<T>(fn: () => Promise<T>): (callback: (err: Error | null, result?: T) => void) => void;
  export const types: {
    isAnyArrayBuffer(value: unknown): value is ArrayBuffer | SharedArrayBuffer;
    isArrayBuffer(value: unknown): value is ArrayBuffer;
    isAsyncFunction(value: unknown): value is Function;
    isBooleanObject(value: unknown): value is Boolean;
    isBoxedPrimitive(value: unknown): boolean;
    isDataView(value: unknown): value is DataView;
    isDate(value: unknown): value is Date;
    isGeneratorFunction(value: unknown): boolean;
    isGeneratorObject(value: unknown): boolean;
    isMap(value: unknown): value is Map<unknown, unknown>;
    isMapIterator(value: unknown): boolean;
    isNativeError(value: unknown): value is Error;
    isNumberObject(value: unknown): value is Number;
    isPromise(value: unknown): value is Promise<unknown>;
    isProxy(value: unknown): boolean;
    isRegExp(value: unknown): value is RegExp;
    isSet(value: unknown): value is Set<unknown>;
    isSetIterator(value: unknown): boolean;
    isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer;
    isStringObject(value: unknown): value is String;
    isSymbolObject(value: unknown): value is Symbol;
    isTypedArray(value: unknown): value is NodeJS.TypedArray;
    isWeakMap(value: unknown): value is WeakMap<object, unknown>;
    isWeakSet(value: unknown): value is WeakSet<object>;
  };
}

declare namespace NodeJS {
  type TypedArray = Int8Array | Uint8Array | Uint8ClampedArray | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array;

  interface ErrnoException extends Error {
    errno?: number;
    code?: string;
    path?: string;
    syscall?: string;
  }
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

// Type aliases for Node.js fs compatibility
export type Stats = FileStats;
export type { Dirent, FileStats, FileHandle };

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
export function mkdtemp(prefix: string): Promise<string>;

// fs module has promises property and default export
export const promises: RuntimeFs & { mkdtemp(prefix: string): Promise<string> };
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

/**
 * Node.js process global.
 */
declare const process: {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  arch: string;
  version: string;
  versions: Record<string, string>;
  cwd(): string;
  chdir(directory: string): void;
  exit(code?: number): never;
  argv: string[];
  execPath: string;
  pid: number;
  ppid: number;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  hrtime: {
    (time?: [number, number]): [number, number];
    bigint(): bigint;
  };
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
};

declare namespace NodeJS {
  type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32";

  interface ReadStream {
    read(size?: number): string | Buffer | null;
    setEncoding(encoding: string): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  interface WriteStream {
    write(chunk: string | Buffer): boolean;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  interface ErrnoException extends Error {
    errno?: number;
    code?: string;
    path?: string;
    syscall?: string;
  }
}

/**
 * Node.js Buffer global.
 */
declare class Buffer {
  static from(data: string | ArrayBuffer | Buffer | number[], encoding?: string): Buffer;
  static alloc(size: number, fill?: number | string | Buffer): Buffer;
  static allocUnsafe(size: number): Buffer;
  static isBuffer(obj: unknown): obj is Buffer;
  static concat(list: Buffer[], totalLength?: number): Buffer;
  static byteLength(string: string, encoding?: string): number;

  length: number;
  toString(encoding?: string, start?: number, end?: number): string;
  toJSON(): { type: "Buffer"; data: number[] };
  slice(start?: number, end?: number): Buffer;
  copy(target: Buffer, targetStart?: number, sourceStart?: number, sourceEnd?: number): number;
  write(string: string, offset?: number, length?: number, encoding?: string): number;
  readUInt8(offset: number): number;
  readUInt16LE(offset: number): number;
  readUInt32LE(offset: number): number;
  readInt8(offset: number): number;
  readInt16LE(offset: number): number;
  readInt32LE(offset: number): number;
  writeUInt8(value: number, offset: number): number;
  writeUInt16LE(value: number, offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  writeInt8(value: number, offset: number): number;
  writeInt16LE(value: number, offset: number): number;
  writeInt32LE(value: number, offset: number): number;
  [index: number]: number;
}
`;
