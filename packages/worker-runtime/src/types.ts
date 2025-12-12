/**
 * Type definitions for worker runtime.
 */

/**
 * File stats returned by fs.stat()
 */
export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ctime: string;
}

/*
 * Options for fs.mkdir()
 */
export interface MkdirOptions {
  recursive?: boolean;
}

/**
 * Options for fs.rm()
 */
export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * Filesystem API available in workers.
 */
export interface WorkerFs {
  /**
   * Read a file as string (with encoding) or Uint8Array (without encoding).
   * @param path - File path (relative to worker's scope)
   * @param encoding - If provided, returns string; otherwise returns Uint8Array
   */
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;

  /**
   * Write data to a file.
   * @param path - File path (relative to worker's scope)
   * @param data - Data to write
   */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;

  /**
   * Read directory contents.
   * @param path - Directory path
   */
  readdir(path: string): Promise<string[]>;

  /**
   * Get file stats.
   * @param path - File path
   */
  stat(path: string): Promise<FileStats>;

  /**
   * Create a directory.
   * @param path - Directory path
   * @param options - Options
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>;

  /**
   * Remove a file or directory.
   * @param path - Path to remove
   * @param options - Options
   */
  rm(path: string, options?: RmOptions): Promise<void>;

  /**
   * Check if a file or directory exists.
   * @param path - Path to check
   */
  exists(path: string): Promise<boolean>;

  /**
   * Remove a file (alias for rm without recursive).
   * @param path - File path
   */
  unlink(path: string): Promise<void>;
}

/**
 * Network response from fetch.
 */
export interface FetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;

  /** Parse body as JSON */
  json<T = unknown>(): T;

  /** Get body as text */
  text(): string;

  /** Check if response was successful (2xx) */
  ok: boolean;
}

/**
 * Fetch options.
 */
export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Fetch function available in workers (if network is enabled).
 */
export type WorkerFetch = (url: string, options?: FetchOptions) => Promise<FetchResponse>;

/**
 * RPC message types.
 */
export type { RpcMessage } from "@natstack/rpc";

/**
 * Methods that can be exposed via RPC.
 */
export type ExposedMethods = Record<string, (...args: unknown[]) => unknown | Promise<unknown>>;

/**
 * RPC bridge available in workers.
 */
export interface WorkerRpc {
  /**
   * Expose methods that can be called by panels or other workers.
   * @param methods - Object mapping method names to handler functions
   */
  expose(methods: ExposedMethods): void;

  /**
   * Call a method on another endpoint (panel or worker).
   * @param targetId - Target ID (e.g., "panel:abc" or "worker:xyz")
   * @param method - Method name
   * @param args - Arguments
   */
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;

  /**
   * Emit an event to another endpoint.
   * @param targetId - Target ID
   * @param event - Event name
   * @param payload - Event payload
   */
  emit(targetId: string, event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from any endpoint.
   * @param event - Event name
   * @param listener - Callback
   * @returns Unsubscribe function
   */
  onEvent(event: string, listener: (fromId: string, payload: unknown) => void): () => void;
}
