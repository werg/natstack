import type { AccountIdentity, CredentialInjection, UrlAudience } from "./credentials/types.js";

export type ApprovalDecision = "session" | "version" | "repo" | "deny" | "dismiss";

export interface PendingApproval {
  approvalId: string;
  callerId: string;
  callerKind: "panel" | "worker";
  repoPath: string;
  effectiveVersion: string;
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  requestedAt: number;
}
