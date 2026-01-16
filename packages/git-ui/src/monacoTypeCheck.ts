/**
 * Monaco Editor TypeScript configuration for NatStack.
 *
 * This module configures Monaco's TypeScript language service to use
 * NatStack's bundled type definitions, providing accurate IntelliSense
 * for @natstack/runtime APIs, fs shim, and other panel-specific types.
 */

import * as monaco from "monaco-editor";
import {
  FS_TYPE_DEFINITIONS,
  PATH_TYPE_DEFINITIONS,
  NATSTACK_RUNTIME_TYPES,
  GLOBAL_TYPE_DEFINITIONS,
  TS_LIB_FILES,
} from "@natstack/runtime/typecheck";

// Monaco's typescript namespace types are marked deprecated but still work.
// We use type assertions to access the API.
interface MonacoTypescriptDefaults {
  setCompilerOptions: (options: Record<string, unknown>) => void;
  setDiagnosticsOptions: (options: Record<string, boolean>) => void;
  addExtraLib: (content: string, path: string) => void;
}

interface MonacoTypescriptNamespace {
  ScriptTarget: Record<string, number>;
  ModuleKind: Record<string, number>;
  ModuleResolutionKind: Record<string, number>;
  JsxEmit: Record<string, number>;
  typescriptDefaults: MonacoTypescriptDefaults;
  javascriptDefaults: MonacoTypescriptDefaults;
}

/**
 * Get Monaco's typescript namespace with runtime validation.
 * Returns null if the API is unavailable (e.g., Monaco version changed).
 */
function getMonacoTypescript(): MonacoTypescriptNamespace | null {
  // Access via bracket notation to bypass deprecated type warnings
  const languages = monaco.languages as Record<string, unknown>;
  const ts = languages["typescript"] as MonacoTypescriptNamespace | undefined;

  // Validate the API shape before returning
  if (
    !ts ||
    typeof ts.typescriptDefaults?.setCompilerOptions !== "function" ||
    typeof ts.typescriptDefaults?.addExtraLib !== "function" ||
    !ts.ScriptTarget ||
    !ts.ModuleKind
  ) {
    console.warn(
      "[monacoTypeCheck] Monaco typescript API not available or has unexpected shape. " +
        "TypeScript IntelliSense may not work correctly."
    );
    return null;
  }

  return ts;
}

/**
 * Configuration options for Monaco TypeScript setup.
 */
export interface MonacoTypeCheckConfig {
  /**
   * Enable strict mode (default: true)
   */
  strict?: boolean;

  /**
   * Target ECMAScript version (default: ES2022)
   */
  target?: number;

  /**
   * JSX mode (default: ReactJSX)
   */
  jsx?: number;

  /**
   * Additional type definition files to include.
   * Format: { virtualPath: content }
   *
   * For React types, use TypeDefinitionLoader to fetch @types/react and add here:
   * @example
   * ```typescript
   * const reactTypes = await typeDefLoader.loadPackageTypes("@types/react");
   * configureMonacoTypeCheck({
   *   additionalTypes: Object.fromEntries(
   *     [...reactTypes.files.entries()].map(([path, content]) =>
   *       [`file:///node_modules/@types/react/${path}`, content]
   *     )
   *   ),
   * });
   * ```
   */
  additionalTypes?: Record<string, string>;
}

/**
 * Configure Monaco's TypeScript/JavaScript language service for NatStack panels.
 *
 * This sets up:
 * - Compiler options matching the panel build system
 * - Bundled TypeScript lib files (ES2022, DOM)
 * - @natstack/runtime type definitions
 * - fs shim type definitions
 * - Global NatStack types
 *
 * Call this once when initializing Monaco in your application.
 *
 * @returns true if configuration succeeded, false if Monaco typescript API unavailable
 */
export function configureMonacoTypeCheck(config: MonacoTypeCheckConfig = {}): boolean {
  const ts = getMonacoTypescript();
  if (!ts) {
    return false;
  }

  const {
    strict = true,
    target = ts.ScriptTarget["ES2022"],
    jsx = ts.JsxEmit["ReactJSX"],
    additionalTypes = {},
  } = config;

  const typescriptDefaults = ts.typescriptDefaults;
  const javascriptDefaults = ts.javascriptDefaults;

  // Configure compiler options to match TypeCheckService
  const compilerOptions = {
    target,
    module: ts.ModuleKind["ESNext"],
    moduleResolution: ts.ModuleResolutionKind["Bundler"],
    jsx,
    strict,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    isolatedModules: true,
    allowNonTsExtensions: true,
  };

  typescriptDefaults.setCompilerOptions(compilerOptions);
  javascriptDefaults.setCompilerOptions(compilerOptions);

  // Enable diagnostics
  typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
  });

  // Add bundled TypeScript lib files
  if (TS_LIB_FILES) {
    for (const [libName, content] of Object.entries(TS_LIB_FILES)) {
      typescriptDefaults.addExtraLib(content, `file:///node_modules/typescript/lib/${libName}`);
    }
  }

  // Add fs shim types (for fs, fs/promises, node:fs imports)
  typescriptDefaults.addExtraLib(
    FS_TYPE_DEFINITIONS,
    "file:///node_modules/@types/node/fs.d.ts"
  );
  typescriptDefaults.addExtraLib(
    FS_TYPE_DEFINITIONS,
    "file:///node_modules/@types/node/fs/promises.d.ts"
  );

  // Add path shim types (for path, node:path imports - shimmed to pathe)
  typescriptDefaults.addExtraLib(
    PATH_TYPE_DEFINITIONS,
    "file:///node_modules/@types/node/path.d.ts"
  );

  // Add @natstack/runtime types
  typescriptDefaults.addExtraLib(
    NATSTACK_RUNTIME_TYPES,
    "file:///node_modules/@natstack/runtime/index.d.ts"
  );

  // Add global NatStack types
  typescriptDefaults.addExtraLib(
    GLOBAL_TYPE_DEFINITIONS,
    "file:///node_modules/@natstack/globals.d.ts"
  );

  // Add any additional types (use this for React types loaded via TypeDefinitionLoader)
  for (const [path, content] of Object.entries(additionalTypes)) {
    typescriptDefaults.addExtraLib(content, path);
  }

  return true;
}

/**
 * Add type definitions for an additional package.
 *
 * Use this to add types for packages loaded dynamically or
 * not included in the default configuration.
 *
 * @returns true if the definition was added, false if Monaco typescript API unavailable
 */
export function addMonacoTypeDefinition(
  virtualPath: string,
  content: string,
  language: "typescript" | "javascript" = "typescript"
): boolean {
  const ts = getMonacoTypescript();
  if (!ts) {
    return false;
  }

  const defaults =
    language === "typescript"
      ? ts.typescriptDefaults
      : ts.javascriptDefaults;

  defaults.addExtraLib(content, virtualPath);
  return true;
}

/**
 * Create Monaco markers from TypeCheckDiagnostic array.
 *
 * Use this to convert diagnostics from TypeCheckService to Monaco markers.
 */
export function diagnosticsToMarkers(
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>,
  filterFile?: string
): monaco.editor.IMarkerData[] {
  const filtered = filterFile
    ? diagnostics.filter((d) => d.file === filterFile)
    : diagnostics;

  return filtered.map((d) => ({
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine ?? d.line,
    endColumn: d.endColumn ?? d.column + 1,
    message: d.message,
    severity:
      d.severity === "error"
        ? monaco.MarkerSeverity.Error
        : d.severity === "warning"
        ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info,
  }));
}

/**
 * Set Monaco markers on a model from TypeCheckService diagnostics.
 */
export function setDiagnosticsOnModel(
  model: monaco.editor.ITextModel,
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    message: string;
    severity: "error" | "warning" | "info";
  }>,
  owner: string = "natstack-typecheck"
): void {
  const markers = diagnosticsToMarkers(diagnostics, model.uri.path);
  monaco.editor.setModelMarkers(model, owner, markers);
}
