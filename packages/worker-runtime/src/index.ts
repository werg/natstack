/**
 * @natstack/worker-runtime
 *
 * Runtime shim for natstack isolated workers.
 * Workers import from this package to access fs, network, RPC, AI, and child management APIs.
 *
 * @example
 * ```typescript
 * import { fs, fetch, rpc, ai, createChild, setTitle } from "@natstack/worker-runtime";
 *
 * // Set worker title
 * await setTitle("My Worker");
 *
 * // Create a child panel
 * const childId = await createChild("panels/my-panel");
 *
 * // Use AI
 * const result = await ai.generate("smart", { prompt: [...] });
 *
 * // Expose RPC methods
 * rpc.expose({
 *   async processFile(path: string) {
 *     const content = await fs.readFile(path);
 *     return { size: content.length };
 *   }
 * });
 * ```
 */

// Core APIs
export { fs } from "./fs.js";
export { fetch } from "./network.js";
export { rpc } from "./rpc.js";

// Panel bridge operations (child management, git, etc.)
export {
  createChild,
  removeChild,
  setTitle,
  close,
  getEnv as fetchEnv, // Async version that fetches from main process
  getInfo,
  git,
} from "./bridge.js";

// AI capabilities
export {
  ai,
  streamText,
  generateText,
  getRoles,
  clearRoleCache,
  type StreamTextOptions,
  type StreamEvent,
  type ToolDefinition,
  type ToolExecutionResult,
  type Message,
  type SystemMessage,
  type UserMessage,
  type AssistantMessage,
  type ToolMessage,
  type TextPart,
  type FilePart,
  type ToolCallPart,
  type ToolResultPart,
} from "./ai.js";

// Re-export types for convenience
export type {
  WorkerFs,
  FileStats,
  MkdirOptions,
  RmOptions,
  WorkerFetch,
  FetchResponse,
  FetchOptions,
  WorkerRpc,
  ExposedMethods,
} from "./types.js";

// Re-export shared types from @natstack/core
export type { CreateChildOptions, GitConfig, EndpointInfo } from "@natstack/core";

// Declare globals that are available in the worker environment
declare global {
  /** Worker ID (without "worker:" prefix) */
  const __workerId: string;

  /** Environment variables passed when creating the worker */
  const __env: Record<string, string>;

  /** Console log functions injected by utility process */
  const __consoleLog: (...args: unknown[]) => void;
  const __consoleError: (...args: unknown[]) => void;
  const __consoleWarn: (...args: unknown[]) => void;
  const __consoleInfo: (...args: unknown[]) => void;

  /** Override the global console */
  // eslint-disable-next-line no-var
  var console: Console;
}

// Set up console proxy using the injected callbacks
if (typeof __consoleLog !== "undefined") {
  (globalThis as { console: Partial<Console> }).console = {
    log: __consoleLog,
    error: __consoleError,
    warn: __consoleWarn,
    info: __consoleInfo,
    debug: __consoleLog, // Map debug to log
  };
}

/**
 * Get the current worker's ID.
 */
export function getWorkerId(): string {
  return `worker:${__workerId}`;
}

/**
 * Get environment variables passed to the worker.
 */
export function getEnv(): Record<string, string> {
  return __env;
}

/**
 * Get a specific environment variable.
 */
export function getEnvVar(key: string): string | undefined {
  return __env[key];
}
