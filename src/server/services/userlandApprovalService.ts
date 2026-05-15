import { z } from "zod";

import type {
  ApprovalPrincipal,
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalRequest,
} from "@natstack/shared/approvals";
import {
  userlandApprovalRequestSchema,
  userlandApprovalSubjectIdSchema,
} from "@natstack/shared/approvals";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import type { UserlandApprovalGrantStore } from "./userlandApprovalGrantStore.js";

const SERVICE_NAME = "userlandApproval";

export function createUserlandApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: Pick<UserlandApprovalGrantStore, "lookup" | "record" | "revoke" | "list">;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
}): ServiceDefinition {
  async function resolvePrincipal(ctx: ServiceContext, method: string): Promise<ApprovalPrincipal> {
    if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "userlandApproval is only available to panels and workers",
        "EACCES"
      );
    }
    const identity = deps.codeIdentityResolver.resolveByCallerId(ctx.callerId);
    if (!identity) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Unknown caller identity: ${ctx.callerId}`,
        "ENOENT"
      );
    }
    if (identity.callerKind !== ctx.callerKind) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Caller identity kind mismatch for ${ctx.callerId}`,
        "EACCES"
      );
    }
    return {
      callerId: identity.callerId,
      callerKind: identity.callerKind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
    };
  }

  async function request(
    ctx: ServiceContext,
    rawReq: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    // Re-parse to apply the schema's transforms (zero-width strip). The
    // dispatcher validates against this schema but discards parsed.data and
    // forwards the un-transformed input — see serviceDispatcher.ts at the
    // `args = normalized` line. Without this parse, post-strip uniqueness and
    // reserved-prefix invariants would not hold here.
    const req = userlandApprovalRequestSchema.parse(rawReq);
    const principal = await resolvePrincipal(ctx, "request");
    const hit = deps.grantStore.lookup(principal.callerId, req.subject.id);
    if (hit) {
      if (req.options.some((option) => option.value === hit.choice)) {
        return { kind: "choice", choice: hit.choice };
      }
      try {
        await deps.grantStore.revoke(principal.callerId, req.subject.id);
      } catch (err) {
        console.warn("[UserlandApprovalService] Failed to revoke stale approval grant:", err);
      }
    }

    const result = await deps.approvalQueue.requestUserland({ principal, ...req });
    if (result.kind === "choice") {
      try {
        await deps.grantStore.record(
          { callerId: principal.callerId, callerKind: principal.callerKind },
          req.subject,
          result.choice
        );
      } catch (err) {
        console.warn("[UserlandApprovalService] Failed to persist approval grant:", err);
      }
    }
    return result;
  }

  return {
    name: SERVICE_NAME,
    description: "Userland-managed consent approvals",
    policy: { allowed: ["panel", "worker"] },
    methods: {
      request: { args: z.tuple([userlandApprovalRequestSchema]) },
      revoke: { args: z.tuple([userlandApprovalSubjectIdSchema]) },
      list: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "request":
          return request(ctx, args[0] as UserlandApprovalRequest);
        case "revoke": {
          const principal = await resolvePrincipal(ctx, "revoke");
          // Re-parse for transform application — see comment in `request`.
          const subjectId = userlandApprovalSubjectIdSchema.parse(args[0]);
          return await deps.grantStore.revoke(principal.callerId, subjectId);
        }
        case "list": {
          const principal = await resolvePrincipal(ctx, "list");
          return deps.grantStore.list(principal.callerId) as UserlandApprovalGrant[];
        }
        default:
          throw new ServiceError(
            SERVICE_NAME,
            method,
            `Unknown userlandApproval method: ${method}`,
            "ENOSYS"
          );
      }
    },
  };
}
