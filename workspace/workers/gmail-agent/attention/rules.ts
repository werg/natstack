import type {
  GmailAttentionAction,
  GmailAttentionCondition,
  GmailAttentionDecision,
  GmailAttentionDirective,
  GmailAttentionField,
  GmailAttentionMatcher,
  GmailAttentionOperator,
  GmailAttentionRuleSet,
  GmailAttentionScope,
} from "@workspace/gmail/card-types";
import { record } from "../types.js";

export const GMAIL_ATTENTION_FIELDS = [
  "from",
  "fromDomain",
  "to",
  "subject",
  "snippet",
  "label",
  "category",
  "hasAttachment",
  "priorReplyToSender",
  "wakeAll",
] as const satisfies readonly GmailAttentionField[];

export const GMAIL_ATTENTION_OPERATORS = [
  "contains",
  "equals",
  "matches",
  "present",
] as const satisfies readonly GmailAttentionOperator[];

export const GMAIL_ATTENTION_ACTIONS = [
  "surface",
  "summarize",
  "draft",
  "archive",
  "markRead",
] as const satisfies readonly GmailAttentionAction[];

export const GMAIL_ATTENTION_SCOPES = [
  "metadata",
  "snippet",
  "full-thread-on-wake",
] as const satisfies readonly GmailAttentionScope[];

/** The static/cheap signal snapshot a rule set is evaluated against. */
export interface GmailAttentionEvent {
  threadId: string;
  messageId?: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  labels: string[];
  category?: string;
  hasAttachment: boolean;
  priorReplyToSender?: boolean;
  unread: boolean;
  inInbox: boolean;
  addressedToUser: boolean;
  internalDate?: number;
}

export function slug(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || "directive";
}

function normalizeText(value: string): string {
  return value.toLowerCase();
}

export function fromDomain(from: string): string {
  const email = /<([^>]+)>/.exec(from)?.[1] ?? from;
  const domain = /@([^>\s,]+)/.exec(email)?.[1] ?? "";
  return domain.toLowerCase();
}

export function defaultAttentionRules(): GmailAttentionRuleSet {
  return {
    version: 1,
    directives: [
      {
        id: "prior-replies",
        name: "People you have replied to",
        description:
          "Wake only for unread inbox mail from senders you have replied to before.",
        enabled: true,
        scope: "metadata",
        priority: 100,
        match: {
          all: [
            { field: "priorReplyToSender", op: "present" },
            { field: "label", op: "contains", value: "INBOX" },
            { field: "label", op: "contains", value: "UNREAD" },
          ],
        },
        actions: ["surface", "summarize"],
      },
    ],
  };
}

export function validateAttentionRules(value: unknown): GmailAttentionRuleSet {
  const root = record(value);
  if (root["version"] !== 1) throw new Error("attention rules version must be 1");
  const rawDirectives = root["directives"];
  if (!Array.isArray(rawDirectives)) throw new Error("attention rules directives must be an array");
  if (rawDirectives.length > 50) throw new Error("attention rules can contain at most 50 directives");
  const ids = new Set<string>();
  const directives = rawDirectives.map((item, index): GmailAttentionDirective => {
    const directive = record(item);
    const id = typeof directive["id"] === "string" ? slug(directive["id"]) : `directive-${index + 1}`;
    if (ids.has(id)) throw new Error(`duplicate attention directive id: ${id}`);
    ids.add(id);
    const name =
      typeof directive["name"] === "string" && directive["name"].trim()
        ? directive["name"].trim().slice(0, 120)
        : id;
    const scope =
      directive["scope"] === "full-thread-on-wake" || directive["scope"] === "metadata"
        ? directive["scope"]
        : "snippet";
    const actions: GmailAttentionAction[] = Array.isArray(directive["actions"])
      ? directive["actions"].filter((action): action is GmailAttentionAction =>
          (GMAIL_ATTENTION_ACTIONS as readonly string[]).includes(String(action))
        )
      : ["surface"];
    const match = validateMatcher(directive["match"]);
    return {
      id,
      name,
      ...(typeof directive["description"] === "string"
        ? { description: directive["description"].slice(0, 500) }
        : {}),
      enabled: directive["enabled"] !== false,
      scope,
      priority: Math.max(0, Math.min(Number(directive["priority"] ?? 50) || 50, 1000)),
      match,
      actions: actions.length > 0 ? actions : (["surface"] satisfies GmailAttentionAction[]),
    };
  });
  return { version: 1, directives };
}

function validateMatcher(value: unknown): GmailAttentionMatcher {
  const matcher = record(value);
  const next: GmailAttentionMatcher = {};
  for (const key of ["any", "all", "not"] as const) {
    const raw = matcher[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new Error(`attention matcher ${key} must be an array`);
    next[key] = raw.map(validateCondition);
    if (next[key]!.length > 25) throw new Error(`attention matcher ${key} has too many conditions`);
  }
  if (!next.any && !next.all) throw new Error("attention matcher requires any or all conditions");
  return next;
}

function validateCondition(value: unknown): GmailAttentionCondition {
  const condition = record(value);
  const field = condition["field"];
  if (![...(GMAIL_ATTENTION_FIELDS as readonly string[])].includes(String(field))) {
    throw new Error(`unsupported attention condition field: ${String(field)}`);
  }
  const op = condition["op"];
  if (op !== undefined && !(GMAIL_ATTENTION_OPERATORS as readonly string[]).includes(String(op))) {
    throw new Error(`unsupported attention condition op: ${String(op)}`);
  }
  const valueText = typeof condition["value"] === "string" ? condition["value"].slice(0, 500) : undefined;
  if (
    field !== "hasAttachment" &&
    field !== "priorReplyToSender" &&
    field !== "wakeAll" &&
    !valueText
  ) {
    throw new Error(`attention condition ${String(field)} requires value`);
  }
  if (op === "matches" && valueText) new RegExp(valueText);
  return {
    field: field as GmailAttentionCondition["field"],
    ...(op ? { op: op as GmailAttentionCondition["op"] } : {}),
    ...(valueText ? { value: valueText } : {}),
  };
}

export function conditionMatches(
  condition: GmailAttentionCondition,
  event: GmailAttentionEvent
): boolean {
  if (condition.field === "wakeAll") return true;
  if (condition.field === "hasAttachment") return event.hasAttachment;
  if (condition.field === "priorReplyToSender") return event.priorReplyToSender === true;
  const haystack =
    condition.field === "fromDomain"
      ? fromDomain(event.from)
      : condition.field === "from"
        ? event.from
        : condition.field === "to"
          ? event.to
          : condition.field === "subject"
            ? event.subject
            : condition.field === "snippet"
              ? event.snippet
              : condition.field === "label"
                ? event.labels.join(" ")
                : event.category ?? "";
  const needle = condition.value ?? "";
  const op = condition.op ?? (condition.field === "fromDomain" ? "equals" : "contains");
  if (op === "present") return Boolean(haystack);
  if (op === "equals") return normalizeText(haystack) === normalizeText(needle);
  if (op === "matches") return new RegExp(needle, "i").test(haystack);
  return normalizeText(haystack).includes(normalizeText(needle));
}

export function directiveDecision(
  directive: GmailAttentionDirective,
  event: GmailAttentionEvent
): GmailAttentionDecision | null {
  if (!directive.enabled) return null;
  if (directive.match.not?.some((condition) => conditionMatches(condition, event))) return null;
  const anyOk = directive.match.any
    ? directive.match.any.some((condition) => conditionMatches(condition, event))
    : true;
  const allOk = directive.match.all
    ? directive.match.all.every((condition) => conditionMatches(condition, event))
    : true;
  if (!anyOk || !allOk) return null;
  return {
    wake: true,
    directiveId: directive.id,
    directiveName: directive.name,
    reason: directive.description ?? directive.name,
    actions: directive.actions,
  };
}

export function evaluateAttentionRules(
  ruleSet: GmailAttentionRuleSet,
  event: GmailAttentionEvent
): GmailAttentionDecision {
  const matches = ruleSet.directives
    .map((directive) => directiveDecision(directive, event))
    .filter((decision): decision is GmailAttentionDecision => Boolean(decision))
    .sort((a, b) => {
      const aDirective = ruleSet.directives.find((directive) => directive.id === a.directiveId);
      const bDirective = ruleSet.directives.find((directive) => directive.id === b.directiveId);
      return (bDirective?.priority ?? 0) - (aDirective?.priority ?? 0);
    });
  return matches[0] ?? { wake: false };
}

export function parseActionsJson(value: unknown): GmailAttentionAction[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is GmailAttentionAction =>
          (GMAIL_ATTENTION_ACTIONS as readonly string[]).includes(String(item))
        )
      : ["surface"];
  } catch {
    return ["surface"];
  }
}
