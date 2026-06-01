import type { RpcCaller } from "@natstack/rpc";
import type { UserlandApprovalChoice, UserlandApprovalGrant, UserlandApprovalRequest, } from "@natstack/shared/approvals";
export type { UserlandApprovalChoice, UserlandApprovalGrant, UserlandApprovalOption, UserlandApprovalRequest, UserlandApprovalSubject, } from "@natstack/shared/approvals";
/**
 * Consumer contract: use this only for custom userland services that expose a
 * shared resource to other userland callers and need a user decision that
 * NatStack cannot represent with a built-in permission.
 *
 * Do not call this before ordinary actions the caller can already perform:
 * context filesystem work, eval work, panel operations, browser automation,
 * git/runtime APIs, external opens, and credential use are protected by the
 * outer host/runtime permission model where needed.
 *
 * Do not cache the result. The host owns persistence, deduplication, scope,
 * and revocation. If you think you need a local allowlist, you are about to
 * introduce a bug.
 *
 * By default the host presents scoped allow choices: allow once, allow for this
 * caller session, trust this code version, or deny. Positive scoped choices
 * return `choice: "allow"`; deny returns `choice: "deny"`.
 *
 * Pass `promptOptions: "choices"` for a simple allow/deny prompt or to show
 * your own option list. In that mode the host persists the selected option
 * keyed on `(callerId, subject.id)`.
 * Subsequent calls with the same `subject.id` return the prior choice without
 * prompting until you call `revokeUserlandApproval(subject.id)`.
 *
 * If a stored custom choice is no longer in the current `options[].value` set
 * (e.g. you changed your option list), the host revokes the stale grant and
 * re-prompts.
 *
 * Concurrent calls from the same caller with the same `subject.id` collapse
 * onto the first prompt; the user's single choice is returned to all callers.
 * Keep your option set stable per subject — a second caller passing different
 * `options` for the same in-flight subject will receive a `choice` value taken
 * from the first caller's options.
 */
export function requestUserlandApproval(rpc: RpcCaller, req: UserlandApprovalRequest): Promise<UserlandApprovalChoice> {
    return rpc.call<UserlandApprovalChoice>("main", "userlandApproval.request", [req]);
}
/**
 * Forget the user's stored decision for `subjectId`. The next
 * `requestUserlandApproval` for that subject will prompt again. Idempotent.
 */
export function revokeUserlandApproval(rpc: RpcCaller, subjectId: string): Promise<boolean> {
    return rpc.call<boolean>("main", "userlandApproval.revoke", [subjectId]);
}
/**
 * List grants currently stored for the calling issuer. Other issuers' grants
 * are not visible.
 */
export function listUserlandApprovals(rpc: RpcCaller): Promise<UserlandApprovalGrant[]> {
    return rpc.call<UserlandApprovalGrant[]>("main", "userlandApproval.list", []);
}
