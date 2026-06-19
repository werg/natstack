/**
 * shellApproval service schema — trusted shell/mobile approval resolution and
 * approval queue rehydration.
 */

import { z } from "zod";
import type { PendingApproval } from "../approvals.js";
import { APPROVAL_DECISIONS } from "../approvalContract.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const shellApprovalValuesSchema = z
  .record(z.string().min(1).max(128), z.string().max(4096))
  .describe(
    "Submitted field values keyed by field name (each key ≤128 chars, each value ≤4096 chars)."
  );

export const pendingApprovalSchema = z.custom<PendingApproval>(
  (value) => typeof value === "object" && value !== null
);

// Access descriptors shared across the shellApproval methods. Each call records
// a human's decision on a pending approval (resolving the queued request), so
// the resolution paths are writes; `listPending` is a pure read used to
// rehydrate the renderer's approval bar on mount. The service-level `policy`
// (shell/app/server) stays the enforced caller gate; we omit `access.callers`.
const RESOLVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const LIST_PENDING_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const shellApprovalMethods = defineServiceMethods({
  resolve: {
    description:
      "Record the user's decision (once/session/version/repo/deny/dismiss) on a pending approval, resolving its queued request.",
    args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "once"] }],
  },
  resolveBootstrap: {
    description:
      "Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval.",
    args: z.tuple([z.string(), z.enum(["once", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "deny"] }],
  },
  resolveUserland: {
    description:
      "Resolve a pending userland approval by selecting one of the presented option values (or 'dismiss'); rejects if the choice was not offered to the user.",
    args: z.tuple([z.string(), z.union([z.string().min(1).max(40), z.literal("dismiss")])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "dismiss"] }],
  },
  submitClientConfig: {
    description:
      "Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { clientId: "abc", clientSecret: "shh" }] }],
  },
  submitCredentialInput: {
    description:
      "Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { token: "secret-value" }] }],
  },
  submitSecretInput: {
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
  },
  listPending: {
    description:
      "List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount.",
    args: z.tuple([]),
    returns: z.array(pendingApprovalSchema),
    access: LIST_PENDING_ACCESS,
  },
});
