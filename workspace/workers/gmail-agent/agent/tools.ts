import type { GmailHandlers } from "./handlers.js";
import { numberArg, record } from "../types.js";

export const EMPTY_TOOL_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const SEARCH_TOOL_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", minLength: 1 },
    limit: { type: "number", minimum: 1, maximum: 25 },
  },
  required: ["q"],
  additionalProperties: false,
} as const;

export const THREAD_ID_TOOL_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string", minLength: 1 },
  },
  required: ["threadId"],
  additionalProperties: false,
} as const;

export const SEND_TOOL_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    cc: { type: "string" },
    bcc: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    threadId: { type: "string" },
    messageId: { type: "string" },
    sourceThreadId: { type: "string" },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

export const CATEGORIZE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    threadId: { type: "string", minLength: 1 },
    category: { type: "string", minLength: 1 },
  },
  required: ["threadId", "category"],
  additionalProperties: false,
} as const;

export const POLL_INTERVAL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    pollIntervalMs: { type: "number", minimum: 30_000 },
  },
  required: ["pollIntervalMs"],
  additionalProperties: false,
} as const;

export const LIST_THREADS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 25 },
  },
  additionalProperties: false,
} as const;

export const MARK_CONFIGURED_TOOL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
  },
  additionalProperties: false,
} as const;

export interface GmailToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (handlers: GmailHandlers, channelId: string, args: Record<string, unknown>) => unknown;
}

/**
 * Declarative runner tool table. Each entry references the single handler
 * implementation also used by onMethodCall dispatch.
 */
export const GMAIL_TOOLS: GmailToolSpec[] = [
  {
    name: "gmail_checkInbox",
    description: "Synchronize Gmail now and refresh Gmail cards.",
    schema: EMPTY_TOOL_SCHEMA,
    run: (handlers, channelId) => handlers.checkInbox(channelId),
  },
  {
    name: "gmail_markConfigured",
    description:
      "Mark first-run Gmail setup complete after the requested attention behavior has been implemented or confirmed. Parameters: { summary?: string }.",
    schema: MARK_CONFIGURED_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.markConfigured(channelId, args),
  },
  {
    name: "gmail_search",
    description:
      'Search Gmail with a Gmail query (e.g. "in:inbox newer_than:1d", "from:alice@example.com"). ' +
      "Returns { query, count, results: [{ threadId, subject, from, snippet, unread, date }] } — act on the " +
      "returned results directly; they are also mirrored into the inbox card's search section. " +
      "Parameters: { q: string, limit?: number (max 25) }.",
    schema: SEARCH_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.search(channelId, args),
  },
  {
    name: "gmail_summarizeThread",
    description: "Fetch sanitized thread contents for summarization. Parameters: { threadId: string }.",
    schema: THREAD_ID_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.getThread(channelId, args),
  },
  {
    name: "gmail_draftReply",
    description:
      "Create a reply compose card in review state. The card never sends by itself; the user's Send button is the authorization to send. Parameters: { threadId: string }.",
    schema: THREAD_ID_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.draftReply(channelId, args),
  },
  {
    name: "gmail_send",
    description:
      "Send a Gmail message immediately. Use ONLY when the user explicitly asked to send without review; otherwise use gmail_draftReply so the user can review and click Send on the compose card. Parameters: { to: string, cc?: string, bcc?: string, subject: string, body: string, threadId?: string, messageId?: string }.",
    schema: SEND_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.send(channelId, args),
  },
  {
    name: "gmail_saveDraft",
    description:
      "Save a Gmail draft. Parameters: { to: string, cc?: string, bcc?: string, subject: string, body: string, threadId?: string, messageId?: string }.",
    schema: SEND_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.saveDraft(channelId, args),
  },
  {
    name: "gmail_archiveThread",
    description: "Archive a Gmail thread locally and in Gmail. Parameters: { threadId: string }.",
    schema: THREAD_ID_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.archiveThread(channelId, args),
  },
  {
    name: "gmail_markRead",
    description: "Mark a Gmail thread read. Parameters: { threadId: string }.",
    schema: THREAD_ID_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.markRead(channelId, args),
  },
  {
    name: "gmail_categorize",
    description:
      "Set a local category for a Gmail thread. Parameters: { threadId: string, category: string }.",
    schema: CATEGORIZE_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.categorize(channelId, args),
  },
  {
    name: "gmail_clearSearch",
    description: "Clear the Gmail desk search results.",
    schema: EMPTY_TOOL_SCHEMA,
    run: (handlers, channelId) => handlers.clearSearch(channelId),
  },
  {
    name: "gmail_setPollInterval",
    description: "Configure Gmail polling. Parameters: { pollIntervalMs: number }.",
    schema: POLL_INTERVAL_TOOL_SCHEMA,
    run: (handlers, channelId, args) => handlers.setPollInterval(channelId, args),
  },
  {
    name: "gmail_listActionableThreads",
    description: "List current unread or inbox threads. Parameters: { limit?: number }.",
    schema: LIST_THREADS_TOOL_SCHEMA,
    run: (handlers, channelId, args) =>
      handlers.listActionableThreads(channelId, numberArg(record(args), "limit") ?? 6),
  },
];
