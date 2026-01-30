/**
 * TypeScript type checking tools for pubsub RPC.
 *
 * Implements: check_types, get_type_info, get_completions
 * These tools provide TypeScript language service features for panel/worker development.
 *
 * NOTE: TypeScript (~17MB) is lazy-loaded on first tool invocation to reduce initial bundle size.
 */

import * as fs from "fs";
import * as path from "path";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import {
  CheckTypesArgsSchema,
  GetTypeInfoArgsSchema,
  GetCompletionsArgsSchema,
  type CheckTypesArgs,
  type GetTypeInfoArgs,
  type GetCompletionsArgs,
} from "@natstack/agentic-messaging";
import { rpc } from "@natstack/runtime";
import type { TypeCheckService, TypeCheckDiagnostic, TypeCheckDiagnosticsEvent } from "@natstack/runtime/typecheck";

// Lazy-loaded typecheck module (defers ~17MB TypeScript load until first use)
let typecheckModule: typeof import("@natstack/runtime/typecheck") | null = null;

async function getTypecheckModule() {
  if (!typecheckModule) {
    typecheckModule = await import("@natstack/runtime/typecheck");
  }
  return typecheckModule;
}

// Cache of TypeCheckService instances per panel path
const serviceCache = new Map<string, TypeCheckService>();

/**
 * Get or create a TypeCheckService for a panel path.
 * Uses the factory to create a service with external type loading support.
 */
async function getOrCreateService(panelPath: string): Promise<TypeCheckService> {
  const resolved = path.resolve(panelPath);

  if (serviceCache.has(resolved)) {
    return serviceCache.get(resolved)!;
  }

  // Lazy load the typecheck module
  const { createPanelTypeCheckService, createDiskFileSource } = await getTypecheckModule();

  // Use the factory to create a properly configured service with RPC support
  const service = await createPanelTypeCheckService({
    panelPath: resolved,
    fileSource: createDiskFileSource(resolved),
    rpcCall: <T>(targetId: string, method: string, ...args: unknown[]) =>
      rpc.call<T>(targetId, method, ...args),
  });

  serviceCache.set(resolved, service);
  return service;
}

/**
 * Format diagnostics for display.
 */
function formatDiagnostics(diagnostics: TypeCheckDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No type errors found.";
  }

  const grouped = new Map<string, TypeCheckDiagnostic[]>();
  for (const d of diagnostics) {
    const key = d.file || "(unknown)";
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(d);
  }

  const lines: string[] = [];
  for (const [file, fileDiagnostics] of grouped) {
    lines.push(`\n${file}:`);
    for (const d of fileDiagnostics) {
      const severity = d.severity.toUpperCase();
      const location = `${d.line}:${d.column}`;
      lines.push(`  ${location} - ${severity} TS${d.code}: ${d.message}`);
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  lines.unshift(
    `Found ${errorCount} error${errorCount !== 1 ? "s" : ""} and ${warningCount} warning${warningCount !== 1 ? "s" : ""}.`
  );

  return lines.join("\n");
}

/**
 * check_types - Run TypeScript type checking with external type resolution
 */
export async function checkTypes(args: CheckTypesArgs): Promise<string> {
  const service = await getOrCreateService(args.panel_path);

  // If a specific file is provided, ensure it's loaded/updated
  if (args.file_path) {
    const resolvedFile = path.resolve(args.panel_path, args.file_path);
    try {
      const content = await fs.promises.readFile(resolvedFile, "utf-8");
      service.updateFile(resolvedFile, content);
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Use checkWithExternalTypes for automatic external package type loading
  const result = await service.checkWithExternalTypes(
    args.file_path ? path.resolve(args.panel_path, args.file_path) : undefined
  );
  return formatDiagnostics(result.diagnostics);
}

/**
 * get_type_info - Get type information at a position
 */
export async function getTypeInfo(args: GetTypeInfoArgs): Promise<string> {
  const service = await getOrCreateService(args.panel_path);
  const resolvedFile = path.resolve(args.panel_path, args.file_path);

  // Ensure file is loaded
  if (!service.hasFile(resolvedFile)) {
    try {
      const content = await fs.promises.readFile(resolvedFile, "utf-8");
      service.updateFile(resolvedFile, content);
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const info = service.getQuickInfo(resolvedFile, args.line, args.column);

  if (!info) {
    return `No type information available at ${args.file_path}:${args.line}:${args.column}`;
  }

  const lines: string[] = [info.displayParts];

  if (info.documentation) {
    lines.push("", "Documentation:", info.documentation);
  }

  if (info.tags && info.tags.length > 0) {
    lines.push("", "Tags:");
    for (const tag of info.tags) {
      lines.push(`  @${tag.name}${tag.text ? ` ${tag.text}` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * get_completions - Get code completions at a position
 */
export async function getCompletions(args: GetCompletionsArgs): Promise<string> {
  const service = await getOrCreateService(args.panel_path);
  const resolvedFile = path.resolve(args.panel_path, args.file_path);

  // Ensure file is loaded
  if (!service.hasFile(resolvedFile)) {
    try {
      const content = await fs.promises.readFile(resolvedFile, "utf-8");
      service.updateFile(resolvedFile, content);
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const completions = service.getCompletions(resolvedFile, args.line, args.column);

  if (!completions || completions.entries.length === 0) {
    return `No completions available at ${args.file_path}:${args.line}:${args.column}`;
  }

  // Limit to first 50 completions to avoid overwhelming output
  const entries = completions.entries.slice(0, 50);

  const lines: string[] = [`${completions.entries.length} completions available:`];

  for (const entry of entries) {
    const kind = entry.kind;
    lines.push(`  ${entry.name} (${kind})`);
  }

  if (completions.entries.length > 50) {
    lines.push(`  ... and ${completions.entries.length - 50} more`);
  }

  return lines.join("\n");
}

/**
 * Publish function type for broadcasting diagnostics.
 *
 * Diagnostics are published to the current chat channel using the
 * TYPECHECK_EVENTS.DIAGNOSTICS event type. Other panels connected
 * to the same channel can filter for this event type to receive updates.
 */
export type DiagnosticsPublisher = (eventType: string, payload: unknown) => void;

/**
 * Create method definitions for type checking tools.
 *
 * @param publish - Optional function to broadcast diagnostics via PubSub
 */
export function createTypeCheckToolMethodDefinitions(
  publish?: DiagnosticsPublisher
): Record<string, MethodDefinition> {
  return {
    check_types: {
      description: "Run TypeScript type checking on panel/worker files. Returns diagnostics (errors, warnings, suggestions) from the TypeScript compiler with custom resolution matching the NatStack build system. Automatically resolves external package types.",
      parameters: CheckTypesArgsSchema,
      execute: async (args: CheckTypesArgs) => {
        const service = await getOrCreateService(args.panel_path);
        const filePath = args.file_path ? path.resolve(args.panel_path, args.file_path) : undefined;

        // If a specific file is provided, ensure it's loaded/updated
        if (args.file_path && filePath) {
          try {
            const content = await fs.promises.readFile(filePath, "utf-8");
            service.updateFile(filePath, content);
          } catch (err) {
            return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Single check with external type loading
        const checkResult = await service.checkWithExternalTypes(filePath);

        // Broadcast diagnostics if publisher available
        if (publish) {
          const { TYPECHECK_EVENTS } = await getTypecheckModule();
          const event: TypeCheckDiagnosticsEvent = {
            panelPath: args.panel_path,
            diagnostics: checkResult.diagnostics,
            timestamp: Date.now(),
            checkedFiles: checkResult.checkedFiles,
          };
          publish(TYPECHECK_EVENTS.DIAGNOSTICS, event);
        }

        return formatDiagnostics(checkResult.diagnostics);
      },
    },
    get_type_info: {
      description: "Get TypeScript type information at a specific position in a file. Returns the type signature, documentation, and any JSDoc tags.",
      parameters: GetTypeInfoArgsSchema,
      execute: getTypeInfo,
    },
    get_completions: {
      description: "Get code completions (autocomplete suggestions) at a specific position. Returns available identifiers, their kinds (function, variable, etc.), and basic info.",
      parameters: GetCompletionsArgsSchema,
      execute: getCompletions,
    },
  };
}
