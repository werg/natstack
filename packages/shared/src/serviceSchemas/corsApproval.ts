/**
 * corsApproval service schema — approval-gated CORS response header
 * relaxation. Single source of truth for the wire contract; the server
 * attaches the handler in src/server/services/corsApprovalService.ts.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const authorizeCorsSchema = z
  .object({
    targetUrl: z.string().min(1),
    requestOrigin: z.string().min(1).optional(),
  })
  .strict();

export type AuthorizeCorsRequest = z.infer<typeof authorizeCorsSchema>;

// `decision` mirrors Exclude<GrantedDecision, "deny"> from the approval queue.
export const corsApprovalResultSchema = z.object({
  allowed: z.boolean(),
  decision: z.enum(["once", "session", "version", "repo"]).optional(),
  reason: z.string().optional(),
});

export type CorsApprovalResult = z.infer<typeof corsApprovalResultSchema>;

export const corsApprovalMethods = defineServiceMethods({
  authorize: { args: z.tuple([authorizeCorsSchema]), returns: corsApprovalResultSchema },
});
