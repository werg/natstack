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
  "session",
  "deny",
  "open",
  "version",
  "repo",
] as const;
export const NOTIFICATION_ACTION_IDS_INPUT_REQUIRED = ["open"] as const;

export const APPROVAL_CATEGORY_DECIDE = "natstack-approval-decide";
export const APPROVAL_CATEGORY_INPUT_REQUIRED = "natstack-approval-input-required";

export type PushApprovalDataPayload = {
  kind: "approval-prompt" | "approval-cancel";
  approvalId: string;
  approvalKind?: "credential" | "capability" | "client-config" | "credential-input" | "userland";
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
    submitClientConfig: "shellApproval.submitClientConfig",
    submitCredentialInput: "shellApproval.submitCredentialInput",
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
