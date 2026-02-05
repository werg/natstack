/**
 * Type definitions for the Code Editor panel.
 */

import type {
  BaseDiagnostic,
  TypeCheckDiagnostic,
  TypeCheckResult,
  TypeCheckDiagnosticsEvent,
} from "@natstack/typecheck";

/**
 * Diagnostic entry from type checking.
 * Extends BaseDiagnostic with optional TypeScript-specific code field.
 */
export interface Diagnostic extends BaseDiagnostic {
  /** TypeScript diagnostic code (e.g., 2304 for "Cannot find name"). Optional. */
  code?: number;
}

/**
 * Default TypeScript diagnostic category for errors.
 * Value 1 corresponds to ts.DiagnosticCategory.Error.
 */
const TS_DIAGNOSTIC_CATEGORY_ERROR = 1;

/**
 * Convert TypeCheckDiagnostic array to Diagnostic array.
 * Preserves the TypeScript error code but strips category.
 */
export function toBaseDiagnostics(diagnostics: TypeCheckDiagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => ({
    file: d.file,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    severity: d.severity,
    code: d.code,
  }));
}

/**
 * Convert TypeCheckResult to Diagnostic array.
 */
export function resultToDiagnostics(result: TypeCheckResult): Diagnostic[] {
  return toBaseDiagnostics(result.diagnostics);
}

/**
 * Convert TypeCheckDiagnosticsEvent to Diagnostic array.
 */
export function eventToDiagnostics(event: TypeCheckDiagnosticsEvent): Diagnostic[] {
  return toBaseDiagnostics(event.diagnostics);
}

/**
 * Convert Diagnostic array to TypeCheckDiagnostic array for channel publishing.
 * Uses the preserved code if available, otherwise defaults to 0.
 */
export function toTypeCheckDiagnostics(diagnostics: Diagnostic[]): TypeCheckDiagnostic[] {
  return diagnostics.map((d) => ({
    file: d.file,
    line: d.line,
    column: d.column,
    endLine: d.endLine,
    endColumn: d.endColumn,
    message: d.message,
    severity: d.severity,
    code: d.code ?? 0,
    category: TS_DIAGNOSTIC_CATEGORY_ERROR,
  }));
}

/**
 * Represents a file or directory entry in the file tree.
 */
export interface FileEntry {
  path: string;
  name: string;
  isDirectory: boolean;
}

/**
 * Tree node for hierarchical file display.
 */
export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[];
}

/**
 * Represents an open editor tab.
 */
export interface Tab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  savedContent: string;
  cursorPosition: { lineNumber: number; column: number };
  scrollTop: number;
  isModified: boolean;
}

/**
 * Get file extension from a file name.
 */
export function getExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > 0 ? fileName.slice(lastDot + 1) : "";
}

/**
 * Map file extension to Monaco language identifier.
 */
export function getLanguage(fileName: string | undefined): string {
  if (!fileName) return "plaintext";

  const ext = getExtension(fileName).toLowerCase();

  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
  };

  return languageMap[ext] ?? "plaintext";
}
