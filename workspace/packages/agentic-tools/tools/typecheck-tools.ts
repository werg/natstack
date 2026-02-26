/**
 * TypeScript type checking tools for pubsub RPC.
 *
 * Implements: check_types, get_type_info, get_completions
 * These tools provide TypeScript language service features for panel/worker development.
 *
 * Type checking runs in the main process via RPC, keeping the ~17MB TypeScript
 * compiler out of the chat panel bundle.
 */

import type { MethodDefinition } from "@workspace/agentic-messaging";
import {
  CheckTypesArgsSchema,
  GetTypeInfoArgsSchema,
  GetCompletionsArgsSchema,
  type CheckTypesArgs,
  type GetTypeInfoArgs,
  type GetCompletionsArgs,
} from "@workspace/agentic-messaging/tool-schemas";
import { rpc } from "@workspace/runtime";

/** Diagnostic shape returned by the main process RPC */
interface RpcDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: "error" | "warning" | "info";
  code: number;
}

/** Quick info shape returned by the main process RPC */
interface RpcQuickInfo {
  displayParts: string;
  documentation?: string;
  tags?: { name: string; text?: string }[];
}

/**
 * Format diagnostics for display.
 */
function formatDiagnostics(diagnostics: RpcDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No type errors found.";
  }

  const grouped = new Map<string, RpcDiagnostic[]>();
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
 * check_types - Run TypeScript type checking via main process RPC
 */
export async function checkTypes(args: CheckTypesArgs, publish?: DiagnosticsPublisher): Promise<string> {
  const result = await rpc.call<{ diagnostics: RpcDiagnostic[]; checkedFiles: string[] }>(
    "main", "typecheck.check", args.panel_path, args.file_path, undefined
  );

  if (publish) {
    publish("typecheck:diagnostics", {
      panelPath: args.panel_path,
      diagnostics: result.diagnostics,
      timestamp: Date.now(),
      checkedFiles: result.checkedFiles,
    });
  }

  return formatDiagnostics(result.diagnostics);
}

/**
 * get_type_info - Get type information at a position via main process RPC
 */
export async function getTypeInfo(args: GetTypeInfoArgs): Promise<string> {
  const info = await rpc.call<RpcQuickInfo | null>(
    "main", "typecheck.getTypeInfo", args.panel_path, args.file_path, args.line, args.column, undefined
  );

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
 * get_completions - Get code completions at a position via main process RPC
 */
export async function getCompletions(args: GetCompletionsArgs): Promise<string> {
  const completions = await rpc.call<{ entries: { name: string; kind: string }[] } | null>(
    "main", "typecheck.getCompletions", args.panel_path, args.file_path, args.line, args.column, undefined
  );

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
      execute: (args: CheckTypesArgs) => checkTypes(args, publish),
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
