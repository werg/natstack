/**
 * Worker Base Utilities
 *
 * Shared utilities for LLM worker implementations (claude-code-responder, codex-responder, etc.).
 * Provides common patterns for permission prompts via feedback_form.
 */

import type { AgenticClient } from "./types.js";
import type { ChatParticipantMetadata } from "./responder-utils.js";
import {
  validateRequiredMethods,
  RESTRICTED_MODE_REQUIRED_METHODS,
  CANONICAL_PUBSUB_TOOL_NAMES,
  normalizeToolName,
  getCanonicalToolName,
  hasRichPreview,
} from "./tool-schemas.js";
import type { FieldDefinition } from "@natstack/runtime";

// ============================================================================
// Permission Prompts
// ============================================================================

/**
 * Options for permission prompts.
 */
export interface PermissionPromptOptions {
  /** Reason for the permission request (shown to user) */
  decisionReason?: string;
  /** Abort signal to cancel the prompt */
  signal?: AbortSignal;
}

/**
 * Show a permission prompt using feedback_form with the unified approval schema.
 * This is the pattern for tool approval in unrestricted mode (worker-side).
 *
 * Uses the same approvalHeader + toolPreview + buttonGroup pattern as restricted mode,
 * ensuring consistent UI regardless of where the approval check happens.
 *
 * @param client - Connected agentic client
 * @param panelId - ID of the panel participant to show the prompt
 * @param toolName - Name of the tool requesting permission
 * @param input - Tool input arguments
 * @param options - Prompt options
 * @returns Promise resolving to allow/deny decision
 *
 * @example
 * ```typescript
 * const { allow } = await showPermissionPrompt(
 *   client,
 *   panel.id,
 *   "file_write",
 *   { path: "/etc/config", content: "..." },
 *   { decisionReason: "Auto-safe mode requires approval for write operations" }
 * );
 * if (allow) {
 *   // Execute the tool
 * }
 * ```
 */
export async function showPermissionPrompt(
  client: AgenticClient<ChatParticipantMetadata>,
  panelId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionPromptOptions = {}
): Promise<{ allow: boolean }> {
  // Get agent name from client handle (worker's @mention name)
  const agentName = client.handle;
  const normalized = normalizeToolName(toolName);
  const displayName = getCanonicalToolName(normalized);

  const fields: FieldDefinition[] = [
    // Header - worker doesn't track first-time grants, so always per-call
    {
      key: "header",
      type: "approvalHeader",
      agentName,
      toolName: normalized,
      displayName,
      isFirstTimeGrant: false, // Worker doesn't track this
      floorLevel: 1, // Worker doesn't know panel's level
    },
  ];

  // Add reason field if provided
  if (options.decisionReason) {
    fields.push({
      key: "reason",
      label: "Reason",
      type: "readonly",
      default: options.decisionReason,
    });
  }

  // Add tool preview - use rich preview for supported tools, fallback to JSON
  if (hasRichPreview(normalized)) {
    fields.push({
      key: "preview",
      type: "toolPreview",
      toolName: normalized,
      toolArgs: input,
    });
  } else {
    fields.push({
      key: "args",
      label: "Arguments",
      type: "code",
      language: "json",
      maxHeight: 150,
      default: JSON.stringify(input, null, 2),
    });
  }

  // Decision buttons - use tool-specific labels for clarity
  const isPlanApproval = normalized === "exit_plan_mode";
  fields.push({
    key: "decision",
    type: "buttonGroup",
    submitOnSelect: true,
    buttons: isPlanApproval
      ? [
          { value: "deny", label: "Reject", color: "gray" },
          { value: "allow", label: "Approve Plan", color: "green" },
        ]
      : [
          { value: "deny", label: "Deny", color: "gray" },
          { value: "allow", label: "Allow", color: "green" },
        ],
  });

  const handle = client.callMethod(panelId, "feedback_form", {
    title: "", // Title is in the approvalHeader field
    severity: "warning",
    hideSubmit: true, // buttonGroup handles submission
    hideCancel: true,
    fields,
  }, { signal: options.signal });

  try {
    const result = await handle.result;
    const feedbackResult = result.content as { type: string; value?: Record<string, unknown>; message?: string };

    if (feedbackResult.type === "cancel") return { allow: false };
    return { allow: feedbackResult.value?.["decision"] === "allow" };
  } catch (err) {
    // Permission prompt failures can occur in normal scenarios:
    // - User closes the panel before responding
    // - Connection drops during the prompt
    // - Panel doesn't support feedback_form method
    //
    // We log at debug level to avoid noise, but include enough context
    // for troubleshooting when DEBUG=* or similar is enabled.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isExpectedError = errorMessage === "cancelled" ||
                           errorMessage.includes("connection") ||
                           errorMessage.includes("method not found");

    if (!isExpectedError) {
      // Unexpected errors warrant a warning for investigation
      console.warn(`[showPermissionPrompt] Unexpected error for ${displayName}: ${errorMessage}`);
    }
    // Always return deny on error - fail secure
    return { allow: false };
  }
}

// ============================================================================
// Panel Utilities
// ============================================================================

/**
 * Find the chat panel participant in the roster.
 *
 * @param client - Connected agentic client
 * @returns Panel participant or undefined if not found
 */
export function findPanelParticipant(
  client: AgenticClient<ChatParticipantMetadata>
): { id: string; metadata: ChatParticipantMetadata } | undefined {
  return Object.values(client.roster).find((p) => p.metadata.type === "panel");
}

// ============================================================================
// Restricted Mode Utilities
// ============================================================================

/**
 * Validate required methods for restricted mode and send warning if missing.
 *
 * @param client - Connected agentic client
 * @param log - Optional logging function
 * @returns Validation result with warningSent flag
 */
export async function validateRestrictedMode(
  client: AgenticClient<ChatParticipantMetadata>,
  log?: (message: string) => void
): Promise<{ ok: boolean; missing: string[]; warningSent: boolean }> {
  log?.("Restricted mode enabled - validating required methods...");

  const methods = client.discoverMethodDefs();
  const validation = validateRequiredMethods(methods, RESTRICTED_MODE_REQUIRED_METHODS);

  if (!validation.ok) {
    log?.(`Missing required methods: ${validation.missing.join(", ")}`);
    await client.send(
      `⚠️ **Restricted mode requires additional tools**\n\n` +
      `Missing methods: \`${validation.missing.join("`, `")}\`\n\n` +
      `Please ensure the chat panel provides these methods, or disable restricted mode.`
    );
    return { ...validation, warningSent: true };
  }

  const pubsubTools = validation.available.filter(
    (m): m is typeof CANONICAL_PUBSUB_TOOL_NAMES[number] =>
      (CANONICAL_PUBSUB_TOOL_NAMES as readonly string[]).includes(m)
  );
  log?.(`All required methods available: ${pubsubTools.join(", ")}`);
  return { ...validation, warningSent: false };
}

