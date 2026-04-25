import type { AccountIdentity } from "./credentials/types.js";
import type { ProviderBindingInjection } from "./credentials/providerBinding.js";

export type ApprovalDecision = "session" | "version" | "repo" | "deny" | "dismiss";

export interface PendingApproval {
  approvalId: string;
  callerId: string;
  callerKind: "panel" | "worker";
  repoPath: string;
  effectiveVersion: string;
  providerNamespace: string;
  providerDisplayName: string;
  providerAudience: string[];
  providerFingerprint: string;
  injection: ProviderBindingInjection;
  connectionId: string;
  accountIdentity: AccountIdentity;
  scopes: string[];
  requestedAt: number;
}
