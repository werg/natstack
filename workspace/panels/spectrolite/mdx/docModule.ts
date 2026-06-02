/**
 * Whole-document MDX compile.
 *
 * Used by the unified editor: every JSX node in the doc is rendered
 * inline by `LiveJsxEditor`, but those per-node compiles must be able
 * to reference doc-level declarations like
 *
 *     export const Counter = () => { ... };
 *     <Counter />
 *
 * The per-node compile only sees the JSX subtree for that one element,
 * so `Counter` wouldn't be in scope. To fix that, we additionally
 * compile the *entire* doc as one MDX module and expose its named
 * exports to the per-node wrapper via globalThis (see
 * `DocumentEditor.tsx`'s `__spectroliteDocExports__` pump).
 *
 * Compilation failures here (syntax errors during editing) keep the
 * last successful set of exports — so existing JSX nodes don't briefly
 * lose their components while the user is mid-typing a new export.
 */

import * as runtime from "react/jsx-runtime";
import { spectroliteMdxComponents } from "./components";
import { runtimeNamespace } from "./runtimeNamespace";

// Runtime-free source-parsing helpers live in `./docExports` so they can be
// imported without pulling in the panel runtime. Re-exported here for callers
// that already depend on `docModule` (e.g. DocumentEditor).
export { exportNamesFromSource, hasDocExports } from "./docExports";

export interface CompiledDocModule {
  /** Named exports (everything except `default` and `MDXLayout`). */
  exports: Record<string, unknown>;
  /** Set of export names for quick membership tests. */
  exportNames: ReadonlySet<string>;
}

const RESERVED_KEYS = new Set(["default", "MDXLayout"]);

export async function compileDocModule(content: string): Promise<CompiledDocModule | null> {
  let mdx: typeof import("@mdx-js/mdx");
  try {
    mdx = await import("@mdx-js/mdx");
  } catch {
    return null;
  }
  try {
    const module = await mdx.evaluate(content, {
      ...runtime,
      development: false,
      useMDXComponents: () => ({
        ...spectroliteMdxComponents,
        runtime: runtimeNamespace,
      }) as never,
    });
    const exports: Record<string, unknown> = {};
    for (const key of Object.keys(module)) {
      if (RESERVED_KEYS.has(key)) continue;
      exports[key] = (module as Record<string, unknown>)[key];
    }
    return {
      exports,
      exportNames: new Set(Object.keys(exports)),
    };
  } catch {
    return null;
  }
}

