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

export interface CompiledDocModule {
  /** Named exports (everything except `default` and `MDXLayout`). */
  exports: Record<string, unknown>;
  /** Set of export names for quick membership tests. */
  exportNames: ReadonlySet<string>;
}

const RESERVED_KEYS = new Set(["default", "MDXLayout"]);

function maskFencedCodeBlocks(content: string): string {
  // Whole-doc export detection should ignore examples in fenced code blocks.
  // Preserve newlines so regex line anchors still map to source line starts.
  return content.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2(?=\n|$))/g, (match) => match.replace(/[^\n]/g, " "));
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---(?=\n|$)/, "");
}

export function hasDocExports(content: string): boolean {
  return exportNamesFromSource(content).length > 0;
}

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

/** Cheap fingerprint of which top-level export NAMES are declared in the
 *  source — used by callers to detect when the wrapper code consumed by
 *  per-node compiles needs to change. Does NOT detect changes to export
 *  bodies; for those the caller should re-run `compileDocModule` and
 *  bump a separate refresh counter. */
export function exportNamesFromSource(content: string): string[] {
  const out: string[] = [];
  const searchable = maskFencedCodeBlocks(stripFrontmatter(content));
  // `export const X` / `export function X` / `export async function X`
  const decl = /^\s*export\s+(?:const|let|var|async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(searchable)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}
