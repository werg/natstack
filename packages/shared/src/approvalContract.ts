export const APPROVAL_DECISIONS = [
  "once",
  "session",
  "version",
  "repo",
  "deny",
  "dismiss",
] as const;
export type ApprovalDecisionId = (typeof APPROVAL_DECISIONS)[number];

// Notification action ids (subset of decisions + "open"). Order matters for iOS:
// the system prioritizes earlier actions in constrained notification layouts.
export const NOTIFICATION_ACTION_IDS_STANDARD = [
  "once",
  "version",
  "deny",
  "open",
  "session",
] as const;
export const NOTIFICATION_ACTION_IDS_INPUT_REQUIRED = ["open"] as const;

export const APPROVAL_CATEGORY_DECIDE = "natstack-approval-decide";
export const APPROVAL_CATEGORY_INPUT_REQUIRED = "natstack-approval-input-required";

export type PushApprovalDataPayload = {
  kind: "approval-prompt" | "approval-cancel";
  approvalId: string;
  approvalKind?:
    | "credential"
    | "capability"
    | "unit-batch"
    | "client-config"
    | "credential-input"
    | "secret-input"
    | "userland"
    | "device-code";
  title?: string;
  body?: string;
  category?: string;
  cancelKey?: string;
  // FCM data values must be strings; JSON-encode complex values.
  actionsJson?: string;
};

export const RPC_METHODS = {
  shellApproval: {
    resolve: "shellApproval.resolve",
    resolveBootstrap: "shellApproval.resolveBootstrap",
    submitClientConfig: "shellApproval.submitClientConfig",
    submitCredentialInput: "shellApproval.submitCredentialInput",
    submitSecretInput: "shellApproval.submitSecretInput",
    resolveUserland: "shellApproval.resolveUserland",
    listPending: "shellApproval.listPending",
  },
  push: {
    register: "push.register",
    unregister: "push.unregister",
  },
  shellPresence: {
    heartbeat: "shellPresence.heartbeat",
  },
} as const;
