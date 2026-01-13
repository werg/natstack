/**
 * Tool Approval Utilities
 *
 * Functions for requesting user approval before executing tools
 * in an agentic workflow using feedback_form.
 */

import type { AgenticClient } from "./types.js";

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
 * Extract the actual method name from a prefixed tool name.
 * Tool names are formatted as: prefix_providerId_methodName
 * e.g., "pubsub_abc123_settings" -> "settings"
 */
export function extractMethodName(toolName: string): string {
  const parts = toolName.split("_");
  // If there are at least 3 parts (prefix_providerId_methodName), return the last part
  if (parts.length >= 3) {
    return parts.slice(2).join("_"); // Handle method names with underscores
  }
  return toolName;
}

/**
 * Determine if a tool needs approval based on approval level.
 *
 * Approval levels:
 * - 0: Ask - Always ask for approval
 * - 1: Auto Safe - Auto-approve read-only operations, ask for others
 * - 2: Full Auto - Never ask, execute all tools automatically
 */
export function needsApprovalForTool(
  toolName: string,
  approvalLevel: number
): boolean {
  if (approvalLevel >= 2) return false; // Full auto - never ask
  if (approvalLevel === 0) return true; // Ask all - always ask

  // Level 1: Auto-approve read-only operations
  // Extract actual method name from prefixed tool name for pattern matching
  const methodName = extractMethodName(toolName);
  const readPatterns = [/^read/i, /^get/i, /^list/i, /^search/i, /^find/i, /^query/i, /^fetch/i];
  const isReadOnly = readPatterns.some((p) => p.test(methodName));

  return !isReadOnly;
}
