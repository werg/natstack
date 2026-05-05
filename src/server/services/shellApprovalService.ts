/**
 * Shell approval service — thin RPC shim over the in-memory approvalQueue.
 *
 * The renderer's ConsentApprovalBar calls `resolve` with a user decision and
 * `listPending` on mount to rehydrate. Shell callers are permitted directly.
 * Embedded Electron shell calls arrive through the trusted main-process
 * serverClient, so the server sees them as `server` callers. Panels/workers
 * remain blocked.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalDecision } from "@natstack/shared/approvals";
import type { ApprovalQueue } from "./approvalQueue.js";

const DECISION_VALUES = ["once", "session", "version", "repo", "deny", "dismiss"] as const;
const clientConfigValuesSchema = z.record(z.string().min(1).max(128), z.string().max(4096));
const credentialInputValuesSchema = clientConfigValuesSchema;

export function createShellApprovalService(deps: {
  approvalQueue: ApprovalQueue;
}): ServiceDefinition {
  const { approvalQueue } = deps;

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    policy: { allowed: ["shell", "server"] },
    methods: {
      resolve: { args: z.tuple([z.string(), z.enum(DECISION_VALUES)]) },
      submitClientConfig: { args: z.tuple([z.string(), clientConfigValuesSchema]) },
      submitCredentialInput: { args: z.tuple([z.string(), credentialInputValuesSchema]) },
      listPending: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "resolve": {
          const [approvalId, decision] = args as [string, ApprovalDecision];
          approvalQueue.resolve(approvalId, decision);
          return;
        }
        case "submitClientConfig": {
          const [approvalId, values] = args as [string, Record<string, string>];
          approvalQueue.submitClientConfig(approvalId, values);
          return;
        }
        case "submitCredentialInput": {
          const [approvalId, values] = args as [string, Record<string, string>];
          approvalQueue.submitCredentialInput(approvalId, values);
          return;
        }
        case "listPending": {
          return approvalQueue.listPending();
        }
        default:
          throw new Error(`Unknown shellApproval method: ${method}`);
      }
    },
  };
}
