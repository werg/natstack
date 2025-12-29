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

/**
 * Schema for agent parameter definition.
 */
export const AgentParameterDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "select"]),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  placeholder: z.string().optional(),
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
  parameters: z.array(AgentParameterDefinitionSchema).optional(),
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
