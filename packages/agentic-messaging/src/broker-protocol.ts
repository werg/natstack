/**
 * @natstack/agentic-messaging broker protocol
 *
 * Zod schemas for broker invite/response messages.
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

// Field value type
const FieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);

// Condition for field visibility/enabled state
const FieldConditionSchema = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in"]),
  value: z.union([FieldValueSchema, z.array(FieldValueSchema)]),
});

// Slider notch for discrete labeled stops
const SliderNotchSchema = z.object({
  value: z.number(),
  label: z.string(),
  description: z.string().optional(),
});

// Warning to display for specific values
const FieldWarningSchema = z.object({
  when: z.union([FieldValueSchema, z.array(FieldValueSchema)]),
  message: z.string(),
  severity: z.enum(["info", "warning", "danger"]).optional(),
});

/**
 * Schema for field definition (formerly AgentParameterDefinition).
 * Matches FieldDefinition from @natstack/runtime.
 */
export const FieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "select", "slider", "segmented", "toggle"]),
  required: z.boolean().optional(),
  default: FieldValueSchema.optional(),
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

/**
 * Schema for broker metadata.
 */
export const BrokerMetadataSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  isBroker: z.literal(true),
  agentTypes: z.array(AgentTypeAdvertisementSchema),
  brokerVersion: z.string().optional(),
  methods: z.array(MethodAdvertisementSchema).optional(),
});

/**
 * Schema for invite message payload.
 */
export const InviteSchema = z.object({
  inviteId: z.string().uuid(),
  targetChannel: z.string().min(1),
  agentTypeId: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  context: z.string().optional(),
  handleOverride: z.string().min(1).optional(),
  ts: z.number(),
});

/**
 * Schema for invite response payload.
 */
export const InviteResponseSchema = z.object({
  inviteId: z.string().uuid(),
  accepted: z.boolean(),
  declineReason: z.string().optional(),
  declineCode: z
    .enum([
      "unknown-agent-type",
      "capacity-exceeded",
      "invalid-config",
      "target-unreachable",
      "internal-error",
      "declined-by-policy",
      "timeout",
    ])
    .optional(),
  agentId: z.string().optional(),
  ts: z.number(),
});

// Export inferred types for convenience
export type InviteMessage = z.infer<typeof InviteSchema>;
export type InviteResponseMessage = z.infer<typeof InviteResponseSchema>;
export type AgentTypeAdvertisementMessage = z.infer<typeof AgentTypeAdvertisementSchema>;
export type BrokerMetadataMessage = z.infer<typeof BrokerMetadataSchema>;

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
  values?: Record<string, string | number | boolean>;
  submitLabel?: string;
  cancelLabel?: string;
}

/**
 * Arguments for feedback_custom method.
 * Use this for complex custom UIs with custom layout, validation, or interactions.
 */
export interface FeedbackCustomArgs {
  code: string;
}

/**
 * Zod schema for feedback_form method arguments.
 */
export const FeedbackFormArgsSchema = z.object({
  title: z.string(),
  fields: z.array(FieldDefinitionSchema),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  submitLabel: z.string().optional(),
  cancelLabel: z.string().optional(),
});

/**
 * Zod schema for feedback_custom method arguments.
 */
export const FeedbackCustomArgsSchema = z.object({
  code: z.string(),
});
