/**
 * Types for @natstack/build-eval
 */

export interface EvalOptions {
  /** Language of input code */
  language: "javascript" | "typescript";

  /** Variables/functions to inject into scope */
  bindings?: Record<string, unknown>;

  /** Enable full TypeScript type checking (requires typescript library) */
  typeCheck?: boolean;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface EvalResult {
  /** Console output captured during execution */
  console: ConsoleEntry[];

  /** Top-level bindings exported/declared by the code */
  bindings: Record<string, unknown>;

  /** Return value if the code ends with an expression */
  returnValue?: unknown;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  args: unknown[];
  timestamp: number;
}

export interface ConsoleCapture {
  /** The console proxy to use during execution */
  proxy: Console;
  /** Get all captured output */
  getOutput: () => ConsoleEntry[];
  /** Clear captured output and reset state */
  clear: () => void;
}

export interface TypeCheckOptions {
  /** Language of input code */
  language: "javascript" | "typescript";
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface TypeCheckResult {
  errors: TypeCheckError[];
  warnings: TypeCheckError[];
}

export interface TypeCheckError {
  message: string;
  file?: string;
  line?: number;
  column?: number;
}
