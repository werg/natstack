import { z } from "zod";

import type {
  ApprovalPrincipal,
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalRequest,
} from "@natstack/shared/approvals";
import {
  userlandApprovalRequestSchema,
  userlandApprovalSubjectIdSchema,
} from "@natstack/shared/approvals";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { UserlandApprovalGrantStore } from "./userlandApprovalGrantStore.js";

const SERVICE_NAME = "userlandApproval";

export function createUserlandApprovalService(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: Pick<UserlandApprovalGrantStore, "lookup" | "record" | "revoke" | "list">;
}): ServiceDefinition {
  function extensionIssuer(ctx: ServiceContext): UserlandApprovalIssuer | undefined {
    return ctx.caller.runtime.kind === "extension"
      ? { kind: "extension", id: ctx.caller.runtime.id }
      : undefined;
  }

  function decorateForIssuer(
    req: UserlandApprovalRequest,
    issuer: UserlandApprovalIssuer | undefined
  ): UserlandApprovalRequest {
    if (!issuer || issuer.kind !== "extension") return req;
    return {
      ...req,
      details: [{ label: "Extension", value: issuer.id }, ...(req.details ?? [])].slice(0, 8),
    };
  }

  async function resolvePrincipal(
    ctx: ServiceContext,
    method: string
  ): Promise<ApprovalPrincipal | null> {
    if (ctx.caller.runtime.kind === "extension") {
      return ctx.chainCaller ?? null;
    }
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        "userlandApproval is only available to panels, workers, DOs, and attributed extensions",
        "EACCES"
      );
    }
    const identity = ctx.caller.code;
    if (!identity) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Unknown caller identity: ${ctx.caller.runtime.id}`,
        "ENOENT"
      );
    }
    if (identity.callerKind !== ctx.caller.runtime.kind) {
      throw new ServiceError(
        SERVICE_NAME,
        method,
        `Caller identity kind mismatch for ${ctx.caller.runtime.id}`,
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
    if (!principal) return { kind: "uncallable", reason: "no-user-context" };
    const issuer = extensionIssuer(ctx);
    const decoratedReq = decorateForIssuer(req, issuer);
    const hit = deps.grantStore.lookup(principal.callerId, decoratedReq.subject.id, issuer);
    if (hit) {
      if (decoratedReq.options.some((option) => option.value === hit.choice)) {
        return { kind: "choice", choice: hit.choice };
      }
      try {
        await deps.grantStore.revoke(principal.callerId, decoratedReq.subject.id, issuer);
      } catch (err) {
        console.warn("[UserlandApprovalService] Failed to revoke stale approval grant:", err);
      }
    }

    const result = await deps.approvalQueue.requestUserland({ principal, issuer, ...decoratedReq });
    if (result.kind === "choice") {
      try {
        await deps.grantStore.record(
          { callerId: principal.callerId, callerKind: principal.callerKind },
          decoratedReq.subject,
          result.choice,
          Date.now(),
          issuer
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
    policy: { allowed: ["panel", "worker", "do", "extension"] },
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
          if (!principal) return { kind: "uncallable", reason: "no-user-context" };
          // Re-parse for transform application — see comment in `request`.
          const subjectId = userlandApprovalSubjectIdSchema.parse(args[0]);
          return await deps.grantStore.revoke(principal.callerId, subjectId, extensionIssuer(ctx));
        }
        case "list": {
          const principal = await resolvePrincipal(ctx, "list");
          if (!principal) return [];
          return deps.grantStore.list(
            principal.callerId,
            extensionIssuer(ctx)
          ) as UserlandApprovalGrant[];
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
