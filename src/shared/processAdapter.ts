/**
 * ProcessAdapter — abstracts Electron utilityProcess / Node.js child_process.
 *
 * Shared by AgentHost (agent spawning) and ServerProcessManager (server spawning).
 */

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
        const mod = require("electron");
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
  env: Record<string, string | undefined>
): ProcessAdapter {
  const { fork } = require("child_process") as typeof import("child_process");
  const proc = fork(bundlePath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: env as NodeJS.ProcessEnv,
  });
  const adapter: ProcessAdapter = {
    postMessage: (msg) => proc.send!(msg as import("child_process").Serializable),
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
