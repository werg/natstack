/**
 * Shared types for AI provider IPC communication.
 */

// =============================================================================
// Model Metadata
// =============================================================================

/**
 * Information about a model assigned to a role.
 * Panels access models by role (e.g., "fast", "smart"), not by provider-specific IDs.
 */
export interface AIModelInfo {
  /** Underlying model ID this role resolves to */
  modelId: string;
  /** Provider identifier (e.g., "anthropic", "openai") */
  provider: string;
  /** Human-readable display name of the model */
  displayName: string;
  /** Optional description */
  description?: string;
}

/**
 * Record mapping role names to their configured models.
 *
 * Standard roles (smart, fast, cheap, coding) are always present with defaults applied:
 * - smart <-> coding (both prefer fast if not configured)
 * - cheap <-> fast (both prefer smart if not configured)
 *
 * Additional custom roles can be added as needed.
 */
export type AIRoleRecord = {
  smart: AIModelInfo;
  fast: AIModelInfo;
  cheap: AIModelInfo;
  coding: AIModelInfo;
} & Record<string, AIModelInfo>;

// =============================================================================
// Tool Definition (used for validation)
// =============================================================================

/** Tool definition for function calling */
export interface AIToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}
