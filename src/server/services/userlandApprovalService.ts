import { z } from "zod";

import type {
  ApprovalPrincipal,
  SecretInputRequest,
  SecretInputResult,
  UserlandApprovalChoice,
  UserlandApprovalGrantScope,
  UserlandApprovalGrant,
  UserlandApprovalIssuer,
  UserlandApprovalOption,
  UserlandApprovalRequest,
} from "@natstack/shared/approvals";
import {
  approvalPrincipalSchema,
  secretInputRequestSchema,
  userlandApprovalRequestSchema,
  userlandApprovalSubjectIdSchema,
} from "@natstack/shared/approvals";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { UserlandApprovalGrantStore } from "./userlandApprovalGrantStore.js";

const SERVICE_NAME = "userlandApproval";
const BINARY_OPTIONS: UserlandApprovalOption[] = [
  { value: "allow", label: "Allow", tone: "primary" },
  { value: "deny", label: "Deny", tone: "danger" },
];

function scopedAllowOptions(principal: ApprovalPrincipal): UserlandApprovalOption[] {
  const identityScoped =
    principal.effectiveVersion === "internal" ||
    principal.repoPath === "natstack/internal" ||
    principal.requesterCategory === "eval" ||
    principal.requesterCategory === "internal-service" ||
    principal.requester?.category === "eval" ||
    principal.requester?.category === "internal-service";
  return [
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
      label: identityScoped ? "Trust identity" : "Trust version",
      description: identityScoped
        ? "Remember for this exact runtime identity."
        : "Remember for this exact code version.",
      tone: "primary",
    },
    { value: "deny", label: "Deny", description: "Do not allow this request.", tone: "danger" },
  ];
}

// Dangerous prompts (or those defaulting to deny) present Deny first so the
// safe choice leads; other prompts keep the allow-first ordering.
function scopedOptionsFor(
  principal: ApprovalPrincipal,
  req: UserlandApprovalRequest
): UserlandApprovalOption[] {
  const options = scopedAllowOptions(principal);
  if (req.severity === "dangerous" || req.defaultAction === "deny") {
    const deny = options.filter((option) => option.value === "deny");
    const rest = options.filter((option) => option.value !== "deny");
    return [...deny, ...rest];
  }
  return options;
}

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

  function decorateSecretInputForIssuer(
    req: SecretInputRequest,
    issuer: UserlandApprovalIssuer | undefined
  ): SecretInputRequest {
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
    return requestForPrincipal(ctx, principal, req);
  }

  async function requestAs(
    ctx: ServiceContext,
    rawPrincipal: ApprovalPrincipal,
    rawReq: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        SERVICE_NAME,
        "requestAs",
        "requestAs is only available to attributed extension callbacks",
        "EACCES"
      );
    }
    const principal = approvalPrincipalSchema.parse(rawPrincipal);
    const req = userlandApprovalRequestSchema.parse(rawReq);
    return requestForPrincipal(ctx, principal, req);
  }

  async function requestSecretInput(
    ctx: ServiceContext,
    rawReq: SecretInputRequest
  ): Promise<SecretInputResult> {
    const req = secretInputRequestSchema.parse(rawReq);
    const principal = await resolvePrincipal(ctx, "requestSecretInput");
    if (!principal) return { decision: "deny" };
    return requestSecretInputForPrincipal(ctx, principal, req);
  }

  async function requestSecretInputAs(
    ctx: ServiceContext,
    rawPrincipal: ApprovalPrincipal,
    rawReq: SecretInputRequest
  ): Promise<SecretInputResult> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        SERVICE_NAME,
        "requestSecretInputAs",
        "requestSecretInputAs is only available to attributed extension callbacks",
        "EACCES"
      );
    }
    const principal = approvalPrincipalSchema.parse(rawPrincipal);
    const req = secretInputRequestSchema.parse(rawReq);
    return requestSecretInputForPrincipal(ctx, principal, req);
  }

  async function requestSecretInputForPrincipal(
    ctx: ServiceContext,
    principal: ApprovalPrincipal,
    req: SecretInputRequest
  ): Promise<SecretInputResult> {
    const issuer = extensionIssuer(ctx);
    const decoratedReq = decorateSecretInputForIssuer(req, issuer);
    return deps.approvalQueue.requestSecretInput({
      kind: "secret-input",
      callerId: principal.callerId,
      callerKind: principal.callerKind,
      repoPath: principal.repoPath,
      effectiveVersion: principal.effectiveVersion,
      title: decoratedReq.title,
      description: decoratedReq.description,
      warning: decoratedReq.warning,
      details: decoratedReq.details,
      fields: decoratedReq.fields.map((field) => ({
        ...field,
        required: field.required ?? false,
      })),
      signal: undefined,
    });
  }

  async function requestForPrincipal(
    ctx: ServiceContext,
    principal: ApprovalPrincipal,
    req: UserlandApprovalRequest
  ): Promise<UserlandApprovalChoice> {
    const issuer = extensionIssuer(ctx);
    const decoratedReq = decorateForIssuer(req, issuer);
    const promptOptions = decoratedReq.promptOptions ?? "scoped";
    const options =
      promptOptions === "scoped"
        ? scopedOptionsFor(principal, decoratedReq)
        : (decoratedReq.options ?? BINARY_OPTIONS);
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
      requestSecretInput: { args: z.tuple([secretInputRequestSchema]) },
      requestAs: {
        args: z.tuple([approvalPrincipalSchema, userlandApprovalRequestSchema]),
        policy: { allowed: ["extension"] },
      },
      requestSecretInputAs: {
        args: z.tuple([approvalPrincipalSchema, secretInputRequestSchema]),
        policy: { allowed: ["extension"] },
      },
      revoke: { args: z.tuple([userlandApprovalSubjectIdSchema]) },
      list: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "request":
          return request(ctx, args[0] as UserlandApprovalRequest);
        case "requestSecretInput":
          return requestSecretInput(ctx, args[0] as SecretInputRequest);
        case "requestAs":
          return requestAs(ctx, args[0] as ApprovalPrincipal, args[1] as UserlandApprovalRequest);
        case "requestSecretInputAs":
          return requestSecretInputAs(
            ctx,
            args[0] as ApprovalPrincipal,
            args[1] as SecretInputRequest
          );
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
