import { z } from "zod";

import type {
  ApprovalPrincipal,
  UserlandApprovalChoice,
  UserlandApprovalGrantScope,
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalOption,
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
const SCOPED_ALLOW_OPTIONS: UserlandApprovalOption[] = [
  {
    value: "once",
    label: "Allow once",
    description: "Allow this request only.",
    tone: "neutral",
  },
  {
    value: "session",
    label: "Allow this session",
    description: "Remember for this caller until NatStack restarts.",
    tone: "neutral",
  },
  {
    value: "version",
    label: "Trust version",
    description: "Remember for this exact code version.",
    tone: "primary",
  },
  { value: "deny", label: "Deny", description: "Do not allow this request.", tone: "danger" },
];
const BINARY_OPTIONS: UserlandApprovalOption[] = [
  { value: "allow", label: "Allow", tone: "primary" },
  { value: "deny", label: "Deny", tone: "danger" },
];

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
      ctx.caller.runtime.kind !== "app" &&
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
    const promptOptions = decoratedReq.promptOptions ?? "scoped";
    const options =
      promptOptions === "scoped" ? SCOPED_ALLOW_OPTIONS : (decoratedReq.options ?? BINARY_OPTIONS);
    const hit = deps.grantStore.lookup(principal, decoratedReq.subject.id, issuer);
    if (hit) {
      if (isCachedChoiceValid(promptOptions, options, hit.choice)) {
        return { kind: "choice", choice: hit.choice };
      }
      try {
        await deps.grantStore.revoke(principal, decoratedReq.subject.id, issuer);
      } catch (err) {
        console.warn("[UserlandApprovalService] Failed to revoke stale approval grant:", err);
      }
    }

    const result = await deps.approvalQueue.requestUserland({
      principal,
      issuer,
      ...decoratedReq,
      promptOptions,
      options,
    });
    if (result.kind === "choice") {
      const resolved = resolvePromptChoice(promptOptions, result.choice);
      if (!resolved.record) return { kind: "choice", choice: resolved.choice };
      try {
        await deps.grantStore.record(
          principal,
          decoratedReq.subject,
          resolved.choice,
          Date.now(),
          issuer,
          resolved.scope
        );
        if (typeof deps.approvalQueue.resolveMatchingUserland === "function") {
          deps.approvalQueue.resolveMatchingUserland((approval) => {
            if (approval.kind !== "userland") return false;
            // Userland approvals always have a panel/app/worker/do principal; the
            // "system" principal is only used for host-initiated prompts.
            if (approval.callerKind === "system") return false;
            if (approval.promptOptions !== "scoped") return false;
            if (!approval.options.some((option) => option.value === result.choice)) return false;
            const hit = deps.grantStore.lookup(
              {
                callerId: approval.callerId,
                callerKind: approval.callerKind,
                repoPath: approval.repoPath,
                effectiveVersion: approval.effectiveVersion,
              },
              approval.subject.id,
              approval.issuer
            );
            return (
              !!hit && isCachedChoiceValid(approval.promptOptions, approval.options, hit.choice)
            );
          }, result.choice);
        }
      } catch (err) {
        console.warn("[UserlandApprovalService] Failed to persist approval grant:", err);
      }
      return { kind: "choice", choice: resolved.choice };
    }
    return result;
  }

  return {
    name: SERVICE_NAME,
    description: "Userland-managed consent approvals",
    policy: { allowed: ["panel", "app", "worker", "do", "extension"] },
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
          return await deps.grantStore.revoke(principal, subjectId, extensionIssuer(ctx));
        }
        case "list": {
          const principal = await resolvePrincipal(ctx, "list");
          if (!principal) return [];
          return deps.grantStore.list(principal, extensionIssuer(ctx)) as UserlandApprovalGrant[];
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

function isCachedChoiceValid(
  promptOptions: UserlandApprovalRequest["promptOptions"] | undefined,
  options: UserlandApprovalOption[],
  choice: string
): boolean {
  if ((promptOptions ?? "scoped") === "scoped") return choice === "allow";
  return options.some((option) => option.value === choice);
}

function resolvePromptChoice(
  promptOptions: UserlandApprovalRequest["promptOptions"] | undefined,
  choice: string
):
  | { choice: string; record: false }
  | { choice: string; record: true; scope: UserlandApprovalGrantScope } {
  if ((promptOptions ?? "scoped") !== "scoped") {
    return { choice, record: true, scope: "caller" };
  }
  if (choice === "once") return { choice: "allow", record: false };
  if (choice === "session") return { choice: "allow", record: true, scope: "session" };
  if (choice === "version") return { choice: "allow", record: true, scope: "version" };
  return { choice: "deny", record: false };
}
