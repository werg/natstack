/**
 * Permission Prompt — agent-side tool approval via feedback_form.
 *
 * Shows a permission prompt to the user via the panel's feedback_form method.
 * The prompt uses createApprovalSchema from @natstack/agentic-messaging for
 * consistent UI across all agents.
 */

import type { AgenticClient, ChatParticipantMetadata } from "@natstack/agentic-protocol";
import { createApprovalSchema, type CreateApprovalSchemaParams } from "@natstack/agentic-messaging";

// Re-export for consumers that import from agent-patterns
export { createApprovalSchema, type CreateApprovalSchemaParams };

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
 * Used by agent workers to request tool approval from the user.
 *
 * @param client - Connected agentic client
 * @param panelId - ID of the panel participant to show the prompt
 * @param toolName - Name of the tool requesting permission
 * @param input - Tool input arguments
 * @param options - Prompt options
 * @returns Promise resolving to allow/deny decision
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
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isExpectedError = errorMessage === "cancelled" ||
                           errorMessage.includes("connection") ||
                           errorMessage.includes("method not found");

    if (!isExpectedError) {
      console.warn(`[showPermissionPrompt] Unexpected error for ${toolName}: ${errorMessage}`);
    }
    // Always return deny on error - fail secure
    return { allow: false, alwaysAllow: false };
  }
}
