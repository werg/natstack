import type { RpcClient } from "@natstack/rpc";
import type { ApprovalDecisionId } from "@natstack/shared/approvalContract";
import type { PendingApproval } from "@natstack/shared/approvals";
import { filterRuntimeApprovals } from "@natstack/shared/bootstrapApprovals";
import { shellApprovalMethods } from "@natstack/shared/serviceSchemas/shellApproval";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";

/**
 * Thin wrapper over the existing global shell-approval queue. The terminal
 * browser is just a new presentation of the same queue the Electron shell uses
 * (`ConsentApprovalBar`), so decisions made here are authoritative everywhere.
 */
export interface ApprovalsClient {
  list(): Promise<PendingApproval[]>;
  resolve(approvalId: string, decision: ApprovalDecisionId): Promise<void>;
  resolveUserland(approvalId: string, choice: string): Promise<void>;
  /** Subscribe to queue changes; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function createApprovalsClient(rpc: RpcClient): ApprovalsClient {
  const shellApproval = createTypedServiceClient(
    "shellApproval",
    shellApprovalMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  return {
    async list() {
      const pending = await shellApproval.listPending();
      return Array.isArray(pending) ? filterRuntimeApprovals(pending) : [];
    },
    async resolve(approvalId, decision) {
      await shellApproval.resolve(approvalId, decision);
    },
    async resolveUserland(approvalId, choice) {
      await shellApproval.resolveUserland(approvalId, choice);
    },
    onChange(listener) {
      return rpc.on("shell-approval:pending-changed", () => listener());
    },
  };
}
