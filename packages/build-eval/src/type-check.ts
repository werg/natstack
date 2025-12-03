/**
 * TypeScript Type Checking
 *
 * Optional type checking for code before evaluation.
 * Only available if the 'typescript' library is installed.
 */

import type { TypeCheckOptions, TypeCheckResult, TypeCheckError } from "./types.js";

// TypeScript type - will be dynamically imported
type TypeScriptModule = typeof import("typescript");

// Cache for the dynamically imported typescript module
let tsModule: TypeScriptModule | null = null;
let tsLoadPromise: Promise<TypeScriptModule | null> | null = null;

/**
 * Check if TypeScript is available for type checking.
 */
export async function isTypeScriptAvailable(): Promise<boolean> {
  const ts = await loadTypeScript();
  return ts !== null;
}

/**
 * Load the TypeScript module dynamically.
 * Returns null if not available.
 */
async function loadTypeScript(): Promise<TypeScriptModule | null> {
  if (tsModule !== null) {
    return tsModule;
  }

  if (tsLoadPromise !== null) {
    return tsLoadPromise;
  }

  tsLoadPromise = (async () => {
    try {
      // Dynamic import to make typescript optional
      tsModule = await import("typescript");
      return tsModule;
    } catch {
      // TypeScript not available
      tsModule = null;
      return null;
    }
  })();

  return tsLoadPromise;
}

/**
 * Type check code without executing.
 *
 * @param code - The source code to type check
 * @param options - Type check options
 * @returns Errors and warnings from type checking
 * @throws Error if TypeScript is not available
 */
export async function typeCheck(
  code: string,
  options: TypeCheckOptions = { language: "typescript" }
): Promise<TypeCheckResult> {
  const { language, signal } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error("Type checking aborted");
  }

  // Load TypeScript
  const ts = await loadTypeScript();

  if (!ts) {
    throw new Error(
      "TypeScript is not available. Install the 'typescript' package to enable type checking."
    );
  }

  // Check abort after loading
  if (signal?.aborted) {
    throw new Error("Type checking aborted");
  }

  const errors: TypeCheckError[] = [];
  const warnings: TypeCheckError[] = [];

  // Determine file extension based on language
  const fileName = language === "typescript" ? "input.tsx" : "input.jsx";

  // Create a virtual file system for the compiler
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.ESNext,
    true,
    language === "typescript" ? ts.ScriptKind.TSX : ts.ScriptKind.JSX
  );

  // Create compiler options
  const compilerOptions: import("typescript").CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    // Allow importing from anywhere (we handle resolution separately)
    baseUrl: "/",
    paths: {
      "*": ["*"],
    },
  };

  // Create a minimal compiler host
  const compilerHost: import("typescript").CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return sourceFile;
      }
      // For other files, return undefined (we don't have them)
      return undefined;
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? code : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
  };

  // Create the program
  const program = ts.createProgram([fileName], compilerOptions, compilerHost);

  // Get diagnostics
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  // Check abort before processing diagnostics
  if (signal?.aborted) {
    throw new Error("Type checking aborted");
  }

  // Convert diagnostics to our format
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

    let line: number | undefined;
    let column: number | undefined;

    if (diagnostic.file && diagnostic.start !== undefined) {
      const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      line = pos.line + 1; // Convert to 1-based
      column = pos.character + 1;
    }

    const error: TypeCheckError = {
      message,
      file: fileName,
      line,
      column,
    };

    // Categorize by severity
    if (diagnostic.category === ts.DiagnosticCategory.Error) {
      errors.push(error);
    } else if (diagnostic.category === ts.DiagnosticCategory.Warning) {
      warnings.push(error);
    }
    // Ignore suggestions and messages
  }

  return { errors, warnings };
}

/**
 * Type check and throw if there are errors.
 *
 * @param code - The source code to type check
 * @param options - Type check options
 * @throws Error with formatted type errors if any are found
 */
export async function typeCheckOrThrow(
  code: string,
  options: TypeCheckOptions = { language: "typescript" }
): Promise<void> {
  const result = await typeCheck(code, options);

  if (result.errors.length > 0) {
    const errorMessages = result.errors
      .map((e) => {
        const location = e.line ? `${e.file}:${e.line}:${e.column}` : e.file;
        return `${location}: ${e.message}`;
      })
      .join("\n");

    throw new Error(`Type errors:\n${errorMessages}`);
  }
}
