/**
 * Monaco Editor TypeScript configuration for NatStack.
 *
 * This module configures Monaco's TypeScript language service to use
 * NatStack's bundled type definitions, providing accurate IntelliSense
 * for @natstack/runtime APIs, fs shim, and other panel-specific types.
 */

import { getMonaco, type MonacoNamespace } from "./modernMonaco.js";
import {
  FS_TYPE_DEFINITIONS,
  PATH_TYPE_DEFINITIONS,
  NATSTACK_RUNTIME_TYPES,
  GLOBAL_TYPE_DEFINITIONS,
  TS_LIB_FILES,
} from "@natstack/runtime/typecheck";

// Monaco's typescript namespace types
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
 * Returns null if the API is unavailable.
 */
function getMonacoTypescript(monaco: MonacoNamespace): MonacoTypescriptNamespace | null {
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
 * @returns Promise<true> if configuration succeeded, Promise<false> if Monaco typescript API unavailable
 */
export async function configureMonacoTypeCheck(config: MonacoTypeCheckConfig = {}): Promise<boolean> {
  const monaco = await getMonaco();
  const ts = getMonacoTypescript(monaco);
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
 * @returns Promise<true> if the definition was added, Promise<false> if Monaco typescript API unavailable
 */
export async function addMonacoTypeDefinition(
  virtualPath: string,
  content: string,
  language: "typescript" | "javascript" = "typescript"
): Promise<boolean> {
  const monaco = await getMonaco();
  const ts = getMonacoTypescript(monaco);
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

// Monaco MarkerSeverity enum values - hardcoded to avoid runtime dependency on monaco namespace.
// These values match monaco.MarkerSeverity from Monaco Editor:
// - Error = 8 (monaco.MarkerSeverity.Error)
// - Warning = 4 (monaco.MarkerSeverity.Warning)
// - Info = 2 (monaco.MarkerSeverity.Info)
// See: https://microsoft.github.io/monaco-editor/typedoc/enums/MarkerSeverity.html
const MarkerSeverity = {
  Error: 8,
  Warning: 4,
  Info: 2,
} as const;

/**
 * Marker data type compatible with Monaco's IMarkerData interface.
 */
export interface MarkerData {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: 8 | 4 | 2;
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
): MarkerData[] {
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
        ? MarkerSeverity.Error
        : d.severity === "warning"
        ? MarkerSeverity.Warning
        : MarkerSeverity.Info,
  }));
}

/**
 * Set Monaco markers on a model from TypeCheckService diagnostics.
 *
 * @param modelUri - The URI of the model (e.g., "file:///path/to/file.ts")
 * @param diagnostics - Array of diagnostics from TypeCheckService
 * @param owner - Owner identifier for the markers (default: "natstack-typecheck")
 */
export async function setDiagnosticsOnModel(
  modelUri: string,
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
): Promise<void> {
  const monaco = await getMonaco();
  const model = monaco.editor.getModel(monaco.Uri.parse(modelUri));
  if (!model) return;

  const markers = diagnosticsToMarkers(diagnostics, model.uri.path);
  monaco.editor.setModelMarkers(model, owner, markers);
}
