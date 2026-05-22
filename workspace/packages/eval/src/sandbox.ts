/**
 * Unified sandbox execution engine.
 *
 * Consolidates logic from @workspace/agentic-tools/eval/evalTool.ts and
 * @workspace/tool-ui/src/eval/feedbackComponent.tsx into one module.
 *
 * Two entry points:
 * - executeSandbox(): imperative code execution (eval tool)
 * - compileComponent(): React component compilation (inline_ui, load_action_bar, feedback_custom)
 *
 * Both use the same transform → preload → execute pipeline from @workspace/eval.
 */

import type { ComponentType } from "react";
import { transformCode } from "./transform.js";
import {
  execute,
  executeDefault,
  getDefaultRequire,
  validateRequires,
  preloadRequires,
} from "./execute.js";
import {
  getMissingPackageDeclarations,
  inferImportsFromPackageJson,
  prepareSourceCode,
  type ExternalRequireContext,
  type LoadSourceFile,
} from "./sourceFiles.js";
import {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
} from "./consoleCapture.js";
import { getAsyncTracking } from "./asyncTracking.js";

// =============================================================================
// Types
// =============================================================================

export interface SandboxOptions {
  /** Source syntax (default: "tsx") */
  syntax?: "typescript" | "jsx" | "tsx";
  /** Packages to build and load before execution.
   *  - Workspace packages: value is "latest" or a git ref (branch/tag/SHA)
   *  - npm packages: value is "npm:<version>" (e.g. "npm:^4.17.21", "npm:latest")
   */
  imports?: Record<string, string>;
  /** Console streaming callback */
  onConsole?: (formatted: string) => void;
  /** Dynamic import loader — keeps this module free of runtime/RPC deps */
  loadImport?: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
  /** File path for this source. Enables relative imports. */
  sourcePath?: string;
  /** Preloaded source files keyed by normalized path. */
  sourceFiles?: Record<string, string>;
  /** Source-file loader for resolving relative imports. */
  loadSourceFile?: LoadSourceFile;
  /** Extra scope variables injected into the sandbox */
  bindings?: Record<string, unknown>;
}

export interface SandboxResult {
  success: boolean;
  /** Formatted console output (final) */
  consoleOutput: string;
  /** Return value (if any) */
  returnValue?: unknown;
  /** Exported values */
  exports?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
  /** Agent-facing panel operation summary, when panel runtime journaling was active. */
  panelJournalFooter?: string;
}

export interface CompileResult<T> {
  success: boolean;
  /** The compiled component/value */
  Component?: T;
  /** Cache key for cleanup */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
}

export interface CompileModuleResult<T extends Record<string, unknown> = Record<string, unknown>> {
  success: boolean;
  module?: T;
  cacheKey?: string;
  error?: string;
}

export interface CompileComponentOptions {
  /** Packages to build and load before compilation. Same semantics as eval imports. */
  imports?: Record<string, string>;
  /** Dynamic import loader — keeps this module free of runtime/RPC deps */
  loadImport?: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
  /** File path for this source. Enables relative imports. */
  sourcePath?: string;
  /** Preloaded source files keyed by normalized path. */
  sourceFiles?: Record<string, string>;
  /** Source-file loader for resolving relative imports. */
  loadSourceFile?: LoadSourceFile;
}

// =============================================================================
// Module Map Helpers
// =============================================================================

function getModuleMap(): Record<string, unknown> {
  return ((globalThis as Record<string, unknown>)["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
}

/** Tracks bundle content last loaded per specifier to skip re-execution */
const loadedBundleContent = new Map<string, string>();

/**
 * Load a CJS library bundle into the panel's module map.
 * Skips re-execution if the bundle content is identical to what's already loaded.
 */
function loadLibraryBundle(specifier: string, bundleCode: string): void {
  const moduleMap = getModuleMap();
  if (loadedBundleContent.get(specifier) === bundleCode && moduleMap[specifier]) return;

  const requireFn = (globalThis as Record<string, unknown>)["__natstackRequire__"] as ((id: string) => unknown) | undefined;
  if (!requireFn) throw new Error("__natstackRequire__ not available");

  const exports: Record<string, unknown> = {};
  const module = { exports };
  // eslint-disable-next-line no-new-func
  const fn = new Function("require", "exports", "module", bundleCode);
  fn(requireFn, exports, module);
  moduleMap[specifier] = module.exports;
  loadedBundleContent.set(specifier, bundleCode);
}

/**
 * Build and load workspace packages into the module map.
 */
async function loadImports(
  imports: Record<string, string>,
  loadImport: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>,
): Promise<void> {
  const moduleMap = getModuleMap();
  for (const [specifier, refValue] of Object.entries(imports)) {
    const ref = refValue === "latest" ? undefined : refValue;
    // Recompute externals each iteration so earlier imports are externalized
    const externals = Object.keys(moduleMap);
    const bundleCode = await loadImport(specifier, ref, externals);
    loadLibraryBundle(specifier, bundleCode);
  }
}

async function ensureRequires(
  requires: string[],
  options: {
    loadImport?: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
    loadSourceFile?: LoadSourceFile;
    sourcePath?: string;
    imports?: Record<string, string>;
  } = {},
  context?: ExternalRequireContext,
): Promise<void> {
  if (requires.length === 0) return;
  const requireFn = getDefaultRequire();
  if (!requireFn) throw new Error("__natstackRequire__ not available. Build may be outdated.");

  let validation = validateRequires(requires, requireFn);
  if (!validation.valid && options.loadImport) {
    const moduleMap = getModuleMap();
    const missing = requires.filter((r) => !moduleMap[r]);
    const inferredImports = await inferImportsFromPackageJson(
      missing,
      {
        importerPath: context?.importerPath ?? options.sourcePath,
        loadSourceFile: options.loadSourceFile,
        explicitImports: options.imports,
      },
    );

    if (Object.keys(inferredImports).length > 0) {
      await loadImports(inferredImports, options.loadImport);
      validation = validateRequires(requires, requireFn);
    }
  }

  if (!validation.valid) {
    const preload = await preloadRequires(requires);
    if (preload.success) return;
    validation = validateRequires(requires, requireFn);
  }

  if (!validation.valid) {
    const missingModules = requires.filter((r) => !getModuleMap()[r]);
    const missingDeclarations = await getMissingPackageDeclarations(missingModules, {
      importerPath: context?.importerPath ?? options.sourcePath,
      loadSourceFile: options.loadSourceFile,
      explicitImports: options.imports,
    });
    if (missingDeclarations.length > 0) {
      throw new Error(`Package import not declared for file-loaded source: ${missingDeclarations.join("; ")}. Add it to package.json dependencies or pass the imports parameter.`);
    }
    throw new Error(validation.error ?? `Module "${validation.missingModule}" not available`);
  }
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Safely serialize a value for JSON transmission.
 * Handles circular references, functions, symbols, and other non-serializable types.
 */
function safeSerialize(value: unknown, maxDepth = 10): unknown {
  const seen = new WeakSet<object>();

  function serialize(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
    if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
    if (typeof val === "symbol") return val.toString();
    if (typeof val === "bigint") return val.toString();
    if (typeof val !== "object") return String(val);
    if (depth > maxDepth) return "[Max depth exceeded]";
    if (seen.has(val)) return "[Circular]";
    seen.add(val);
    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
    if (val instanceof Map) return { __type: "Map", entries: serialize(Array.from(val.entries()), depth + 1) };
    if (val instanceof Set) return { __type: "Set", values: serialize(Array.from(val.values()), depth + 1) };
    if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer) return `[${val.constructor.name}]`;
    if (Array.isArray(val)) return val.map((item) => serialize(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(val)) {
      try { result[key] = serialize((val as Record<string, unknown>)[key], depth + 1); }
      catch { result[key] = "[Unserializable]"; }
    }
    return result;
  }

  return serialize(value, 0);
}

function wrapForTopLevelAwait(code: string): string {
  return `return (async () => {\n${code}\n})()`;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

// =============================================================================
// executeSandbox
// =============================================================================

/**
 * Unified imperative execution pipeline.
 *
 * 1. Transform code (Sucrase)
 * 2. Load dynamic imports via loadImport callback
 * 3. Preload requires
 * 4. Wrap for top-level await
 * 5. Set up console capture with streaming
 * 6. Set up async tracking
 * 7. Execute with scope bindings
 * 8. Wait for async operations
 * 9. Safe-serialize return value
 */
export async function executeSandbox(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const { syntax = "tsx", bindings = {} } = options;

  const tracking = getAsyncTracking();
  const trackingContext = tracking?.start();

  const capture = createConsoleCapture();

  // Pause tracking around onConsole so any promises created by the callback
  // (e.g. ctx.stream()) are not tracked by waitAll.
  const unsubscribe = capture.onEntry((entry) => {
    const formatted = formatConsoleEntry(entry);
    if (tracking && trackingContext) {
      tracking.pause(trackingContext);
      try {
        options.onConsole?.(formatted);
      } finally {
        tracking.resume(trackingContext);
      }
    } else {
      options.onConsole?.(formatted);
    }
  });

  try {
    // Load on-demand imports
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error("loadImport callback required when imports are specified");
      }
      await loadImports(options.imports, options.loadImport);
    }

    const prepared = await prepareSourceCode(code, {
      syntax,
      sourcePath: options.sourcePath,
      sourceFiles: options.sourceFiles,
      loadSourceFile: options.loadSourceFile,
    }, (requires, context) => ensureRequires(requires, {
      loadImport: options.loadImport,
      loadSourceFile: options.loadSourceFile,
      sourcePath: options.sourcePath,
      imports: options.imports,
    }, context));

    const transformed = await transformCode(prepared.code, { syntax });

    // Validate requires
    const requireFn = getDefaultRequire();
    if (!requireFn) {
      return {
        success: false,
        consoleOutput: "",
        error: "__natstackRequire__ not available. Build may be outdated.",
      };
    }

    let validation = validateRequires(transformed.requires, requireFn);
    if (!validation.valid && options.loadImport) {
      // Auto-resolve: build missing workspace packages on-demand
      const moduleMap = getModuleMap();
      const missingModules = transformed.requires.filter((r) => !moduleMap[r]);
      const autoImports = await inferImportsFromPackageJson(missingModules, {
        importerPath: options.sourcePath,
        loadSourceFile: options.loadSourceFile,
        explicitImports: options.imports,
      });
      if (Object.keys(autoImports).length > 0) {
        options.onConsole?.(`[eval] Auto-loading: ${Object.keys(autoImports).join(", ")}...`);
        await loadImports(autoImports, options.loadImport);
        validation = validateRequires(transformed.requires, requireFn);
      }
    }
    if (!validation.valid) {
      const missing = validation.missingModule!;
      const moduleMap = getModuleMap();
      const available = Object.keys(moduleMap);
      const missingModules = transformed.requires.filter(
        (r) => !moduleMap[r],
      );
      // For npm packages, suggest the imports parameter
      const suggestedImports = Object.fromEntries(
        missingModules.map((m) => [m, m.startsWith("@workspace") || m.startsWith("@natstack/") ? "latest" : "npm:latest"]),
      );
      const missingDeclarations = await getMissingPackageDeclarations(missingModules, {
        importerPath: options.sourcePath,
        loadSourceFile: options.loadSourceFile,
        explicitImports: options.imports,
      });
      const packageHint = missingDeclarations.length > 0
        ? `\nPackage context: ${missingDeclarations.join("; ")}.`
        : "";
      return {
        success: false,
        consoleOutput: "",
        error: `Module "${missing}" not available.${packageHint} For npm packages, add the imports parameter:\n  imports: ${JSON.stringify(suggestedImports)}\nCurrently loaded: ${available.join(", ")}`,
      };
    }

    // Enter tracking context
    if (tracking && trackingContext) {
      tracking.enter(trackingContext);
    }

    const runtimeModule = transformed.requires.includes("@workspace/runtime")
      ? tryRequireRuntimeModule(requireFn)
      : null;
    const journal = createRuntimeJournal(runtimeModule);
    const runUserCode = async () => {
      const wrapped = wrapForTopLevelAwait(transformed.code);
      let result: ReturnType<typeof execute>;
      try {
        result = execute(wrapped, {
          console: capture.proxy,
          bindings,
        });
      } finally {
        tracking?.exit();
      }

      // Wait for async operations and promised return values without imposing a
      // wall-clock limit. Agentic eval work should finish by completion, error,
      // or explicit user interruption, not a hidden timeout.
      if (tracking && trackingContext) {
        await tracking.waitAll(trackingContext);
      }

      let returnValue = result.returnValue;
      if (isPromise(returnValue)) {
        returnValue = await returnValue;
      }
      return {
        safeReturnValue: safeSerialize(returnValue ?? result.exports["default"]),
        exports: result.exports,
      };
    };

    const execution = journal
      ? await runtimeModule.withJournal(journal, runUserCode)
      : await runUserCode();
    const panelJournalFooter = journal
      ? await renderPanelJournalFooter(runtimeModule, journal).catch(() => undefined)
      : undefined;
    return {
      success: true,
      consoleOutput: formatConsoleOutput(capture.getEntries()),
      returnValue: execution.safeReturnValue,
      exports: execution.exports,
      panelJournalFooter,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    // Include stack in console output for debugging RPC/OAuth errors
    const consoleEntries = capture.getEntries();
    const debugInfo = errorStack ? `\n[eval] Error stack: ${errorStack}` : "";
    return {
      success: false,
      consoleOutput: formatConsoleOutput(consoleEntries) + debugInfo,
      error: errorMessage,
    };
  } finally {
    unsubscribe();
    if (tracking && trackingContext) {
      tracking.stop(trackingContext);
    }
  }
}

function tryRequireRuntimeModule(requireFn: (id: string) => unknown): any | null {
  try {
    return requireFn("@workspace/runtime") as any;
  } catch {
    return null;
  }
}

function createRuntimeJournal(runtimeModule: any): any | null {
  if (typeof runtimeModule?.Journal !== "function" || typeof runtimeModule?.withJournal !== "function") {
    return null;
  }
  return new runtimeModule.Journal();
}

async function renderPanelJournalFooter(runtimeModule: any, journal: any): Promise<string | undefined> {
  const entries = Array.isArray(journal?.entries) ? journal.entries : [];
  if (entries.length === 0) return undefined;
  const operations = entries.map((entry: any) => {
    switch (entry.type) {
      case "open":
        return `opened ${entry.source} -> #${entry.id}`;
      case "reload":
        return `reloaded #${entry.id}`;
      case "close":
        return `closed #${entry.id}`;
      case "stateArgs.set":
        return `set stateArgs on #${entry.id}`;
      default:
        return String(entry.type ?? "panel operation");
    }
  });
  const tree = typeof runtimeModule?.listPanels === "function"
    ? formatPanelTree(await runtimeModule.listPanels())
    : [];
  return [
    "[panel] Operations:",
    ...operations.map((line: string) => `- ${line}`),
    ...(tree.length ? ["[panel] Tree:", ...tree] : []),
  ].join("\n");
}

function formatPanelTree(handles: any[]): string[] {
  const byParent = new Map<string | null, any[]>();
  for (const handle of handles) {
    const parentId = typeof handle?.parentId === "string" ? handle.parentId : null;
    const list = byParent.get(parentId) ?? [];
    list.push(handle);
    byParent.set(parentId, list);
  }
  const lines: string[] = [];
  const visit = (handle: any, depth: number) => {
    lines.push(`${"  ".repeat(depth)}- #${handle.id} ${handle.kind ?? "panel"} ${handle.source ?? ""}`.trimEnd());
    for (const child of byParent.get(handle.id) ?? []) visit(child, depth + 1);
  };
  for (const root of byParent.get(null) ?? handles) visit(root, 0);
  return lines;
}

// =============================================================================
// compileComponent
// =============================================================================

/**
 * Compile TSX code into a React component.
 *
 * Used for persistent (inline_ui/action bar) and transient (feedback_custom)
 * components.
 * The when-to-compile decision is made by the caller; callers store the result
 * in their own state (React useState / Map) to avoid recompilation on re-render.
 */
export async function compileComponent<T = ComponentType<Record<string, unknown>>>(
  code: string,
  options: CompileComponentOptions = {},
): Promise<CompileResult<T>> {
  try {
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error("loadImport callback required when imports are specified");
      }
      await loadImports(options.imports, options.loadImport);
    }

    const prepared = await prepareSourceCode(code, {
      syntax: "tsx",
      sourcePath: options.sourcePath,
      sourceFiles: options.sourceFiles,
      loadSourceFile: options.loadSourceFile,
    }, (requires, context) => ensureRequires(requires, {
      loadImport: options.loadImport,
      loadSourceFile: options.loadSourceFile,
      sourcePath: options.sourcePath,
      imports: options.imports,
    }, context));

    const transformed = await transformCode(prepared.code, { syntax: "tsx" });

    await ensureRequires(
      transformed.requires.filter((specifier) => !prepared.localModuleIds.has(specifier)),
      {
        loadImport: options.loadImport,
        loadSourceFile: options.loadSourceFile,
        sourcePath: options.sourcePath,
        imports: options.imports,
      },
    );

    const cacheKey = transformed.code;
    const Component = executeDefault<T>(cacheKey);
    return { success: true, Component, cacheKey };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Compile TSX code and return the complete CommonJS module exports object.
 *
 * Custom message type modules use named exports (`reduce`, `Pill`, `schema`) in
 * addition to their default component, so callers need the full module rather
 * than just the default export.
 */
export async function compileModule<T extends Record<string, unknown> = Record<string, unknown>>(
  code: string,
  options: CompileComponentOptions = {},
): Promise<CompileModuleResult<T>> {
  try {
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error("loadImport callback required when imports are specified");
      }
      await loadImports(options.imports, options.loadImport);
    }

    const prepared = await prepareSourceCode(code, {
      syntax: "tsx",
      sourcePath: options.sourcePath,
      sourceFiles: options.sourceFiles,
      loadSourceFile: options.loadSourceFile,
    }, (requires, context) => ensureRequires(requires, {
      loadImport: options.loadImport,
      loadSourceFile: options.loadSourceFile,
      sourcePath: options.sourcePath,
      imports: options.imports,
    }, context));

    const transformed = await transformCode(prepared.code, { syntax: "tsx" });

    await ensureRequires(
      transformed.requires.filter((specifier) => !prepared.localModuleIds.has(specifier)),
      {
        loadImport: options.loadImport,
        loadSourceFile: options.loadSourceFile,
        sourcePath: options.sourcePath,
        imports: options.imports,
      },
    );

    const cacheKey = transformed.code;
    const result = execute(cacheKey);
    return { success: true, module: result.exports as T, cacheKey };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
