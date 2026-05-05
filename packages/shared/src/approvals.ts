import type {
  AccountIdentity,
  CredentialBindingUse,
  CredentialInjection,
  UrlAudience,
} from "./credentials/types.js";

export type ApprovalDecision = "once" | "session" | "version" | "repo" | "deny" | "dismiss";
export type ApprovalConfigFieldType = "text" | "secret";

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
  credentialUse?: CredentialBindingUse;
  gitOperation?: {
    action: "read" | "write";
    label: string;
    remote: string;
    service?: string;
  };
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthUserinfoOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  replacementCredentialLabel?: string;
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

export interface PendingOAuthClientConfigField {
  name: string;
  label: string;
  type: ApprovalConfigFieldType;
  required: boolean;
  description?: string;
}

export interface PendingOAuthClientConfigApproval extends PendingApprovalBase {
  kind: "oauth-client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingOAuthClientConfigField[];
}

export interface PendingCredentialInputApproval extends PendingApprovalBase {
  kind: "credential-input";
  title: string;
  description?: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  fields: PendingOAuthClientConfigField[];
}

export type PendingApproval =
  | PendingCredentialApproval
  | PendingCapabilityApproval
  | PendingOAuthClientConfigApproval
  | PendingCredentialInputApproval;
