/**
 * Userland approvals client — the portable `approvals` namespace derived once in
 * `createHostedRuntime`. Wraps the free-function approval helpers so every
 * target (panel · worker · eval) gets the identical `{ request, revoke, list }`
 * surface instead of re-binding the functions per barrel.
 */

import type { RpcCaller } from "@natstack/rpc";
import {
  listUserlandApprovals,
  requestUserlandApproval,
  revokeUserlandApproval,
  type UserlandApprovalChoice,
  type UserlandApprovalGrant,
  type UserlandApprovalRequest,
} from "../approvals.js";

export interface ApprovalsApi {
  request(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
  revoke(subjectId: string): Promise<boolean>;
  list(): Promise<UserlandApprovalGrant[]>;
}

export function createApprovalsApi(rpc: RpcCaller): ApprovalsApi {
  return {
    request: (req) => requestUserlandApproval(rpc, req),
    revoke: (subjectId) => revokeUserlandApproval(rpc, subjectId),
    list: () => listUserlandApprovals(rpc),
  };
}
