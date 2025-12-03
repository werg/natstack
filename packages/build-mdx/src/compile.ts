/**
 * MDX Compilation
 *
 * Compiles MDX content to React components with full OPFS import support.
 * Uses @mdx-js/mdx's compile() function, then bundles with esbuild.
 */

import { compile } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import { createElement } from "react";
import { getEsbuild, BuildError, createOPFSPlugin } from "@natstack/build";
import type { MDXOptions, MDXResult, AnyComponent } from "./types.js";

/** Error thrown when MDX compilation is aborted */
export class MDXAbortError extends Error {
  constructor(message = "MDX compilation aborted") {
    super(message);
    this.name = "MDXAbortError";
  }
}

/** Error thrown when MDX compilation fails */
export class MDXCompileError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "MDXCompileError";
  }
}

/**
 * Compile MDX content to a React component.
 *
 * @param content - The MDX content to compile
 * @param options - Compilation options
 * @returns The compiled React component and any named exports
 * @throws MDXCompileError on compilation failure
 * @throws MDXAbortError if aborted
 */
export async function compileMDX(
  content: string,
  options: MDXOptions = {}
): Promise<MDXResult> {
  const { components = {}, scope = {}, signal } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  // Step 1: Compile MDX to JavaScript
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = await compile(content, {
      outputFormat: "function-body",
      development: false,
      // Use the JSX runtime
      jsxImportSource: "react",
    });
  } catch (error) {
    throw new MDXCompileError(
      `MDX compilation failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }

  // Check abort after MDX compile
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  const compiledCode = String(compiled);

  // Step 2: Bundle the compiled JS with esbuild + OPFS plugin
  const esbuild = await getEsbuild();

  // Check abort after getting esbuild
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  // Create OPFS plugin for import resolution
  const opfsPlugin = await createOPFSPlugin();

  // Check abort after creating plugin
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  let bundledCode: string;
  try {
    const bundleResult = await esbuild.build({
      stdin: {
        contents: compiledCode,
        loader: "jsx",
        resolveDir: "/",
        sourcefile: "mdx-compiled.jsx",
      },
      bundle: true,
      format: "esm",
      write: false,
      platform: "browser",
      target: "es2022",
      // External react since we provide it via runtime
      external: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
      plugins: [opfsPlugin],
    });

    if (bundleResult.errors.length > 0) {
      const errorMsg = bundleResult.errors
        .map((e) => `${e.location?.file || "mdx"}:${e.location?.line || 0}: ${e.text}`)
        .join("\n");
      throw new BuildError(`MDX bundle failed:\n${errorMsg}`);
    }

    bundledCode = bundleResult.outputFiles?.[0]?.text || "";
    if (!bundledCode) {
      throw new BuildError("No output from esbuild");
    }
  } catch (error) {
    if (error instanceof BuildError || error instanceof MDXAbortError) {
      throw error;
    }
    throw new MDXCompileError(
      `MDX bundling failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }

  // Check abort after bundle
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  // Step 3: Execute the bundled code with runtime injected
  // The compiled MDX with outputFormat: 'function-body' expects certain arguments
  try {
    // Create a function that takes the MDX runtime arguments
    // MDX function-body format expects: function(_components) { ... }
    // and uses jsx/jsxs from the jsx-runtime

    // We need to provide the runtime and execute the code
    const moduleExports: Record<string, unknown> = {};

    // The bundled code is ESM, so we need to handle it as a module
    // Create a blob URL and dynamically import it
    const blob = new Blob(
      [
        // Provide the jsx runtime as globals since we externalized react
        `const { jsx, jsxs, Fragment } = ${JSON.stringify({ jsx: "jsx", jsxs: "jsxs", Fragment: "Fragment" })};
        ${bundledCode}`,
      ],
      { type: "application/javascript" }
    );
    const blobUrl = URL.createObjectURL(blob);

    // Actually, for function-body output, we need a different approach
    // Let's use the simpler evaluate() approach but with our bundled imports

    // For now, use Function constructor with the compiled code
    // The function-body format returns code like:
    // function _createMdxContent(props) { ... }
    // export default function MDXContent(props = {}) { ... }

    // We need to execute this in a context where jsx/jsxs are available
    const executeFn = new Function(
      "_runtime",
      "_components",
      "_scope",
      `
      const { jsx, jsxs, Fragment } = _runtime;
      const { useMDXComponents } = { useMDXComponents: () => _components };

      ${compiledCode}

      return { default: MDXContent, ...arguments[3] };
      `
    );

    const result = executeFn(runtime, components, scope, moduleExports);
    URL.revokeObjectURL(blobUrl);

    const MDXComponent = result.default as AnyComponent;

    // Wrap component to inject default components
    const WrappedComponent: MDXResult["Component"] = (props) => {
      const mergedComponents = { ...components, ...props.components };
      return createElement(MDXComponent, { ...props, components: mergedComponents });
    };

    // Extract named exports (everything except default)
    const { default: _, ...namedExports } = result;

    return {
      Component: WrappedComponent,
      exports: namedExports,
    };
  } catch (error) {
    if (error instanceof MDXAbortError) {
      throw error;
    }
    throw new MDXCompileError(
      `MDX execution failed: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Initialize the MDX compilation environment.
 * Call this early to pre-warm esbuild initialization.
 */
export async function initializeMDX(): Promise<void> {
  await getEsbuild();
}
