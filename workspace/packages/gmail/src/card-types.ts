/**
 * Shared Gmail card payload contracts.
 *
 * TS interfaces are imported by both the gmail-agent worker (emission) and
 * the skill renderers (consumption). The matching JSON Schema documents are
 * registered with the channel message types so the platform validates card
 * states at emission and fold time. Schemas are deliberately permissive
 * (`additionalProperties: true`, nothing hard-required beyond identity) so
 * renderers tolerate extra fields while still catching shape mistakes.
 */

import type { GmailThreadState } from "./renderers/gmail-thread.reducer.js";

// ── Attention rule model (embedded in the inbox card) ──────────────────────

export type GmailAttentionAction =
  | "surface"
  | "summarize"
  | "draft"
  | "archive"
  | "markRead";

export type GmailAttentionScope = "metadata" | "snippet" | "full-thread-on-wake";

export type GmailAttentionField =
  | "from"
  | "fromDomain"
  | "to"
  | "subject"
  | "snippet"
  | "label"
  | "category"
  | "hasAttachment"
  | "priorReplyToSender"
  | "wakeAll";

export type GmailAttentionOperator = "contains" | "equals" | "matches" | "present";

export interface GmailAttentionCondition {
  field: GmailAttentionField;
  op?: GmailAttentionOperator;
  value?: string;
}

export interface GmailAttentionMatcher {
  any?: GmailAttentionCondition[];
  all?: GmailAttentionCondition[];
  not?: GmailAttentionCondition[];
}

export interface GmailAttentionDirective {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope: GmailAttentionScope;
  priority: number;
  match: GmailAttentionMatcher;
  actions: GmailAttentionAction[];
}

export interface GmailAttentionRuleSet {
  version: 1;
  directives: GmailAttentionDirective[];
}

export interface GmailAttentionDecision {
  wake: boolean;
  directiveId?: string;
  directiveName?: string;
  reason?: string;
  actions?: GmailAttentionAction[];
}

export interface GmailAttentionHit {
  threadId: string;
  directiveId: string;
  directiveName: string;
  reason: string;
  actions: GmailAttentionAction[];
  matchedAt: number;
}

// ── Card states ─────────────────────────────────────────────────────────────

export interface GmailThreadCardState extends GmailThreadState {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  unread: boolean;
  inInbox: boolean;
  category?: string;
  actionable: boolean;
  attention?: GmailAttentionDecision;
  updatedAt: number;
}

export type GmailComposeStatus =
  | "drafting"
  | "review"
  | "sending"
  | "sent"
  | "saved"
  | "error"
  | "discarded";

export interface GmailComposeCardState {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  draftId?: string;
  threadId?: string;
  sourceThreadId?: string;
  status: GmailComposeStatus;
  error?: string;
}

export interface GmailInboxAuthState {
  status: "reconnect-required";
}

export interface GmailSetupAuthState {
  status: "ok" | "reconnect-required" | "unknown";
}

export interface GmailSetupRuleSummary {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
}

export interface GmailSetupState {
  status: "onboarding" | "configured";
  auth: GmailSetupAuthState;
  email?: string;
  setupSummary?: string;
  attentionRules: GmailSetupRuleSummary[];
  pollIntervalMs: number;
  lastSyncAt?: string;
  lastError?: string;
}

export interface GmailInboxCardState {
  email?: string;
  unread: number;
  inbox: number;
  urgent: number;
  draftCount: number;
  perCategory?: Record<string, number>;
  actionable: GmailThreadCardState[];
  attentionRules?: GmailAttentionRuleSet;
  attentionHits?: GmailAttentionHit[];
  searchQuery?: string;
  searchResults?: GmailThreadCardState[];
  lastSyncedAt?: string;
  lastError?: string;
  /** Present when the Google credential needs reconnecting. */
  auth?: GmailInboxAuthState;
  /** Epoch ms until which Gmail polling is rate-limit backed off. */
  rateLimitedUntil?: number;
  /** Attention hits queued past the wake rate cap, awaiting the next digest. */
  needsAttentionCount?: number;
}

// ── JSON Schemas (registered with the channel message types) ───────────────

const ATTENTION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    wake: { type: "boolean" },
    directiveId: { type: "string" },
    directiveName: { type: "string" },
    reason: { type: "string" },
    actions: { type: "array", items: { type: "string" } },
  },
} as const;

const THREAD_CARD_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    threadId: { type: "string" },
    subject: { type: "string" },
    from: { type: "string" },
    snippet: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    lastSnippet: { type: "string" },
    unreadCount: { type: "number" },
    hasDraft: { type: "boolean" },
    status: { enum: ["unread", "open", "archived"] },
    unread: { type: "boolean" },
    inInbox: { type: "boolean" },
    category: { type: "string" },
    actionable: { type: "boolean" },
    attention: ATTENTION_DECISION_SCHEMA,
    updatedAt: { type: "number" },
  },
  required: ["threadId"],
} as const;

export const GMAIL_THREAD_STATE_SCHEMA: Record<string, unknown> = THREAD_CARD_SCHEMA;

/** Thread updates are reducer patches (kind-tagged) or partial states. */
export const GMAIL_THREAD_UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string" },
  },
};

export const GMAIL_INBOX_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    email: { type: "string" },
    unread: { type: "number" },
    inbox: { type: "number" },
    urgent: { type: "number" },
    draftCount: { type: "number" },
    perCategory: { type: "object", additionalProperties: { type: "number" } },
    actionable: { type: "array", items: THREAD_CARD_SCHEMA },
    attentionRules: { type: "object", additionalProperties: true },
    attentionHits: { type: "array", items: { type: "object", additionalProperties: true } },
    searchQuery: { type: "string" },
    searchResults: { type: "array", items: THREAD_CARD_SCHEMA },
    lastSyncedAt: { type: "string" },
    lastError: { type: "string" },
    auth: {
      type: "object",
      additionalProperties: true,
      properties: { status: { enum: ["reconnect-required"] } },
      required: ["status"],
    },
    rateLimitedUntil: { type: "number" },
    needsAttentionCount: { type: "number" },
  },
  required: ["unread", "inbox", "actionable"],
};

export const GMAIL_SETUP_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["onboarding", "configured"] },
    auth: {
      type: "object",
      additionalProperties: true,
      properties: { status: { enum: ["ok", "reconnect-required", "unknown"] } },
      required: ["status"],
    },
    email: { type: "string" },
    setupSummary: { type: "string" },
    attentionRules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          enabled: { type: "boolean" },
          priority: { type: "number" },
        },
        required: ["id"],
      },
    },
    pollIntervalMs: { type: "number" },
    lastSyncAt: { type: "string" },
    lastError: { type: "string" },
  },
  required: ["status", "auth", "attentionRules", "pollIntervalMs"],
};

export const GMAIL_COMPOSE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    draftId: { type: "string" },
    threadId: { type: "string" },
    sourceThreadId: { type: "string" },
    status: { enum: ["drafting", "review", "sending", "sent", "saved", "error", "discarded"] },
    error: { type: "string" },
  },
  required: ["status"],
};

/** Compose updates are merge patches over the compose state. */
export const GMAIL_COMPOSE_UPDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { enum: ["drafting", "review", "sending", "sent", "saved", "error", "discarded"] },
    error: { type: "string" },
    draftId: { type: "string" },
    body: { type: "string" },
  },
};
