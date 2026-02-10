/**
 * @natstack/agentic-messaging protocol schemas
 *
 * Zod schemas for field definitions and feedback UI types.
 * These are used by the feedback system for form validation and UI rendering.
 */

import { z } from "zod";

/**
 * Schema for required method specification in agent type advertisements.
 */
export const RequiredMethodSpecSchema = z.object({
  name: z.string().min(1).optional(),
  pattern: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean(),
});

/**
 * Schema for method advertisement (matching existing MethodAdvertisement structure).
 */
export const MethodAdvertisementSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
  returns: z.record(z.unknown()).optional(),
  streaming: z.boolean().optional(),
  timeout: z.number().positive().optional(),
});

// Primitive field value type (for conditions and warnings)
const PrimitiveFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// Field value type (primitives + string arrays for multiSelect)
const FieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

// Condition for field visibility/enabled state (uses primitives only)
// Note: "contains" is for checking if an array field (multiSelect) contains a specific value
const FieldConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]),
  value: z.union([PrimitiveFieldValueSchema, z.array(PrimitiveFieldValueSchema)]),
});

// Slider notch for discrete labeled stops
const SliderNotchSchema = z.object({
  value: z.number(),
  label: z.string(),
  description: z.string().optional(),
});

// Warning to display for specific values (uses primitives only)
const FieldWarningSchema = z.object({
  when: z.union([PrimitiveFieldValueSchema, z.array(PrimitiveFieldValueSchema)]),
  message: z.string(),
  severity: z.enum(["info", "warning", "danger"]).optional(),
});

/**
 * Schema for field definition (formerly AgentParameterDefinition).
 * Matches FieldDefinition from @natstack/runtime.
 */
export const FieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(), // Optional - some field types (toolPreview, buttonGroup) have built-in headers
  description: z.string().optional(),
  type: z.enum([
    // Existing types
    "string", "number", "boolean", "select", "slider", "segmented", "toggle",
    // New types for feedback UI
    "readonly",       // Display-only text (non-editable)
    "code",           // Syntax-highlighted code/JSON block
    "buttonGroup",    // Horizontal action buttons (Allow/Deny style)
    "multiSelect",    // Multiple selection checkboxes
    "diff",           // Unified or side-by-side diff view
    "toolPreview",    // Rich tool argument preview (Monaco diff, git previews)
    "approvalHeader", // Tool approval header (first-time grant or per-call)
  ]),
  required: z.boolean().optional(),
  default: FieldValueSchema.optional(),
  channelLevel: z.boolean().optional(), // If true, value comes from channel config
  options: z
    .array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() }))
    .optional(),
  placeholder: z.string().optional(),

  // Slider-specific fields
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  notches: z.array(SliderNotchSchema).optional(),
  sliderLabels: z.object({ min: z.string().optional(), max: z.string().optional() }).optional(),

  // Grouping and ordering
  group: z.string().optional(),
  order: z.number().optional(),

  // Conditionality
  visibleWhen: z.union([FieldConditionSchema, z.array(FieldConditionSchema)]).optional(),
  enabledWhen: z.union([FieldConditionSchema, z.array(FieldConditionSchema)]).optional(),

  // Warnings
  warnings: z.array(FieldWarningSchema).optional(),

  // New properties for feedback UI field types

  // For code/readonly/diff fields
  language: z.string().optional(),      // "typescript", "json", "bash", "diff"
  maxHeight: z.number().optional(),     // Max scrollable height in px

  // For buttonGroup fields
  buttonStyle: z.enum(["outline", "solid", "soft"]).optional(),
  buttons: z.array(z.object({
    value: z.string(),
    label: z.string(),
    color: z.enum(["gray", "green", "red", "amber"]).optional(),
    description: z.string().optional(),
  })).optional(),

  // For select/multiSelect/buttonGroup - auto-submit when selected
  submitOnSelect: z.boolean().optional(),

  // For toolPreview fields
  toolName: z.string().optional(),   // Name of the tool (e.g., "file_edit", "git_commit")
  toolArgs: z.unknown().optional(),  // Tool input arguments to preview

  // For approvalHeader fields
  agentName: z.string().optional(),        // Name of the agent requesting permission
  displayName: z.string().optional(),      // Human-readable tool name
  isFirstTimeGrant: z.boolean().optional(), // Whether this is a first-time grant
  floorLevel: z.number().optional(),       // Current approval level (0=Ask, 1=Auto-Safe, 2=Full Auto)
});

/**
 * Schema for agent type advertisement.
 */
export const AgentTypeAdvertisementSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  proposedHandle: z.string().min(1),
  description: z.string(),
  providesMethods: z.array(MethodAdvertisementSchema),
  requiresMethods: z.array(RequiredMethodSpecSchema),
  parameters: z.array(FieldDefinitionSchema).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

// ============================================================================
// Feedback UI Types
// ============================================================================

/**
 * Arguments for feedback_form method.
 * Use this for standard forms with JSON schema-defined fields.
 */
export interface FeedbackFormArgs {
  title: string;
  fields: z.infer<typeof FieldDefinitionSchema>[];
  values?: Record<string, string | number | boolean | string[]>;
  submitLabel?: string;
  cancelLabel?: string;
  // New properties for feedback UI
  timeout?: number;                             // Auto-cancel/submit after N ms
  timeoutAction?: "cancel" | "submit";          // What happens on timeout
  severity?: "info" | "warning" | "danger";     // Affects styling/icon
  hideSubmit?: boolean;                         // Hide submit button (for buttonGroup with submitOnSelect)
  hideCancel?: boolean;                         // Hide cancel button
}

/**
 * Arguments for feedback_custom method.
 * Use this for complex custom UIs with custom layout, validation, or interactions.
 */
export interface FeedbackCustomArgs {
  code: string;
  /** Optional title for the feedback container header (default: "Agent requires input") */
  title?: string;
}

/**
 * Zod schema for feedback_form method arguments.
 */
export const FeedbackFormArgsSchema = z.object({
  title: z.string(),
  fields: z.array(FieldDefinitionSchema),
  values: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  submitLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
  // New properties for feedback UI
  timeout: z.number().optional(),                           // Auto-cancel/submit after N ms
  timeoutAction: z.enum(["cancel", "submit"]).optional(),   // What happens on timeout
  severity: z.enum(["info", "warning", "danger"]).optional(), // Affects styling/icon
  hideSubmit: z.boolean().optional(),                       // Hide submit button (for buttonGroup with submitOnSelect)
  hideCancel: z.boolean().optional(),                       // Hide cancel button
});

/**
 * Zod schema for feedback_custom method arguments.
 */
export const FeedbackCustomArgsSchema = z.object({
  code: z.string(),
  title: z.string().optional(),
});
