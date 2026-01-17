/**
 * Create Approval Schema
 *
 * Utility function to build a consistent approval schema for both
 * unrestricted mode (worker builds schema) and restricted mode (middleware builds schema).
 *
 * The schema includes:
 * - approvalHeader: Agent name, tool name, first-time grant status, floor level
 * - toolPreview: Rich preview for supported tools (Monaco diffs, git previews)
 * - buttonGroup: Allow/Deny decision buttons
 */

import type { FieldDefinition } from "@natstack/runtime";
import {
  normalizeToolName,
  getCanonicalToolName,
  hasRichPreview,
} from "@natstack/agentic-messaging";

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
}

/**
 * Create a unified approval schema for tool approval prompts.
 *
 * This schema is used by both:
 * - Unrestricted mode: Worker builds schema and calls feedback_form RPC
 * - Restricted mode: Middleware builds schema and creates ActiveFeedbackSchema
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

  // Add tool preview for supported tools, otherwise the user just sees the header
  // The header will still show the tool name
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

  // Decision buttons
  fields.push({
    key: "decision",
    type: "buttonGroup",
    submitOnSelect: true,
    buttons: [
      { value: "deny", label: "Deny", color: "gray" },
      { value: "allow", label: params.isFirstTimeGrant ? "Grant Access" : "Allow", color: "green" },
    ],
  });

  return fields;
}
