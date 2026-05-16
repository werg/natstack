import type { RpcAccessPolicy, RpcCaller, RpcCallerContext } from "@natstack/rpc";
import type {
  UserlandApprovalOption,
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "@natstack/shared/approvals";

export type {
  UserlandApprovalChoice,
  UserlandApprovalGrant,
  UserlandApprovalOption,
  UserlandApprovalRequest,
  UserlandApprovalSubject,
} from "@natstack/shared/approvals";

/**
 * Request a user decision for a userland-defined subject.
 *
 * The host persists the user's choice keyed on `(callerId, subject.id)`.
 * Subsequent calls with the same `subject.id` return the prior choice without
 * prompting until you call `revokeUserlandApproval(subject.id)`.
 *
 * If a stored choice is no longer in the current `options[].value` set (e.g. you
 * changed your option list), the host revokes the stale grant and re-prompts.
 *
 * Concurrent calls from the same caller with the same `subject.id` collapse
 * onto the first prompt; the user's single choice is returned to all callers.
 * Keep your option set stable per subject — a second caller passing different
 * `options` for the same in-flight subject will receive a `choice` value taken
 * from the first caller's options.
 */
export function requestUserlandApproval(
  rpc: RpcCaller,
  req: UserlandApprovalRequest,
): Promise<UserlandApprovalChoice> {
  return rpc.call<UserlandApprovalChoice>("main", "userlandApproval.request", req);
}

/**
 * Forget the user's stored decision for `subjectId`. The next
 * `requestUserlandApproval` for that subject will prompt again. Idempotent.
 */
export function revokeUserlandApproval(rpc: RpcCaller, subjectId: string): Promise<boolean> {
  return rpc.call<boolean>("main", "userlandApproval.revoke", subjectId);
}

/**
 * List grants currently stored for the calling issuer. Other issuers' grants
 * are not visible.
 */
export function listUserlandApprovals(rpc: RpcCaller): Promise<UserlandApprovalGrant[]> {
  return rpc.call<UserlandApprovalGrant[]>("main", "userlandApproval.list");
}

type ApprovalCopyValue = string | ((ctx: RpcCallerContext) => string | undefined);
type ApprovalDetailsValue =
  | UserlandApprovalRequest["details"]
  | ((ctx: RpcCallerContext) => UserlandApprovalRequest["details"]);

export interface UserlandApprovalAccessPolicyOptions {
  /**
   * Stable action/resource key. The helper automatically appends the caller
   * source to this value, so grants are scoped to the exposing runtime and the
   * specific caller trying to invoke it.
   */
  subjectId: string;
  subjectLabel?: ApprovalCopyValue;
  title: ApprovalCopyValue;
  summary?: ApprovalCopyValue;
  warning?: ApprovalCopyValue;
  details?: ApprovalDetailsValue;
  allow?: Partial<Omit<UserlandApprovalOption, "value">>;
  deny?: Partial<Omit<UserlandApprovalOption, "value">>;
  includeSourceDetail?: boolean;
}

/**
 * Build an RPC access policy that asks the user before a caller can invoke an
 * exposed method. The persisted approval subject is automatically scoped by
 * `ctx.sourceId`, so one panel/worker/DO approval cannot authorize a different
 * source.
 */
export function createUserlandApprovalAccessPolicy(
  rpc: RpcCaller,
  options: UserlandApprovalAccessPolicyOptions,
): RpcAccessPolicy {
  return async (ctx) => {
    const result = await requestUserlandApproval(rpc, {
      subject: {
        id: sourceScopedSubjectId(options.subjectId, ctx.sourceId),
        ...renderOptionalSubjectLabel(options.subjectLabel, ctx),
      },
      title: renderRequiredCopy(options.title, ctx, "Allow RPC call?"),
      ...renderOptionalCopy("summary", options.summary, ctx),
      ...renderOptionalCopy("warning", options.warning, ctx),
      details: renderDetails(options, ctx),
      options: [
        {
          value: "allow",
          label: options.allow?.label ?? "Allow",
          ...(options.allow?.description ? { description: options.allow.description } : {}),
          tone: options.allow?.tone ?? "primary",
        },
        {
          value: "deny",
          label: options.deny?.label ?? "Deny",
          ...(options.deny?.description ? { description: options.deny.description } : {}),
          tone: options.deny?.tone ?? "danger",
        },
      ],
    });
    return result.kind === "choice" && result.choice === "allow";
  };
}

function renderRequiredCopy(
  value: ApprovalCopyValue,
  ctx: RpcCallerContext,
  fallback: string,
): string {
  return renderCopyValue(value, ctx) ?? fallback;
}

function renderOptionalCopy<K extends "summary" | "warning">(
  key: K,
  value: ApprovalCopyValue | undefined,
  ctx: RpcCallerContext,
): Partial<Pick<UserlandApprovalRequest, K>> {
  const rendered = renderCopyValue(value, ctx);
  return rendered === undefined ? {} : { [key]: rendered } as Partial<Pick<UserlandApprovalRequest, K>>;
}

function renderOptionalSubjectLabel(
  value: ApprovalCopyValue | undefined,
  ctx: RpcCallerContext,
): Partial<UserlandApprovalSubject> {
  const label = renderCopyValue(value, ctx);
  return label === undefined ? {} : { label };
}

function renderCopyValue(
  value: ApprovalCopyValue | undefined,
  ctx: RpcCallerContext,
): string | undefined {
  return typeof value === "function" ? value(ctx) : value;
}

function renderDetails(
  options: UserlandApprovalAccessPolicyOptions,
  ctx: RpcCallerContext,
): UserlandApprovalRequest["details"] {
  const configured = typeof options.details === "function" ? options.details(ctx) : options.details;
  const details = [...(configured ?? [])];
  if (options.includeSourceDetail !== false) {
    details.unshift({ label: "Caller", value: ctx.sourceId });
  }
  return details.slice(0, 8);
}

function sourceScopedSubjectId(subjectId: string, sourceId: string): string {
  const base = normalizeSubjectPart(subjectId) || "rpc-access";
  const source = normalizeSubjectPart(sourceId) || "unknown";
  const hash = fnv1a(sourceId).toString(36);
  const fixedLength = base.length + ":source::".length + hash.length;
  const sourceBudget = Math.max(8, 128 - fixedLength);
  return `${base}:source:${source.slice(0, sourceBudget)}:${hash}`.slice(0, 128);
}

function normalizeSubjectPart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._:/-]+/g, "_")
    .replace(/^[:/._-]+|[:/._-]+$/g, "")
    .slice(0, 80);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
