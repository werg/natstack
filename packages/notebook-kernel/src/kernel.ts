/**
 * Notebook Kernel
 *
 * Main entry point for the notebook kernel. Manages sessions and cell execution.
 */

import { createConsoleCapture } from "./console-capture.js";
import {
  transformCellCode,
  isCellTransformAvailable,
  initializeCellTransform,
  TransformAbortError,
} from "./cell-transform.js";
import { executeCell, AbortError, TimeoutError, isValidIdentifier } from "./executor.js";
import type { ExecuteOptions } from "./executor.js";
import { createImportModule } from "./imports.js";
import { OPFSModuleLoader, createOPFSImporter } from "./opfs-loader.js";
import type { NotebookSession, CellResult, SessionOptions } from "./types.js";

export interface KernelOptions {
  /** CDN URL for bare module imports (default: esm.sh) */
  cdn?: string;
  /** Forward console output to real console for debugging */
  forwardConsole?: boolean;
  /** Default timeout for cell execution in milliseconds (0 = no timeout) */
  defaultTimeout?: number;
  /** Enable TypeScript support (requires esbuild-wasm, default: false) */
  typescript?: boolean;
  /** Enable JSX support (requires esbuild-wasm, default: false) */
  jsx?: boolean;
  /** JSX factory function (default: React.createElement) */
  jsxFactory?: string;
  /** JSX fragment function (default: React.Fragment) */
  jsxFragment?: string;
  /** Generate source maps for better error traces (default: true when ts/jsx enabled) */
  sourceMaps?: boolean;
  /** URL to esbuild.wasm file for TypeScript/JSX support */
  esbuildWasmURL?: string;
}

export interface ExecutionOptions extends ExecuteOptions {
  /** AbortSignal to cancel execution */
  signal?: AbortSignal;
}

/** Queued cell execution request */
interface QueuedExecution {
  code: string;
  options: ExecutionOptions;
  resolve: (result: CellResult) => void;
  reject: (error: Error) => void;
}

// Re-export error types
export { AbortError, TimeoutError, TransformAbortError };

/**
 * Notebook kernel that manages sessions and executes cells.
 */
export class NotebookKernel {
  private sessions = new Map<string, NotebookSession>();
  private opfsLoader: OPFSModuleLoader;
  private options: KernelOptions;
  /** Execution queues per session */
  private executionQueues = new Map<string, QueuedExecution[]>();
  /** Track sessions that are currently executing */
  private executing = new Set<string>();
  /** Counter for generating cell IDs */
  private cellCounter = 0;

  constructor(options: KernelOptions = {}) {
    this.options = options;
    this.opfsLoader = new OPFSModuleLoader();

    // Eagerly initialize esbuild if TypeScript or JSX is enabled
    if (options.typescript || options.jsx) {
      initializeCellTransform(options.esbuildWasmURL).catch((err) => {
        console.warn("Failed to initialize TypeScript/JSX support:", err);
      });
    }
  }

  /**
   * Create a new notebook session.
   *
   * @param options - Session options
   * @returns The session ID
   */
  createSession(options: SessionOptions = {}): string {
    const id = crypto.randomUUID();

    const session: NotebookSession = {
      id,
      scope: { ...options.bindings },
      mutableKeys: new Set(),
      exports: {},
      opfsRoot: options.opfsRoot,
    };

    this.sessions.set(id, session);
    this.executionQueues.set(id, []);
    return id;
  }

  /**
   * Get a session by ID.
   *
   * @param sessionId - The session ID
   * @returns The session or undefined if not found
   */
  getSession(sessionId: string): NotebookSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Execute a cell in a session.
   * Cells are queued and executed sequentially per session.
   *
   * @param sessionId - The session ID
   * @param code - The code to execute
   * @param options - Execution options (timeout, signal)
   * @returns The execution result
   */
  async execute(
    sessionId: string,
    code: string,
    options: ExecutionOptions = {}
  ): Promise<CellResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // If session is already executing, queue this execution
    if (this.executing.has(sessionId)) {
      return new Promise<CellResult>((resolve, reject) => {
        const queue = this.executionQueues.get(sessionId)!;
        queue.push({ code, options, resolve, reject });
      });
    }

    return this.executeImmediate(session, code, options);
  }

  /**
   * Execute a cell immediately (internal).
   */
  private async executeImmediate(
    session: NotebookSession,
    code: string,
    options: ExecutionOptions
  ): Promise<CellResult> {
    this.executing.add(session.id);

    try {
      const result = await this.doExecute(session, code, options);

      // Update mutableKeys with newly declared mutable names
      for (const name of result.mutableNames) {
        session.mutableKeys.add(name);
      }

      return result;
    } finally {
      this.executing.delete(session.id);
      this.processQueue(session.id);
    }
  }

  /**
   * Process the next queued execution for a session.
   * Called automatically after an execution completes.
   */
  private processQueue(sessionId: string): void {
    const queue = this.executionQueues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const session = this.sessions.get(sessionId);
    if (!session) {
      // Session was destroyed while queue had pending items - reject them all
      for (const item of queue) {
        item.reject(new Error(`Session ${sessionId} was destroyed`));
      }
      queue.length = 0;
      return;
    }

    // Process next item in queue
    const next = queue.shift()!;
    this.executeImmediate(session, next.code, next.options)
      .then(next.resolve)
      .catch(next.reject);
  }

  /**
   * Core execution logic.
   */
  private async doExecute(
    session: NotebookSession,
    code: string,
    options: ExecutionOptions
  ): Promise<CellResult> {
    // Transform TypeScript/JSX if enabled
    let codeToExecute = code;
    const shouldTransform = this.options.typescript || this.options.jsx;

    if (shouldTransform) {
      // Check if already aborted before transform
      if (options.signal?.aborted) {
        return {
          success: false,
          error: new AbortError(),
          output: [],
          constNames: [],
          mutableNames: [],
        };
      }

      try {
        const cellId = `cell-${this.cellCounter++}`;
        const transformResult = await transformCellCode(code, {
          typescript: this.options.typescript,
          jsx: this.options.jsx,
          jsxFactory: this.options.jsxFactory,
          jsxFragment: this.options.jsxFragment,
          sourceMaps: this.options.sourceMaps ?? true,
          cellId,
          signal: options.signal,
        });
        codeToExecute = transformResult.code;
      } catch (transformError) {
        // Handle abort during transformation
        if (transformError instanceof TransformAbortError) {
          return {
            success: false,
            error: new AbortError("Execution aborted during transformation"),
            output: [],
            constNames: [],
            mutableNames: [],
          };
        }
        return {
          success: false,
          error:
            transformError instanceof Error
              ? transformError
              : new Error(String(transformError)),
          output: [],
          constNames: [],
          mutableNames: [],
        };
      }
    }

    const consoleCapture = createConsoleCapture({
      forward: this.options.forwardConsole,
    });

    const importModule = createImportModule({ cdn: this.options.cdn });

    const importOPFS = session.opfsRoot
      ? createOPFSImporter(this.opfsLoader, session.opfsRoot)
      : () => {
          throw new Error("OPFS not configured for this session");
        };

    return executeCell(
      codeToExecute,
      session.scope,
      session.mutableKeys,
      {
        console: consoleCapture,
        importModule,
        importOPFS,
        signal: options.signal,
        exports: session.exports,
      },
      {
        timeout: options.timeout ?? this.options.defaultTimeout ?? 0,
      }
    );
  }

  /**
   * Inject bindings into a session's scope.
   *
   * @param sessionId - The session ID
   * @param bindings - The bindings to inject
   * @param mutable - Whether bindings should be mutable (default: true)
   * @throws Error if any binding name is not a valid JavaScript identifier
   */
  injectBindings(
    sessionId: string,
    bindings: Record<string, unknown>,
    mutable = true
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Validate all binding names before injecting
    const invalidNames: string[] = [];
    for (const name of Object.keys(bindings)) {
      if (!isValidIdentifier(name)) {
        invalidNames.push(name);
      }
    }

    if (invalidNames.length > 0) {
      throw new Error(
        `Invalid binding name(s): ${invalidNames.join(", ")}. Binding names must be valid JavaScript identifiers.`
      );
    }

    Object.assign(session.scope, bindings);
    if (mutable) {
      for (const name of Object.keys(bindings)) {
        session.mutableKeys.add(name);
      }
    }
  }

  /**
   * Get a shallow copy of the current scope of a session.
   *
   * @param sessionId - The session ID
   * @returns A shallow copy of the session scope
   */
  getScope(sessionId: string): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return { ...session.scope };
  }

  /**
   * Clear a session's scope.
   *
   * @param sessionId - The session ID
   * @param keepBindings - Optional list of binding names to preserve
   */
  resetSession(sessionId: string, keepBindings?: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Optionally keep certain bindings
    const preserved: Record<string, unknown> = {};
    const preservedMutable = new Set<string>();
    if (keepBindings) {
      for (const name of keepBindings) {
        if (name in session.scope) {
          preserved[name] = session.scope[name];
          if (session.mutableKeys.has(name)) {
            preservedMutable.add(name);
          }
        }
      }
    }

    session.scope = preserved;
    session.mutableKeys = preservedMutable;
    session.exports = {};
  }

  /**
   * Destroy a session and clean up resources.
   *
   * @param sessionId - The session ID
   */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      // Reject any queued executions
      const queue = this.executionQueues.get(sessionId);
      if (queue) {
        for (const item of queue) {
          item.reject(new Error(`Session ${sessionId} destroyed`));
        }
        this.executionQueues.delete(sessionId);
      }
    }
  }

  /**
   * Destroy all sessions and clean up.
   */
  destroy(): void {
    for (const sessionId of this.sessions.keys()) {
      this.destroySession(sessionId);
    }
    this.opfsLoader.clearCache();
  }

  /**
   * Create a snapshot of a session's state for branching.
   * Note: Functions and closures cannot be cloned.
   *
   * @param sessionId - The session ID
   * @returns A deep clone of the scope, or null if cloning fails
   */
  snapshotSession(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    try {
      return structuredClone(session.scope);
    } catch {
      // structuredClone fails with functions - return null
      return null;
    }
  }

  /**
   * Fork a session, creating a new session with a shallow copy of the scope.
   *
   * WARNING: This performs a shallow copy only. Objects, arrays, and functions
   * in the scope will be shared by reference between the original and forked sessions.
   * If you need isolation, avoid mutating shared objects or use immutable data structures.
   *
   * @param sessionId - The session ID to fork
   * @param options - Additional options for the new session
   * @returns The new session ID
   */
  forkSession(
    sessionId: string,
    options: Partial<SessionOptions> = {}
  ): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Shallow copy of scope - objects/arrays/functions are shared by reference
    const scopeCopy = { ...session.scope };

    const newId = this.createSession({
      bindings: { ...scopeCopy, ...options.bindings },
      opfsRoot: options.opfsRoot ?? session.opfsRoot,
    });

    // Copy mutableKeys to the new session
    const newSession = this.sessions.get(newId)!;
    for (const key of session.mutableKeys) {
      if (key in newSession.scope) {
        newSession.mutableKeys.add(key);
      }
    }

    return newId;
  }
}
