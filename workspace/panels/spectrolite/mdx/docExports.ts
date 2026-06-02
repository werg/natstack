/**
 * Runtime-free MDX export detection.
 *
 * Pure string/regex helpers split out of `docModule.ts` so they can be used —
 * and unit-tested — without importing the panel runtime or React components
 * that `compileDocModule` pulls in (those eagerly initialise the NatStack
 * runtime via `@workspace/react`, which throws outside a live panel).
 */

function maskFencedCodeBlocks(content: string): string {
  // Whole-doc export detection should ignore examples in fenced code blocks.
  // Preserve newlines so regex line anchors still map to source line starts.
  return content.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2(?=\n|$))/g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---(?=\n|$)/, "");
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
  const decl =
    /^\s*export\s+(?:const|let|var|async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(searchable)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

export function hasDocExports(content: string): boolean {
  return exportNamesFromSource(content).length > 0;
}
