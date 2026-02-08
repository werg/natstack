/**
 * Tool Approval Utilities
 *
 * Functions for requesting user approval before executing tools
 * in an agentic workflow using feedback_form.
 */

import type { AgenticClient } from "./types.js";
import {
  CANONICAL_TOOL_MAPPINGS,
  REVERSE_CANONICAL_MAPPINGS,
  extractMethodName,
  normalizeToolName,
} from "./tool-name-utils.js";

/**
 * Approval level constants for tool execution.
 *
 * These define how much autonomy the agent has when executing tools:
 * - ASK_ALL: Always prompt user for approval before any tool execution
 * - AUTO_SAFE: Auto-approve read-only operations, prompt for write operations
 * - FULL_AUTO: Execute all tools without prompting (use with caution)
 */
export const APPROVAL_LEVELS = {
  /** Always ask for approval before executing any tool */
  ASK_ALL: 0,
  /** Auto-approve read-only operations, ask for write operations */
  AUTO_SAFE: 1,
  /** Never ask, execute all tools automatically */
  FULL_AUTO: 2,
} as const;

export type ApprovalLevel = typeof APPROVAL_LEVELS[keyof typeof APPROVAL_LEVELS];

/**
 * Base read-only tools (snake_case) - single source of truth.
 * These tools don't modify state and can be auto-approved at the "Auto-Safe" level.
 */
const READ_ONLY_BASE_TOOLS = [
  "file_read", "glob", "grep", "tree", "list_directory",
  "git_status", "git_diff", "git_log",
  "workspace_list", "context_info", "context_template_list", "context_template_read",
] as const;

/**
 * Read-only tools set including both naming conventions.
 * Derived from READ_ONLY_BASE_TOOLS using canonical mappings.
 */
export const READ_ONLY_TOOLS = new Set<string>([
  ...READ_ONLY_BASE_TOOLS,
  ...READ_ONLY_BASE_TOOLS.map(name => CANONICAL_TOOL_MAPPINGS[name]).filter((v): v is string => v !== undefined),
]);

export interface ApprovalOptions {
  title?: string;
  severity?: "info" | "warning" | "danger";
  showArgs?: boolean;
  /** Abort signal to cancel the approval request */
  signal?: AbortSignal;
}

/**
 * Show tool approval UI via feedback_form and wait for user decision.
 * Returns false if cancelled or aborted.
 */
export async function requestToolApproval(
  client: AgenticClient,
  panelId: string,
  toolName: string,
  args: Record<string, unknown>,
  options: ApprovalOptions = {}
): Promise<boolean> {
  // Extract display name from prefixed tool name (e.g., "pubsub_abc123_settings" -> "settings")
  const displayName = extractMethodName(toolName);

  const fields: Array<Record<string, unknown>> = [
    {
      key: "tool",
      label: "Tool",
      type: "readonly",
      default: displayName,
    },
  ];

  if (options.showArgs !== false) {
    fields.push({
      key: "args",
      label: "Arguments",
      type: "code",
      language: "json",
      maxHeight: 150,
      default: JSON.stringify(args, null, 2),
    });
  }

  fields.push({
    key: "decision",
    label: "Decision",
    type: "buttonGroup",
    submitOnSelect: true,
    buttons: [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Allow", color: "green" },
    ],
  });

  const handle = client.callMethod(panelId, "feedback_form", {
    title: options.title ?? `Allow ${displayName}?`,
    severity: options.severity ?? "warning",
    hideSubmit: true,
    fields,
  }, { signal: options.signal });

  try {
    const result = await handle.result;
    const content = result.content as { type?: string; value?: Record<string, unknown> } | undefined;
    if (content?.type === "cancel") return false;
    return content?.value?.["decision"] === "allow";
  } catch (err) {
    // If aborted or cancelled, return false (deny)
    if (err instanceof Error && err.message === "cancelled") {
      return false;
    }
    throw err;
  }
}

/**
 * Check if a tool is read-only (safe for auto-approval at level 1).
 * Uses both the explicit READ_ONLY_TOOLS set and pattern matching.
 */
export function isReadOnlyTool(methodName: string): boolean {
  // Check explicit list first
  if (READ_ONLY_TOOLS.has(methodName)) return true;

  // Try reverse lookup for canonical names
  const snakeName = REVERSE_CANONICAL_MAPPINGS[methodName];
  if (snakeName && READ_ONLY_TOOLS.has(snakeName)) return true;

  // Fall back to pattern matching for additional tools
  const readPatterns = [/^read/i, /^get/i, /^list/i, /^search/i, /^find/i, /^query/i, /^fetch/i];
  return readPatterns.some((p) => p.test(methodName));
}

/**
 * Determine if a tool needs approval based on approval level.
 *
 * @param toolName - The tool name (may be prefixed or in any naming convention)
 * @param approvalLevel - One of APPROVAL_LEVELS (ASK_ALL, AUTO_SAFE, FULL_AUTO)
 * @returns true if user approval is required, false if auto-approved
 *
 * @see APPROVAL_LEVELS for level definitions
 */
export function needsApprovalForTool(
  toolName: string,
  approvalLevel: ApprovalLevel | number
): boolean {
  if (approvalLevel >= APPROVAL_LEVELS.FULL_AUTO) return false; // Full auto - never ask
  if (approvalLevel === APPROVAL_LEVELS.ASK_ALL) return true; // Ask all - always ask

  // AUTO_SAFE (level 1): Auto-approve read-only operations
  // Try multiple naming conventions to handle SDK tool names
  const methodName = extractMethodName(toolName);

  // First check the raw method name (handles PascalCase like "Read", "Glob")
  if (isReadOnlyTool(methodName)) return false;

  // Also try normalized snake_case (handles "Read" → "file_read")
  const normalized = normalizeToolName(toolName);
  if (isReadOnlyTool(normalized)) return false;

  // Tool is not read-only, requires approval
  return true;
}
