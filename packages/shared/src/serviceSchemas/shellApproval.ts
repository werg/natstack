/**
 * shellApproval service schema — trusted shell/mobile approval resolution and
 * approval queue rehydration.
 */

import { z } from "zod";
import type { PendingApproval } from "../approvals.js";
import { APPROVAL_DECISIONS } from "../approvalContract.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const shellApprovalValuesSchema = z.record(
  z.string().min(1).max(128),
  z.string().max(4096)
);

export const pendingApprovalSchema = z.custom<PendingApproval>(
  (value) => typeof value === "object" && value !== null
);

export const shellApprovalMethods = defineServiceMethods({
  resolve: {
    args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]),
    returns: z.void(),
  },
  resolveUserland: {
    args: z.tuple([z.string(), z.union([z.string().min(1).max(40), z.literal("dismiss")])]),
    returns: z.void(),
  },
  submitClientConfig: {
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
  },
  submitCredentialInput: {
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
  },
  listPending: {
    args: z.tuple([]),
    returns: z.array(pendingApprovalSchema),
  },
});
