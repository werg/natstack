import type { AccountIdentity, CredentialInjection, UrlAudience } from "./credentials/types.js";

export type ApprovalDecision = "session" | "version" | "repo" | "deny" | "dismiss";

export interface PendingApprovalBase {
  approvalId: string;
  callerId: string;
  callerKind: "panel" | "worker";
  repoPath: string;
  effectiveVersion: string;
  requestedAt: number;
}

export interface PendingCredentialApproval extends PendingApprovalBase {
  kind: "credential";
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
}

export interface PendingCapabilityApproval extends PendingApprovalBase {
  kind: "capability";
  capability: string;
  title: string;
  description?: string;
  resource?: {
    type: string;
    label: string;
    value: string;
  };
  details?: Array<{
    label: string;
    value: string;
  }>;
}

export type PendingApproval = PendingCredentialApproval | PendingCapabilityApproval;
