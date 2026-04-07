/**
 * Main-process type-check entry points exposed via the typecheck RPC service.
 *
 * Runs TypeScript's language service (via @natstack/typecheck) directly
 * against the disk. No external type fetching, no install-on-demand, no
 * callbacks — workspace packages resolve through the workspace context map
 * and everything else flows through standard `node_modules` walking.
 *
 * RPC surface:
 *   - typecheck.check          — diagnostics for a file or whole project
 *   - typecheck.getTypeInfo    — hover info at a position
 *   - typecheck.getCompletions — completion list at a position
 *
 * The old getPackageTypes/getPackageTypesBatch RPCs were removed along with
 * their only caller (the deleted panel-side TypeDefinitionClient). Code
 * completion in Monaco panels uses Monaco's own TypeScript service — it
 * doesn't talk to this file.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  TypeCheckService,
  createDiskFileSource,
  loadSourceFiles,
  type TypeCheckDiagnostic,
} from "@natstack/typecheck";

/** Per-panel TypeCheckService cache — keyed by absolute panel path. */
const typeCheckServiceCache = new Map<string, TypeCheckService>();

/**
 * Build (or reuse) a `TypeCheckService` for the given panel/package path.
 * The service auto-discovers the monorepo context and reads files from disk.
 */
async function getOrCreateTypeCheckService(panelPath: string): Promise<TypeCheckService> {
  const resolved = path.resolve(panelPath);
  const cached = typeCheckServiceCache.get(resolved);
  if (cached) return cached;

  const service = new TypeCheckService({ panelPath: resolved });

  // Load initial files with absolute paths (consistent with all downstream
  // updateFile calls).
  const fileSource = createDiskFileSource(resolved);
  const files = await loadSourceFiles(fileSource, ".");
  for (const [relPath, content] of files) {
    service.updateFile(path.resolve(resolved, relPath), content);
  }

  typeCheckServiceCache.set(resolved, service);
  return service;
}

/** Serializable diagnostic (without ts.DiagnosticCategory enum reference). */
interface SerializedDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}

function serializeDiagnostics(diagnostics: TypeCheckDiagnostic[]): SerializedDiagnostic[] {
  return diagnostics.map(d => ({
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

// =============================================================================
// RPC methods
// =============================================================================

export const typeCheckRpcMethods = {
  "typecheck.check": async (
    panelPath: string,
    filePath?: string,
    fileContent?: string
  ): Promise<{ diagnostics: SerializedDiagnostic[]; checkedFiles: string[] }> => {
    const service = await getOrCreateTypeCheckService(panelPath);
    const resolved = path.resolve(panelPath);

    if (filePath) {
      const resolvedFile = path.resolve(resolved, filePath);
      if (fileContent !== undefined) {
        service.updateFile(resolvedFile, fileContent);
      } else {
        // Always refresh from disk — agent may have edited since service was created
        try {
          service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
        } catch { /* file may not exist yet */ }
      }
    } else {
      // Whole-panel check: resync all files from disk
      const files = await loadSourceFiles(createDiskFileSource(resolved), ".");
      for (const [relPath, content] of files) {
        service.updateFile(path.resolve(resolved, relPath), content);
      }
    }

    const result = service.check(filePath ? path.resolve(resolved, filePath) : undefined);
    return {
      diagnostics: serializeDiagnostics(result.diagnostics),
      checkedFiles: result.checkedFiles,
    };
  },

  "typecheck.getTypeInfo": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string
  ): Promise<{ displayParts: string; documentation?: string; tags?: { name: string; text?: string }[] } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath);
    const resolved = path.resolve(panelPath);
    const resolvedFile = path.resolve(resolved, filePath);

    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else {
      try {
        service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
      } catch { return null; }
    }

    const info = service.getQuickInfo(resolvedFile, line, column);
    if (!info) return null;
    return {
      displayParts: info.displayParts,
      documentation: info.documentation,
      tags: info.tags?.map(t => ({ name: t.name, text: t.text })),
    };
  },

  "typecheck.getCompletions": async (
    panelPath: string,
    filePath: string,
    line: number,
    column: number,
    fileContent?: string
  ): Promise<{ entries: { name: string; kind: string }[] } | null> => {
    const service = await getOrCreateTypeCheckService(panelPath);
    const resolved = path.resolve(panelPath);
    const resolvedFile = path.resolve(resolved, filePath);

    if (fileContent !== undefined) {
      service.updateFile(resolvedFile, fileContent);
    } else {
      try {
        service.updateFile(resolvedFile, await fs.readFile(resolvedFile, "utf-8"));
      } catch { return null; }
    }

    const completions = service.getCompletions(resolvedFile, line, column);
    if (!completions || completions.entries.length === 0) return null;

    return {
      entries: completions.entries.map(e => ({ name: e.name, kind: e.kind })),
    };
  },
};

/**
 * Clear the per-panel TypeCheckService cache. Tests use this between runs;
 * production code rarely needs it since caches are cheap to rebuild on the
 * next call.
 */
export function clearTypeCheckCache(): void {
  typeCheckServiceCache.clear();
}
