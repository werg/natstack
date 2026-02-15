import { z } from "zod";

export const NewMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  contentType: z.string().optional(),
  replyTo: z.string().uuid().optional(),
  /** IDs of intended recipients (empty = broadcast to all) */
  at: z.array(z.string()).optional(),
  /** Arbitrary metadata (e.g., SDK session/message UUIDs for recovery) */
  metadata: z.record(z.unknown()).optional(),
});

export const UpdateMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string().optional(),
  contentType: z.string().optional(),
  complete: z.boolean().optional(),
});

export const ErrorMessageSchema = z.object({
  id: z.string().uuid(),
  error: z.string(),
  code: z.string().optional(),
});

export const MethodCallSchema = z.object({
  callId: z.string().uuid(),
  methodName: z.string().min(1),
  providerId: z.string().min(1),
  args: z.unknown(),
});

export const MethodResultSchema = z.object({
  callId: z.string().uuid(),
  content: z.unknown().optional(),
  contentType: z.string().optional(),
  complete: z.boolean().optional(),
  isError: z.boolean().optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const MethodCancelSchema = z.object({
  callId: z.string().uuid(),
});

export const ExecutionPauseSchema = z.object({
  messageId: z.string().uuid(),
  status: z.enum(["paused", "resumed", "cancelled"]),
  reason: z.string().optional(),
});

// Tool Role Negotiation Schemas
const ToolGroupSchema = z.enum(["file-ops", "git-ops", "workspace-ops"]);

export const ToolRoleRequestSchema = z.object({
  group: ToolGroupSchema,
  requesterId: z.string().min(1),
  requesterType: z.string().min(1),
});

export const ToolRoleResponseSchema = z.object({
  group: ToolGroupSchema,
  accepted: z.boolean(),
  handoffTo: z.string().optional(),
});

export const ToolRoleHandoffSchema = z.object({
  group: ToolGroupSchema,
  from: z.string().min(1),
  to: z.string().min(1),
});

export type NewMessage = z.infer<typeof NewMessageSchema>;
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type MethodCall = z.infer<typeof MethodCallSchema>;
export type MethodResult = z.infer<typeof MethodResultSchema>;
export type MethodCancel = z.infer<typeof MethodCancelSchema>;
export type ExecutionPause = z.infer<typeof ExecutionPauseSchema>;
export type ToolRoleRequest = z.infer<typeof ToolRoleRequestSchema>;
export type ToolRoleResponse = z.infer<typeof ToolRoleResponseSchema>;
export type ToolRoleHandoff = z.infer<typeof ToolRoleHandoffSchema>;
