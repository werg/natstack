import { z } from "zod";

export const NewMessageSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  contentType: z.string().optional(),
  replyTo: z.string().uuid().optional(),
  /** IDs of intended recipients (empty = broadcast to all) */
  at: z.array(z.string()).optional(),
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

export const ToolCallSchema = z.object({
  callId: z.string().uuid(),
  toolName: z.string().min(1),
  providerId: z.string().min(1),
  args: z.unknown(),
});

export const ToolResultSchema = z.object({
  callId: z.string().uuid(),
  content: z.unknown().optional(),
  contentType: z.string().optional(),
  complete: z.boolean().optional(),
  isError: z.boolean().optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const ToolCancelSchema = z.object({
  callId: z.string().uuid(),
});

export type NewMessage = z.infer<typeof NewMessageSchema>;
export type UpdateMessage = z.infer<typeof UpdateMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolCancel = z.infer<typeof ToolCancelSchema>;

