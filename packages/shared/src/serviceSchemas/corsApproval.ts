/**
 * corsApproval service schema — approval-gated CORS response header
 * relaxation. Single source of truth for the wire contract; the server
 * attaches the handler in src/server/services/corsApprovalService.ts.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// `authorize` may prompt the user for cross-origin response access (a network
// approval gate scoped to the target origin), so it carries an `approval`
// entry and write sensitivity rather than `readonly`.
const AUTHORIZE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
  approval: [
    {
      capability: "cors-response-read",
      operation: { kind: "network", verb: "Read cross-origin response" },
      grantScopes: ["once", "session", "version", "repo"],
      reason: "Reading CORS-protected responses from another origin requires user consent.",
    },
  ],
};

export const authorizeCorsSchema = z
  .object({
    targetUrl: z
      .string()
      .min(1)
      .describe("Absolute http(s) URL whose origin's CORS-protected responses should be readable."),
    requestOrigin: z
      .string()
      .min(1)
      .optional()
      .describe("Origin making the request, surfaced in the approval prompt; defaults to unknown."),
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
  authorize: {
    description:
      "Request approval to read CORS-protected responses from a target origin; may prompt the user and returns whether access was granted (with the persisted decision scope).",
    args: z.tuple([authorizeCorsSchema]),
    returns: corsApprovalResultSchema,
    access: AUTHORIZE_ACCESS,
    examples: [
      { args: [{ targetUrl: "https://api.example.com/data", requestOrigin: "https://app.local" }] },
    ],
  },
});
