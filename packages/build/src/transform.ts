/**
 * Code Transformation
 *
 * Wraps esbuild's transform() function for TS/TSX/JSX → JS conversion.
 */

import { getEsbuild } from "./esbuild-init.js";

export type Loader = "js" | "jsx" | "ts" | "tsx";

export interface TransformOptions {
  /** The loader to use (determines input language) */
  loader: Loader;
  /** JSX factory function (default: React.createElement) */
  jsxFactory?: string;
  /** JSX fragment function (default: React.Fragment) */
  jsxFragment?: string;
  /** Generate source maps */
  sourceMaps?: boolean;
  /** Source file name for source maps */
  sourcefile?: string;
  /** AbortSignal to cancel the transformation */
  signal?: AbortSignal;
}

export interface TransformResult {
  /** The transformed JavaScript code */
  code: string;
  /** Base64-encoded source map, or undefined if not generated */
  sourceMap?: string;
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
 * Transform code from TypeScript/JSX to JavaScript.
 *
 * @param code - The source code to transform
 * @param options - Transform options
 * @returns Transformed code and optional source map
 * @throws TransformAbortError if the signal is aborted
 */
export async function transform(
  code: string,
  options: TransformOptions
): Promise<TransformResult> {
  const {
    loader,
    jsxFactory = "React.createElement",
    jsxFragment = "React.Fragment",
    sourceMaps = true,
    sourcefile = "input",
    signal,
  } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new TransformAbortError();
  }

  // If plain JS with no source maps needed, return as-is
  if (loader === "js" && !sourceMaps) {
    return { code };
  }

  // Get shared esbuild instance (auto-initializes on first use)
  const esbuild = await getEsbuild();

  // Check again after async operation
  if (signal?.aborted) {
    throw new TransformAbortError();
  }

  try {
    const result = await esbuild.transform(code, {
      loader,
      target: "es2022",
      format: "esm",
      sourcemap: sourceMaps ? "inline" : false,
      sourcefile: `${sourcefile}.${loader}`,
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
      throw new Error(`Transform failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Determine the appropriate loader based on language and JSX settings.
 */
export function getLoaderForLanguage(
  language: "javascript" | "typescript",
  jsx: boolean = false
): Loader {
  if (language === "typescript") {
    return jsx ? "tsx" : "ts";
  }
  return jsx ? "jsx" : "js";
}
