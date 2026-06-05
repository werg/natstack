/**
 * Static-import validation for the eval sandbox.
 *
 * Turns two silent footguns into clear, actionable errors:
 *  1. Importing a pre-injected global (`chat`/`scope`/`scopes`/`help`) from
 *     `@workspace/runtime` — these are ambient and importing them shadows the
 *     working binding with `undefined`.
 *  2. Importing a name a workspace module does not export — a CJS destructure
 *     yields `undefined` silently, surfacing as a confusing error far away.
 */

/** Eval globals that are injected, not exported by `@workspace/runtime`. */
const PRE_INJECTED = new Set(["chat", "scope", "scopes", "help"]);
const RUNTIME_SPECIFIER = "@workspace/runtime";
/** Workspace-controlled namespaces with stable, statically-known named exports. */
const WORKSPACE_NAMESPACE = /^@(?:workspace|workspace-skills|natstack)\//;

export interface ParsedImport {
  specifier: string;
  /** Imported (original) names, excluding inline `type` specifiers. */
  named: string[];
  hasDefault: boolean;
  hasNamespace: boolean;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function hasWordBoundary(code: string, start: number, length: number): boolean {
  return !isIdentChar(code[start - 1]) && !isIdentChar(code[start + length]);
}

function skipWhitespace(code: string, index: number): number {
  let i = index;
  while (i < code.length) {
    const ch = code[i];
    if (/\s/.test(ch ?? "")) {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n" && code[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(code.length, i + 2);
      continue;
    }
    break;
  }
  return i;
}

function skipQuoted(code: string, index: number, quote: "'" | '"'): number {
  let i = index + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

function skipTemplate(code: string, index: number): number {
  let i = index + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") return i + 1;
    i++;
  }
  return i;
}

function readStringLiteral(code: string, index: number): { value: string; end: number } | null {
  const quote = code[index];
  if (quote !== "'" && quote !== '"') return null;
  let value = "";
  let i = index + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      value += code.slice(i, Math.min(code.length, i + 2));
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch ?? "";
    i++;
  }
  return null;
}

function findKeywordOutsideLiterals(code: string, keyword: string, index: number): number {
  let i = index;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(code, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n" && code[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(code.length, i + 2);
      continue;
    }
    if (code.startsWith(keyword, i) && hasWordBoundary(code, i, keyword.length)) return i;
    i++;
  }
  return -1;
}

function parseImportAt(code: string, start: number): ParsedImport | null {
  let i = skipWhitespace(code, start + "import".length);
  const first = code[i];
  if (first === "(" || first === ".") return null; // dynamic import / import.meta
  if (first === "'" || first === '"') {
    const literal = readStringLiteral(code, i);
    return literal
      ? { specifier: literal.value, named: [], hasDefault: false, hasNamespace: false }
      : null;
  }
  const fromIndex = findKeywordOutsideLiterals(code, "from", i);
  if (fromIndex < 0) return null;
  const literal = readStringLiteral(code, skipWhitespace(code, fromIndex + "from".length));
  if (!literal) return null;
  const clause = code.slice(i, fromIndex).trim();
  if (/^type\b/.test(clause)) return null; // whole-statement type import
  return { specifier: literal.value, ...parseClause(clause) };
}

function parseExportAt(code: string, start: number): ParsedImport | null {
  let i = skipWhitespace(code, start + "export".length);
  if (code.startsWith("type", i) && hasWordBoundary(code, i, "type".length)) return null;
  const fromIndex = findKeywordOutsideLiterals(code, "from", i);
  if (fromIndex < 0) return null;
  const literal = readStringLiteral(code, skipWhitespace(code, fromIndex + "from".length));
  if (!literal) return null;
  const clause = code.slice(i, fromIndex).trim();
  return { specifier: literal.value, ...parseClause(clause) };
}

function parseClause(clause: string): Omit<ParsedImport, "specifier"> {
  let hasNamespace = false;
  const named: string[] = [];

  if (/\*\s+as\s+\w+/.test(clause)) hasNamespace = true;

  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch?.[1]) {
    for (const raw of braceMatch[1].split(",")) {
      const part = raw.trim();
      if (!part || /^type\s+/.test(part)) continue; // skip inline `type` specifiers
      const importedName = part.split(/\s+as\s+/)[0]?.trim();
      if (importedName) named.push(importedName);
    }
  }

  const beforeBrace = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+\w+/, "");
  const defaultMatch = beforeBrace.match(/^\s*(\w+)/);
  const hasDefault = Boolean(defaultMatch && defaultMatch[1] !== "type");

  return { named, hasDefault, hasNamespace };
}

export function parseStaticImports(code: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(code, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(code, i);
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n" && code[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(code.length, i + 2);
      continue;
    }
    if (code.startsWith("import", i) && hasWordBoundary(code, i, "import".length)) {
      const parsed = parseImportAt(code, i);
      if (parsed) imports.push(parsed);
      i += "import".length;
      continue;
    }
    if (code.startsWith("export", i) && hasWordBoundary(code, i, "export".length)) {
      const parsed = parseExportAt(code, i);
      if (parsed) imports.push(parsed);
      i += "export".length;
      continue;
    }
    i++;
  }
  return imports;
}

/**
 * Throw if eval code imports a pre-injected global from `@workspace/runtime`.
 * (#1) These are ambient — importing them shadows the binding with `undefined`.
 */
export function assertNoPreInjectedImports(code: string): void {
  for (const imp of parseStaticImports(code)) {
    if (imp.specifier !== RUNTIME_SPECIFIER) continue;
    const offenders = imp.named.filter((name) => PRE_INJECTED.has(name));
    if (offenders.length === 0) continue;
    const plural = offenders.length > 1;
    throw new Error(
      `${offenders.join(", ")} ${plural ? "are" : "is"} pre-injected into eval as ambient ` +
        `global${plural ? "s" : ""} — use ${plural ? "them" : "it"} directly; do not import ` +
        `${plural ? "them" : "it"} from "${RUNTIME_SPECIFIER}".`
    );
  }
}

/**
 * Throw if eval code imports a name a loaded workspace module does not export.
 * (#2) Only workspace-namespaced modules with object exports are checked, so
 * npm/CJS interop and relative bundles are left alone.
 */
export function assertNamedExportsExist(
  code: string,
  resolveModule: (specifier: string) => unknown
): void {
  for (const imp of parseStaticImports(code)) {
    if (imp.named.length === 0) continue;
    if (!WORKSPACE_NAMESPACE.test(imp.specifier)) continue;
    const mod = resolveModule(imp.specifier);
    if (!mod || typeof mod !== "object") continue; // not loaded, or a non-namespace export
    const exportsObj = mod as Record<string, unknown>;
    const missing = imp.named.filter((name) => !(name in exportsObj));
    if (missing.length === 0) continue;
    const available = Object.keys(exportsObj)
      .filter((k) => k !== "default" && k !== "__esModule")
      .sort();
    const shown = available.slice(0, 30);
    const suffix =
      available.length > shown.length ? `, …(+${available.length - shown.length})` : "";
    const plural = missing.length > 1;
    throw new Error(
      `${missing.join(", ")} ${plural ? "are" : "is"} not exported by "${imp.specifier}". ` +
        `Available: ${shown.join(", ") || "(none)"}${suffix}.`
    );
  }
}
