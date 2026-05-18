/**
 * ProcessAdapter — abstracts Electron utilityProcess / Node.js child_process.
 *
 * Used by ServerProcessManager for server process spawning.
 */
import { fork as nodeFork } from "node:child_process";
import type { Serializable } from "node:child_process";
import { createRequire } from "node:module";

const requireOptional = createRequire(import.meta.url);

/**
 * Abstraction over Electron utilityProcess / Node.js child_process.
 * Covers the full surface used by consumers: message passing, lifecycle events,
 * stdio capture, and process control.
 */
export interface ProcessAdapter {
  postMessage(msg: unknown): void;
  on(event: "message", handler: (msg: unknown) => void): this;
  on(event: "exit", handler: (code: number | null) => void): this;
  on(event: "spawn", handler: () => void): this;
  off(event: string, handler: (...args: any[]) => void): this;
  removeListener(event: string, handler: (...args: any[]) => void): this;
  kill(): boolean;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid: number | undefined;
}

export interface ProcessAdapterOptions {
  execArgv?: string[];
  preferNode?: boolean;
}

/** Detect whether we're running inside Electron with a functional utilityProcess. */
let _useElectron: boolean | null = null;
export function hasElectronUtilityProcess(): boolean {
  if (_useElectron === null) {
    _useElectron = false;
    // process.versions.electron is only set when running inside the Electron runtime.
    // Without this guard, require("electron") in plain Node returns the binary path
    // (a string), so .utilityProcess would be undefined — not a usable API.
    if (process.versions["electron"]) {
      try {
        const mod = requireOptional("electron");
        _useElectron = typeof mod?.utilityProcess?.fork === "function";
      } catch {
        // electron module not loadable (shouldn't happen inside Electron, but be safe)
      }
    }
  }
  return _useElectron;
}

/**
 * Create a Node.js child_process adapter matching the ProcessAdapter interface.
 */
export function createNodeProcessAdapter(
  bundlePath: string,
  env: Record<string, string | undefined>,
  options: ProcessAdapterOptions = {},
): ProcessAdapter {
  const childEnv = {
    ...env,
    ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  const proc = nodeFork(bundlePath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: childEnv as NodeJS.ProcessEnv,
    execArgv: options.execArgv,
  });
  const adapter: ProcessAdapter = {
    postMessage: (msg) => proc.send!(msg as Serializable),
    on: (event: string, handler: (...args: any[]) => void) => {
      proc.on(event as any, handler);
      return adapter;
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      proc.off(event as any, handler);
      return adapter;
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      proc.removeListener(event as any, handler);
      return adapter;
    },
    kill: () => proc.kill(),
    stdout: proc.stdout,
    stderr: proc.stderr,
    get pid() {
      return proc.pid;
    },
  };
  return adapter;
}

/**
 * Create a process adapter using Electron utilityProcess when available, and
 * child_process.fork in standalone Node.
 */
export function createProcessAdapter(
  bundlePath: string,
  env: Record<string, string | undefined>,
  options: ProcessAdapterOptions = {},
): ProcessAdapter {
  if (options.preferNode || !hasElectronUtilityProcess()) {
    return createNodeProcessAdapter(bundlePath, env, options);
  }
  const { utilityProcess } = requireOptional("electron") as {
    utilityProcess: {
      fork(
        modulePath: string,
        args?: string[],
        options?: {
          env?: NodeJS.ProcessEnv;
          execArgv?: string[];
          stdio?: "pipe" | "inherit" | "ignore";
        },
      ): any;
    };
  };
  const proc = utilityProcess.fork(bundlePath, [], {
    env: env as NodeJS.ProcessEnv,
    execArgv: options.execArgv,
    stdio: "pipe",
  });
  const adapter: ProcessAdapter = {
    postMessage: (msg) => proc.postMessage(msg),
    on: (event: string, handler: (...args: any[]) => void) => {
      proc.on(event, handler);
      return adapter;
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      proc.off(event, handler);
      return adapter;
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      proc.removeListener(event, handler);
      return adapter;
    },
    kill: () => proc.kill(),
    stdout: proc.stdout ?? null,
    stderr: proc.stderr ?? null,
    get pid() {
      return proc.pid;
    },
  };
  return adapter;
}
