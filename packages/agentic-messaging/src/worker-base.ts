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
import type { FieldDefinition } from "@natstack/core";

// ============================================================================
// Unified Approval Schema
// ============================================================================

/**
 * Parameters for creating an approval schema.
 */
export interface CreateApprovalSchemaParams {
  /** Name of the agent requesting access */
  agentName: string;
  /** Tool name (any format - will be normalized) */
  toolName: string;
  /** Optional display name override for the tool */
  displayName?: string;
  /** Tool input arguments */
  args: unknown;
  /** Whether this is a first-time grant (vs per-call) */
  isFirstTimeGrant: boolean;
  /** Current approval level (0=Ask All, 1=Auto-Safe, 2=Full Auto) */
  floorLevel: number;
  /** Optional reason for the permission request (shown to user) */
  reason?: string;
}

/**
 * Create a unified approval schema for tool approval prompts.
 *
 * This schema is used by both:
 * - Unrestricted mode: Worker builds schema and calls feedback_form RPC
 * - Restricted mode: Panel middleware builds schema and creates ActiveFeedbackSchema
 *
 * The schema provides consistent UI regardless of where the approval check happens:
 * - approvalHeader: Shows agent name, tool name, first-time grant status, floor level
 * - reason (optional): Shows why approval is needed
 * - toolPreview: Rich preview for supported tools (Monaco diffs, git previews)
 * - buttonGroup: Allow/Deny decision buttons with tool-specific labels
 *
 * @param params - Parameters for the approval schema
 * @returns Array of field definitions for the approval form
 */
export function createApprovalSchema(params: CreateApprovalSchemaParams): FieldDefinition[] {
  const normalized = normalizeToolName(params.toolName);
  const displayName = params.displayName ?? getCanonicalToolName(normalized);

  const fields: FieldDefinition[] = [
    // Header with agent info and approval context
    {
      key: "header",
      type: "approvalHeader",
      agentName: params.agentName,
      toolName: normalized,
      displayName,
      isFirstTimeGrant: params.isFirstTimeGrant,
      floorLevel: params.floorLevel,
    },
  ];

  // Add reason field if provided
  if (params.reason) {
    fields.push({
      key: "reason",
      label: "Reason",
      type: "readonly",
      default: params.reason,
    });
  }

  // Add tool preview for supported tools, otherwise show JSON args
  if (hasRichPreview(normalized)) {
    fields.push({
      key: "preview",
      type: "toolPreview",
      toolName: normalized,
      toolArgs: params.args,
    });
  } else {
    // For tools without rich preview, show JSON args
    fields.push({
      key: "args",
      label: "Arguments",
      type: "code",
      language: "json",
      maxHeight: 150,
      default: JSON.stringify(params.args, null, 2),
    });
  }

  // Decision buttons - use tool-specific labels for clarity
  const isExitPlanApproval = normalized === "exit_plan_mode";
  const isEnterPlanApproval = normalized === "enter_plan_mode";

  let buttons: Array<{ value: string; label: string; color: "gray" | "green" | "amber" }>;
  if (isExitPlanApproval) {
    buttons = [
      { value: "deny", label: "Reject", color: "gray" },
      { value: "allow", label: "Approve Plan", color: "green" },
      { value: "always", label: "Trust Agent", color: "amber" },
    ];
  } else if (isEnterPlanApproval) {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Enter Plan Mode", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  } else if (params.isFirstTimeGrant) {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Grant Access", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  } else {
    buttons = [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: "Allow", color: "green" },
      { value: "always", label: "Always Allow", color: "amber" },
    ];
  }

  fields.push({
    key: "decision",
    type: "buttonGroup",
    submitOnSelect: true,
    buttons,
  });

  return fields;
}

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
  /** Whether this is the first-time grant for this agent (shows different UI) */
  isFirstTimeGrant?: boolean;
  /** Current approval level from panel settings (0=Ask All, 1=Auto-Safe, 2=Full Auto) */
  floorLevel?: number;
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
): Promise<{ allow: boolean; alwaysAllow?: boolean }> {
  // Build unified approval schema
  const fields = createApprovalSchema({
    agentName: client.handle,
    toolName,
    args: input,
    isFirstTimeGrant: options.isFirstTimeGrant ?? false,
    floorLevel: options.floorLevel ?? 1, // Default to Auto-Safe if unknown
    reason: options.decisionReason,
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

    if (feedbackResult.type === "cancel") return { allow: false, alwaysAllow: false };
    const decision = feedbackResult.value?.["decision"];
    return {
      allow: decision === "allow" || decision === "always",
      alwaysAllow: decision === "always",
    };
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
      console.warn(`[showPermissionPrompt] Unexpected error for ${toolName}: ${errorMessage}`);
    }
    // Always return deny on error - fail secure
    return { allow: false, alwaysAllow: false };
  }
}

// ============================================================================
// Panel Utilities
// ============================================================================

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

