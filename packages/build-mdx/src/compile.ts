/**
 * MDX Compilation
 *
 * Compiles MDX content to React components with full OPFS import support.
 * Uses @mdx-js/mdx's compile() function, then bundles with esbuild.
 */

import { compile } from "@mdx-js/mdx";
import { createElement } from "react";
import {
  getEsbuild,
  BuildError,
  createFsPlugin,
  executeEsm,
} from "@natstack/build";
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
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
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
  const { components = {}, scope = {}, signal, importModule } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new MDXAbortError();
  }

  // Step 1: Compile MDX to JavaScript
  // Use "program" output format (ESM) so we can bundle it with esbuild
  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = await compile(content, {
      outputFormat: "program",
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

  // Create filesystem plugin for import resolution
  const fsPlugin = createFsPlugin();

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
      plugins: [fsPlugin],
    });

    if (bundleResult.errors.length > 0) {
      const errorMsg = bundleResult.errors
        .map(
          (e) => `${e.location?.file || "mdx"}:${e.location?.line || 0}: ${e.text}`
        )
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
  try {
    // Merge provided components into scope so they're available as top-level variables
    // This allows `export default function App() { return <Card>...</Card> }` to work
    // because Card is in scope, not just available via useMDXComponents
    const mergedScope = { ...scope, ...components };

    const result = await executeEsm(bundledCode, {
      importModule,
      scope: mergedScope,
      params: {
        _components: components,
      },
      preamble: `
// MDX components provider
const useMDXComponents = () => _components;
`,
    });

    const MDXComponent = result.exports["default"] as AnyComponent;

    if (!MDXComponent) {
      throw new MDXCompileError(
        "MDX compilation produced no default export. The component could not be created."
      );
    }

    // Wrap component to inject default components
    const WrappedComponent: MDXResult["Component"] = (props) => {
      const mergedComponents = { ...components, ...props.components };
      return createElement(MDXComponent, {
        ...props,
        components: mergedComponents,
      });
    };

    // Extract named exports (everything except default)
    const { default: _, ...namedExports } = result.exports;

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
