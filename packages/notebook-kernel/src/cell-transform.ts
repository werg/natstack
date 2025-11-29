/**
 * Cell Transform with TypeScript/JSX Support
 *
 * Uses esbuild-wasm to transform TypeScript/JSX cell code before execution.
 * Also generates source maps for better error reporting.
 */

import {
  getEsbuild,
  isEsbuildAvailable,
  getEsbuildSync,
  type EsbuildInitOptions,
} from "./esbuild-init.js";

export interface CellTransformOptions {
  /** Enable TypeScript support */
  typescript?: boolean;
  /** Enable JSX support */
  jsx?: boolean;
  /** JSX factory function (default: React.createElement) */
  jsxFactory?: string;
  /** JSX fragment function (default: React.Fragment) */
  jsxFragment?: string;
  /** Generate source maps for better error traces */
  sourceMaps?: boolean;
  /** Cell identifier for source map (e.g., "cell-1") */
  cellId?: string;
  /** AbortSignal to cancel the transformation */
  signal?: AbortSignal;
}

export interface CellTransformResult {
  code: string;
  /** Base64-encoded source map, or undefined if not generated */
  sourceMap?: string;
}

/**
 * Initialize esbuild-wasm for cell transformation.
 * Called automatically on first transform, but can be called manually for eager init.
 */
export async function initializeCellTransform(wasmURL?: string): Promise<void> {
  await getEsbuild(wasmURL ? { wasmURL } : undefined);
}

/**
 * Check if esbuild is initialized.
 */
export function isCellTransformAvailable(): boolean {
  return isEsbuildAvailable();
}

/**
 * Error thrown when transformation is aborted.
 */
export class TransformAbortError extends Error {
  constructor(message = "Transformation aborted") {
    super(message);
    this.name = "TransformAbortError";
  }
}

/**
 * Transform cell code with TypeScript/JSX support and optional source maps.
 *
 * @param code - The cell code to transform
 * @param options - Transform options
 * @returns Transformed code and optional source map
 * @throws TransformAbortError if the signal is aborted
 */
export async function transformCellCode(
  code: string,
  options: CellTransformOptions = {}
): Promise<CellTransformResult> {
  const {
    typescript = true,
    jsx = true,
    jsxFactory = "React.createElement",
    jsxFragment = "React.Fragment",
    sourceMaps = true,
    cellId = "cell",
    signal,
  } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new TransformAbortError();
  }

  // If no special features needed, return code as-is
  if (!typescript && !jsx && !sourceMaps) {
    return { code };
  }

  // Get shared esbuild instance (auto-initializes on first use)
  const esbuild = await getEsbuild();

  // Check again after async operation
  if (signal?.aborted) {
    throw new TransformAbortError();
  }

  // Determine loader based on options
  let loader: "ts" | "tsx" | "js" | "jsx" = "js";
  if (typescript && jsx) {
    loader = "tsx";
  } else if (typescript) {
    loader = "ts";
  } else if (jsx) {
    loader = "jsx";
  }

  try {
    const result = await esbuild.transform(code, {
      loader,
      target: "es2022",
      format: "esm",
      sourcemap: sourceMaps ? "inline" : false,
      sourcefile: `${cellId}.${loader}`,
      jsxFactory,
      jsxFragment,
      minify: false,
      keepNames: true,
    });

    // Check after transform completes
    if (signal?.aborted) {
      throw new TransformAbortError();
    }

    let transformedCode = result.code;
    let sourceMap: string | undefined;

    // Extract inline source map if present
    if (sourceMaps && transformedCode.includes("//# sourceMappingURL=data:")) {
      const sourceMapMatch = transformedCode.match(
        /\/\/# sourceMappingURL=data:application\/json;base64,([^\s]+)/
      );
      if (sourceMapMatch) {
        sourceMap = sourceMapMatch[1];
      }
    }

    return {
      code: transformedCode,
      sourceMap,
    };
  } catch (error) {
    if (error instanceof TransformAbortError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new Error(`Cell transform failed: ${error.message}`);
    }
    throw error;
  }
}

