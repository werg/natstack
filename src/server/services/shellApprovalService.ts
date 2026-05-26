/**
 * Shell approval service — thin RPC shim over the in-memory approvalQueue.
 *
 * The renderer's ConsentApprovalBar calls `resolve` with a user decision and
 * `listPending` on mount to rehydrate. Shell and app-host callers are permitted directly.
 * Embedded Electron shell calls arrive through the trusted main-process
 * serverClient, so the server sees them as `server` callers. Panels/workers
 * remain blocked. Resolution paths record approval_resolved_total with the
 * transport caller kind as the source label.
 */

import { z } from "zod";
import { APPROVAL_DECISIONS } from "@natstack/shared/approvalContract";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalDecision } from "@natstack/shared/approvals";
import { ServiceError } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";
import { pushMetrics, type PushMetrics } from "./pushMetrics.js";

const USERLAND_RESOLVE_VALUES = ["dismiss"] as const;
const clientConfigValuesSchema = z.record(z.string().min(1).max(128), z.string().max(4096));
const credentialInputValuesSchema = clientConfigValuesSchema;

export function createShellApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  metrics?: PushMetrics;
}): ServiceDefinition {
  const { approvalQueue } = deps;
  const metrics = deps.metrics ?? pushMetrics;
  const serviceName = "shellApproval";

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    policy: { allowed: ["shell", "app", "server"] },
    methods: {
      resolve: { args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]) },
      resolveUserland: {
        args: z.tuple([
          z.string(),
          z.union([z.string().min(1).max(40), z.enum(USERLAND_RESOLVE_VALUES)]),
        ]),
      },
      submitClientConfig: { args: z.tuple([z.string(), clientConfigValuesSchema]) },
      submitCredentialInput: { args: z.tuple([z.string(), credentialInputValuesSchema]) },
      listPending: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "resolve": {
          const [approvalId, decision] = args as [string, ApprovalDecision];
          const existed = approvalQueue
            .listPending()
            .some((approval) => approval.approvalId === approvalId);
          approvalQueue.resolve(approvalId, decision);
          if (existed) {
            metrics.recordApprovalResolved({ decision, source: ctx.caller.runtime.kind });
          }
          return;
        }
        case "resolveUserland": {
          const [approvalId, choice] = args as [string, string | "dismiss"];
          const pending = approvalQueue
            .listPending()
            .find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "userland") {
            throw new ServiceError(
              serviceName,
              method,
              "No pending userland approval found",
              "ENOENT"
            );
          }
          if (choice === "dismiss") {
            approvalQueue.resolve(approvalId, "dismiss");
            metrics.recordApprovalResolved({
              decision: "dismiss",
              source: ctx.caller.runtime.kind,
            });
            return;
          }
          if (!pending.options.some((option) => option.value === choice)) {
            throw new ServiceError(
              serviceName,
              method,
              "Userland approval choice was not presented to the user",
              "EINVAL"
            );
          }
          approvalQueue.resolveUserland(approvalId, choice);
          metrics.recordApprovalResolved({ decision: choice, source: ctx.caller.runtime.kind });
          return;
        }
        case "submitClientConfig": {
          const [approvalId, values] = args as [string, Record<string, string>];
          const existed = approvalQueue
            .listPending()
            .some((approval) => approval.approvalId === approvalId);
          approvalQueue.submitClientConfig(approvalId, values);
          if (existed) {
            metrics.recordApprovalResolved({ decision: "submit", source: ctx.caller.runtime.kind });
          }
          return;
        }
        case "submitCredentialInput": {
          const [approvalId, values] = args as [string, Record<string, string>];
          const existed = approvalQueue
            .listPending()
            .some((approval) => approval.approvalId === approvalId);
          approvalQueue.submitCredentialInput(approvalId, values);
          if (existed) {
            metrics.recordApprovalResolved({ decision: "submit", source: ctx.caller.runtime.kind });
          }
          return;
        }
        case "listPending": {
          return approvalQueue.listPending();
        }
        default:
          throw new ServiceError(
            serviceName,
            method,
            `Unknown shellApproval method: ${method}`,
            "ENOSYS"
          );
      }
    },
  };
}
