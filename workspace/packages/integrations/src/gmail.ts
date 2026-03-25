/**
 * Gmail API client for agent eval and panel use.
 *
 * Wraps the Gmail REST API with high-level methods. Handles OAuth tokens
 * automatically via @workspace/runtime.
 *
 * Usage from agent eval:
 *   import { gmail } from "@workspace/integrations";
 *   const messages = await gmail.search("from:alice");
 *   const thread = await gmail.getThread(messages[0].threadId);
 *   await gmail.send({ to: ["bob@example.com"], subject: "Hi", body: "Hello!" });
 */

import { oauth } from "@workspace/runtime";

// ============================================================================
// Types
// ============================================================================

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  date: string;
  snippet: string;
  body: string;
  labels: string[];
  isUnread: boolean;
}

export interface GmailThread {
  id: string;
  subject: string;
  messages: GmailMessage[];
  snippet: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  htmlLink?: string;
}

export interface SendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Message-ID to reply to */
  inReplyTo?: string;
  /** Thread ID to add the reply to */
  threadId?: string;
}

export interface GmailApiError extends Error {
  status: number;
}

// ============================================================================
// Internal helpers
// ============================================================================

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const PROVIDER = "google-mail";

async function authedFetch<T>(url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<T> {
  const token = await oauth.getToken(PROVIDER);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    ...init?.headers,
  };

  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Gmail API error ${res.status}: ${body}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

// ============================================================================
// Gmail client (module-level singleton — stateless, uses runtime oauth)
// ============================================================================

/**
 * Search messages using Gmail search syntax.
 *
 * @example
 *   await gmail.search("from:alice subject:meeting")
 *   await gmail.search("is:unread", 5)
 *   await gmail.search("newer_than:1d")
 */
export async function search(query: string, maxResults = 10): Promise<GmailMessage[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await authedFetch<{ messages?: Array<{ id: string }> }>(
    `${GMAIL_BASE}/messages?${params}`,
  );
  if (!data.messages?.length) return [];
  return Promise.all(data.messages.map(m => getMessage(m.id)));
}

/** Get a single message by ID. */
export async function getMessage(messageId: string): Promise<GmailMessage> {
  const raw = await authedFetch<GmailRawMessage>(
    `${GMAIL_BASE}/messages/${messageId}?format=full`,
  );
  return parseMessage(raw);
}

/** Get a full thread with all messages. */
export async function getThread(threadId: string): Promise<GmailThread> {
  const raw = await authedFetch<{ id: string; snippet: string; messages: GmailRawMessage[] }>(
    `${GMAIL_BASE}/threads/${threadId}?format=full`,
  );
  const messages = raw.messages.map(parseMessage);
  return {
    id: raw.id,
    subject: messages[0]?.subject ?? "(no subject)",
    messages,
    snippet: raw.snippet,
  };
}

/**
 * Send an email.
 *
 * @example
 *   await gmail.send({
 *     to: ["alice@example.com"],
 *     subject: "Meeting tomorrow",
 *     body: "Hi Alice, are we still on for tomorrow?"
 *   });
 *
 *   // Reply to a thread
 *   await gmail.send({
 *     to: ["alice@example.com"],
 *     subject: "Re: Meeting tomorrow",
 *     body: "Sounds good!",
 *     threadId: "18abc...",
 *     inReplyTo: "<original-message-id@mail.gmail.com>",
 *   });
 */
export async function send(opts: SendOptions): Promise<{ id: string; threadId: string }> {
  const raw = buildRawEmail(opts);
  const encoded = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body: Record<string, string> = { raw: encoded };
  if (opts.threadId) body["threadId"] = opts.threadId;

  return authedFetch<{ id: string; threadId: string }>(`${GMAIL_BASE}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Get the authenticated user's email address and total message count. */
export async function getProfile(): Promise<{ email: string; messagesTotal: number }> {
  const data = await authedFetch<{ emailAddress: string; messagesTotal: number }>(
    `${GMAIL_BASE}/profile`,
  );
  return { email: data.emailAddress, messagesTotal: data.messagesTotal };
}

/** List all labels in the mailbox. */
export async function listLabels(): Promise<Array<{ id: string; name: string; type: string }>> {
  const data = await authedFetch<{ labels: Array<{ id: string; name: string; type: string }> }>(
    `${GMAIL_BASE}/labels`,
  );
  return data.labels ?? [];
}

/** Mark a message as read. */
export async function markAsRead(messageId: string): Promise<void> {
  await modifyLabels(messageId, [], ["UNREAD"]);
}

/** Archive a message (remove from inbox). */
export async function archive(messageId: string): Promise<void> {
  await modifyLabels(messageId, [], ["INBOX"]);
}

/** Add/remove labels from a message. */
export async function modifyLabels(
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): Promise<void> {
  await authedFetch(`${GMAIL_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

/**
 * Ensure the Gmail OAuth connection is active.
 * If not connected, triggers the consent + auth flow.
 * Call this before other methods if you're not sure the user has connected.
 *
 * @example
 *   await gmail.ensureConnected();
 *   const messages = await gmail.search("is:unread");
 */
export async function ensureConnected(): Promise<{ email: string }> {
  // Check if already connected
  const conn = await oauth.getConnection(PROVIDER);
  if (conn.connected) {
    return { email: conn.email ?? "" };
  }

  // Not connected — trigger the staged flow
  await oauth.requestConsent(PROVIDER, {
    scopes: ["gmail.readonly", "gmail.send", "calendar.readonly"],
  });
  await oauth.startAuth(PROVIDER);
  const result = await oauth.waitForConnection(PROVIDER);
  return { email: result.email ?? "" };
}

// ============================================================================
// Internal types & helpers
// ============================================================================

interface GmailRawMessage {
  id: string;
  threadId: string;
  snippet: string;
  labelIds?: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    }>;
  };
}

function getHeader(msg: GmailRawMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return atob(padded); } catch { return data; }
}

function extractBody(payload: GmailRawMessage["payload"]): string {
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);
    const htmlPart = payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) return decodeBase64Url(htmlPart.body.data);
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = part.parts.find(p => p.mimeType === "text/plain");
        if (nested?.body?.data) return decodeBase64Url(nested.body.data);
      }
    }
  }
  return "";
}

function parseMessage(raw: GmailRawMessage): GmailMessage {
  return {
    id: raw.id,
    threadId: raw.threadId,
    subject: getHeader(raw, "Subject") || "(no subject)",
    from: getHeader(raw, "From"),
    to: getHeader(raw, "To").split(",").map(s => s.trim()).filter(Boolean),
    date: getHeader(raw, "Date"),
    snippet: raw.snippet,
    body: extractBody(raw.payload),
    labels: raw.labelIds ?? [],
    isUnread: raw.labelIds?.includes("UNREAD") ?? false,
  };
}

function buildRawEmail(req: SendOptions): string {
  const lines: string[] = [];
  lines.push(`To: ${req.to.join(", ")}`);
  if (req.cc?.length) lines.push(`Cc: ${req.cc.join(", ")}`);
  if (req.bcc?.length) lines.push(`Bcc: ${req.bcc.join(", ")}`);
  lines.push(`Subject: ${req.subject}`);
  lines.push("Content-Type: text/plain; charset=utf-8");
  if (req.inReplyTo) lines.push(`In-Reply-To: ${req.inReplyTo}`);
  lines.push("");
  lines.push(req.body);
  return lines.join("\r\n");
}
