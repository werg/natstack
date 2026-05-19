import { z } from "zod";
import type {
  AccountIdentity,
  CredentialBindingUse,
  CredentialInjection,
  UrlAudience,
} from "./credentials/types.js";
import type { ApprovalDecisionId } from "./approvalContract.js";

export type ApprovalDecision = ApprovalDecisionId;
export type ApprovalConfigFieldType = "text" | "secret";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const ZERO_WIDTH_CHARS = /[\u200B-\u200F]/g;
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const OPTION_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;
export const USERLAND_APPROVAL_RESERVED_SUBJECT_PREFIXES = ["shell:", "server:", "system:", "@"] as const;

export function approvalCleanString(
  label: string,
  opts: { min?: number; max: number; pattern?: RegExp },
): z.ZodType<string> {
  let schema: z.ZodType<string> = z.string()
    .refine((value) => !CONTROL_CHARS.test(value), { message: `${label} contains control characters` })
    .transform((value) => value.replace(ZERO_WIDTH_CHARS, ""));
  if (opts.min !== undefined) {
    schema = schema.refine((value) => value.length >= opts.min!, { message: `${label} is too short` });
  }
  schema = schema.refine((value) => value.length <= opts.max, { message: `${label} is too long` });
  if (opts.pattern) {
    schema = schema.refine((value) => opts.pattern!.test(value), { message: `${label} has invalid characters` });
  }
  return schema;
}

export const userlandApprovalSubjectIdSchema = approvalCleanString(
  "subject id",
  { min: 1, max: 128, pattern: SUBJECT_ID_PATTERN },
).refine(
  (id) => !USERLAND_APPROVAL_RESERVED_SUBJECT_PREFIXES.some((prefix) => id.startsWith(prefix)),
  { message: "subject id uses a reserved prefix" },
);

export const userlandApprovalDetailSchema = z.object({
  label: approvalCleanString("detail label", { max: 40 }),
  value: approvalCleanString("detail value", { max: 200 }),
}).strict();

export const userlandApprovalOptionSchema = z.object({
  value: approvalCleanString("option value", { min: 1, max: 40, pattern: OPTION_VALUE_PATTERN })
    .refine((value) => value !== "dismiss", { message: "option value is reserved" }),
  label: approvalCleanString("option label", { min: 1, max: 40 }),
  description: approvalCleanString("option description", { max: 120 }).optional(),
  tone: z.enum(["primary", "danger", "neutral"]).optional(),
}).strict();

export const userlandApprovalRequestSchema = z.object({
  subject: z.object({
    id: userlandApprovalSubjectIdSchema,
    label: approvalCleanString("subject label", { max: 80 }).optional(),
  }).strict(),
  title: approvalCleanString("title", { min: 1, max: 120 }),
  summary: approvalCleanString("summary", { max: 1000 }).optional(),
  warning: approvalCleanString("warning", { max: 200 }).optional(),
  details: z.array(userlandApprovalDetailSchema).max(8).optional(),
  options: z.array(userlandApprovalOptionSchema).min(1).max(6),
}).strict().superRefine((req, ctx) => {
  const values = new Set<string>();
  for (const [index, option] of req.options.entries()) {
    if (values.has(option.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", index, "value"],
        message: "option values must be unique",
      });
    }
    values.add(option.value);
  }
});

/** The verified runtime caller that issued the prompt. Populated by the dispatcher. */
export interface ApprovalPrincipal {
  callerId: string;
  callerKind: "panel" | "worker" | "do";
  repoPath: string;
  effectiveVersion: string;
}

/** What a userland approval is about. The issuing provider supplies this. */
export interface UserlandApprovalSubject {
  id: string;
  label?: string;
}

/**
 * Who is asking the user. For direct panel/worker calls this equals the
 * principal; for extension-issued approvals (via `ctx.approvals.requestForCaller`),
 * this identifies the extension acting on behalf of the principal.
 */
export interface UserlandApprovalIssuer {
  kind: "panel" | "worker" | "do" | "extension";
  id: string;
  label?: string;
}

/** A persisted decision for one flat (principal, subject) pair. */
export interface UserlandApprovalGrant {
  principal: { callerId: string; callerKind: "panel" | "worker" | "do" };
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  choice: string;
  grantedAt: number;
}

export interface PendingApprovalBase {
  // principal == { callerId, callerKind, repoPath, effectiveVersion }
  approvalId: string;
  callerId: string;
  callerKind: "panel" | "worker" | "do";
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

export type PendingExtensionApprovalAction =
  | "install"
  | "update"
  | "source-push"
  | "uninstall"
  | "toggle"
  | "reload";

export interface ExtensionApprovalDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ExtensionApprovalGitIdentity {
  name: string;
  email: string;
}

export interface ExtensionApprovalCommit {
  author: ExtensionApprovalGitIdentity;
  committer: ExtensionApprovalGitIdentity;
  message: string;
  timestamp: number;
}

export interface ExtensionApprovalPush {
  pushedAt: number;
  pushedBy?: string | null;
  ref: string;
}

export interface ExtensionApprovalDiff {
  sha?: string | null;
  previousSha?: string | null;
  stat?: ExtensionApprovalDiffStat | null;
  commit?: ExtensionApprovalCommit | null;
  push?: ExtensionApprovalPush | null;
}

export interface ExtensionWorkspaceDependencyChange {
  name: string;
  fromEv?: string | null;
  toEv?: string | null;
  sha?: string | null;
  previousSha?: string | null;
  stat?: ExtensionApprovalDiffStat | null;
  commit?: ExtensionApprovalCommit | null;
  push?: ExtensionApprovalPush | null;
}

export interface ExtensionExternalDependencyChange {
  name: string;
  fromVersion?: string | null;
  toVersion?: string | null;
}

export interface PendingExtensionApproval extends PendingApprovalBase {
  kind: "extension";
  action: PendingExtensionApprovalAction;
  extensionName: string;
  version?: string | null;
  source: { kind: "internal-git"; repo: string; ref: string };
  title: string;
  description: string;
  ev?: string | null;
  previousEv?: string | null;
  sha?: string | null;
  previousSha?: string | null;
  activeDependencyEvs?: Record<string, string>;
  candidateDependencyEvs?: Record<string, string>;
  activeRuntimeDepsKey?: string | null;
  candidateRuntimeDepsKey?: string | null;
  extensionDiff?: ExtensionApprovalDiff | null;
  workspaceDepChanges?: ExtensionWorkspaceDependencyChange[];
  externalDepChanges?: ExtensionExternalDependencyChange[];
  integrity?: string | null;
  capabilities: string[];
  details?: Array<{
    label: string;
    value: string;
  }>;
}

export interface PendingClientConfigField {
  name: string;
  label: string;
  type: ApprovalConfigFieldType;
  required: boolean;
  description?: string;
}

export interface PendingClientConfigApproval extends PendingApprovalBase {
  kind: "client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingClientConfigField[];
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
  fields: PendingClientConfigField[];
}

export interface UserlandApprovalOption {
  value: string;
  label: string;
  description?: string;
  tone?: "primary" | "danger" | "neutral";
}

export interface PendingUserlandApproval extends PendingApprovalBase {
  kind: "userland";
  /** Issuer of the request — the panel/worker/extension that asked. */
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  options: UserlandApprovalOption[];
}

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) flow status.
 *
 * Surfaced on the trusted approval bar so the user can read the `userCode`
 * to type into the provider's verification page (when the provider doesn't
 * embed it in `verification_uri_complete`), and so the polling loop is
 * cancellable. The server auto-resolves this approval when polling
 * completes — granted, denied, or expired — without user interaction.
 */
export interface PendingDeviceCodeApproval extends PendingApprovalBase {
  kind: "device-code";
  credentialLabel: string;
  /** The short code the user types into the provider's page. */
  userCode: string;
  /** The page the user opens to enter the code. */
  verificationUri: string;
  /**
   * Some providers (Google, GitHub, others) return a URL with the code
   * pre-filled. When present, the natstack shell auto-opens this URL; the
   * user code is still displayed in case the user prefers to type it.
   */
  verificationUriComplete?: string;
  /** Wall-clock ms when the device authorization expires. */
  expiresAt: number;
  /** Origin of the OAuth provider's token endpoint (for display). */
  oauthTokenOrigin: string;
}

export interface UserlandApprovalRequest {
  /** Optional issuer override. Direct panel/worker callers can omit (issuer = principal). */
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{
    label: string;
    value: string;
  }>;
  options: UserlandApprovalOption[];
}

export type UserlandApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" };

export type PendingApproval =
  | PendingCredentialApproval
  | PendingCapabilityApproval
  | PendingExtensionApproval
  | PendingClientConfigApproval
  | PendingCredentialInputApproval
  | PendingUserlandApproval
  | PendingDeviceCodeApproval;
