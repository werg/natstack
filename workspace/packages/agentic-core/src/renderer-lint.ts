/**
 * Registration-time lint for custom-message renderer sources.
 *
 * Sandbox renderers must be runtime-self-contained: every *value* import must
 * resolve from the panel's host-exposed modules, the registration's declared
 * `imports`, or a relative file (loaded via loadSourceFile). Anything else
 * forces a build-service round trip at render time — at best slow, at worst a
 * misresolved build and a permanently stuck card. Catch it when the type is
 * registered, where the error is attributable and actionable, instead of at
 * render time in someone else's panel.
 *
 * This is a lexical scan, not a parser: it understands the import forms agents
 * actually write (`import X from "y"`, `import { a } from "y"`, `import * as
 * ns from "y"`, `export ... from "y"`, bare `import "y"`) and skips type-only
 * imports, which are erased at compile time.
 */

/** Modules the chat panel exposes to sandbox components (its exposeModules). */
export const DEFAULT_HOST_MODULES: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@radix-ui/themes",
  "@radix-ui/react-icons",
  "isomorphic-git",
  "@workspace/runtime",
  "@workspace/panel-browser",
];

export interface RendererLintIssue {
  specifier: string;
  message: string;
}

// The clause between `import`/`export` and `from` may only contain import
// syntax (identifiers, braces, commas, `* as`, the `type` keyword, newlines).
// Anything else — quotes, semicolons, operators — means we've wandered into
// expression code (e.g. an object literal with a "from" key), not an import.
const IMPORT_PATTERN =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?([A-Za-z0-9_$,{}*\s]+?)\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Lint renderer source for value imports that the panel cannot satisfy
 * without a build-service call. Returns issues (empty = clean).
 */
export function lintRendererSource(
  code: string,
  opts: {
    /** Declared registration imports (loaded on demand — allowed). */
    imports?: Record<string, string> | undefined;
    /** Host-exposed modules; defaults to the chat panel's exposeModules. */
    hostModules?: readonly string[] | undefined;
  } = {}
): RendererLintIssue[] {
  const allowed = new Set([
    ...(opts.hostModules ?? DEFAULT_HOST_MODULES),
    ...Object.keys(opts.imports ?? {}),
  ]);
  const issues: RendererLintIssue[] = [];
  const stripped = stripComments(code);
  for (const match of stripped.matchAll(IMPORT_PATTERN)) {
    const isTypeOnly = Boolean(match[2]);
    const clause = match[3] ?? "";
    const specifier = match[4] ?? match[5];
    if (!specifier) continue;
    if (isTypeOnly) continue;
    // `import { type A, type B } from "x"` — type-only despite no `import type`.
    if (clause && /^\{[^}]*\}$/.test(clause.trim())) {
      const names = clause.trim().slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length > 0 && names.every((name) => name.startsWith("type "))) continue;
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
    if (allowed.has(specifier)) continue;
    issues.push({
      specifier,
      message:
        `Value import "${specifier}" is not host-exposed and not in the registration's imports. ` +
        `It would require a build-service round trip on every render. Either add it to the ` +
        `registration's imports (npm: packages), make it a relative import, inline it, or use ` +
        `\`import type\` if only types are needed.`,
    });
  }
  return issues;
}
