/**
 * Notebook Kernel Types
 */

/** Console output entry captured during cell execution */
export interface ConsoleEntry {
  level: "log" | "warn" | "error" | "info" | "debug";
  args: unknown[];
  timestamp: number;
}

/** Result of a single cell execution */
export interface CellResult {
  success: boolean;
  result?: unknown;
  error?: Error;
  output: ConsoleEntry[];
  /** Names declared with const (immutable binding) */
  constNames: string[];
  /** Names declared with let/var (mutable binding) */
  mutableNames: string[];
}

/** A notebook session with persistent scope */
export interface NotebookSession {
  id: string;
  scope: Record<string, unknown>;
  /** Track which scope keys are mutable (let/var) vs const */
  mutableKeys: Set<string>;
  /** Exports from `export * from 'mod'` statements (kept separate to avoid polluting scope) */
  exports: Record<string, unknown>;
  opfsRoot?: FileSystemDirectoryHandle;
}

/** Options for creating a new session */
export interface SessionOptions {
  /** Initial bindings to inject into scope */
  bindings?: Record<string, unknown>;
  /** OPFS root for file imports */
  opfsRoot?: FileSystemDirectoryHandle;
}

/** Helpers passed to cell executor */
export interface ExecutionHelpers {
  console: ConsoleCapture;
  importModule: (specifier: string) => Promise<unknown>;
  importOPFS: (path: string) => Promise<unknown>;
  signal?: AbortSignal;
  /** Object to store exports from `export * from 'mod'` statements */
  exports?: Record<string, unknown>;
}

/** Console capture interface */
export interface ConsoleCapture {
  proxy: Console;
  getOutput: () => ConsoleEntry[];
  clear: () => void;
}

/** Result of transforming cell code */
export interface TransformResult {
  code: string;
  /** Names declared with const (immutable binding) */
  constNames: string[];
  /** Names declared with let/var (mutable binding) */
  mutableNames: string[];
}
