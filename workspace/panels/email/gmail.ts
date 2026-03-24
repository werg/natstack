/**
 * Gmail & Calendar API client for the email panel.
 *
 * Uses the OAuthTokenProvider abstraction so it works with any auth strategy
 * (Nango, cookies, etc). All API calls go through Google's REST APIs —
 * no SDK dependency needed.
 *
 * This module demonstrates how a panel developer would structure API access.
 * The key insight: panels shouldn't embed OAuth logic. They should just call
 * `tokenProvider.getToken()` and use the result as a Bearer token.
 */

import type { OAuthTokenProvider, OAuthToken } from "./oauth.js";

// ---- Types ----

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

export interface SendMessageRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  threadId?: string;
}

// ---- Gmail Client ----

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

export class GmailClient {
  constructor(private tokenProvider: OAuthTokenProvider) {}

  private async fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.tokenProvider.getToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);

    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GmailApiError(res.status, `Gmail API error ${res.status}: ${body}`);
    }
    return res;
  }

  /** List messages matching a query (Gmail search syntax) */
  async listMessages(query: string = "", maxResults: number = 20): Promise<GmailMessage[]> {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });
    const res = await this.fetchWithAuth(`${GMAIL_BASE}/messages?${params}`);
    const data = await res.json() as { messages?: Array<{ id: string; threadId: string }> };

    if (!data.messages?.length) return [];

    // Batch-fetch message details (up to 20 at a time)
    const messages = await Promise.all(
      data.messages.map(m => this.getMessage(m.id)),
    );
    return messages;
  }

  /** Get a single message by ID */
  async getMessage(messageId: string): Promise<GmailMessage> {
    const res = await this.fetchWithAuth(
      `${GMAIL_BASE}/messages/${messageId}?format=full`,
    );
    const raw = await res.json() as GmailRawMessage;
    return parseGmailMessage(raw);
  }

  /** Get a full thread */
  async getThread(threadId: string): Promise<GmailThread> {
    const res = await this.fetchWithAuth(
      `${GMAIL_BASE}/threads/${threadId}?format=full`,
    );
    const raw = await res.json() as { id: string; snippet: string; messages: GmailRawMessage[] };
    const messages = raw.messages.map(parseGmailMessage);
    return {
      id: raw.id,
      subject: messages[0]?.subject ?? "(no subject)",
      messages,
      snippet: raw.snippet,
    };
  }

  /** Search messages */
  async search(query: string, maxResults: number = 10): Promise<GmailMessage[]> {
    return this.listMessages(query, maxResults);
  }

  /** Send a message */
  async sendMessage(req: SendMessageRequest): Promise<{ id: string; threadId: string }> {
    const raw = buildRawEmail(req);
    const encoded = btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const body: Record<string, string> = { raw: encoded };
    if (req.threadId) body.threadId = req.threadId;

    const res = await this.fetchWithAuth(`${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json() as { id: string; threadId: string };
  }

  /** Get the user's email address */
  async getProfile(): Promise<{ email: string; messagesTotal: number }> {
    const res = await this.fetchWithAuth(`${GMAIL_BASE}/profile`);
    const data = await res.json() as { emailAddress: string; messagesTotal: number };
    return { email: data.emailAddress, messagesTotal: data.messagesTotal };
  }

  /** List labels */
  async listLabels(): Promise<Array<{ id: string; name: string; type: string }>> {
    const res = await this.fetchWithAuth(`${GMAIL_BASE}/labels`);
    const data = await res.json() as { labels: Array<{ id: string; name: string; type: string }> };
    return data.labels ?? [];
  }

  /** Modify message labels (e.g., mark as read) */
  async modifyMessage(
    messageId: string,
    addLabels: string[] = [],
    removeLabels: string[] = [],
  ): Promise<void> {
    await this.fetchWithAuth(`${GMAIL_BASE}/messages/${messageId}/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        addLabelIds: addLabels,
        removeLabelIds: removeLabels,
      }),
    });
  }

  /** Mark a message as read */
  async markAsRead(messageId: string): Promise<void> {
    await this.modifyMessage(messageId, [], ["UNREAD"]);
  }

  /** Archive a message */
  async archive(messageId: string): Promise<void> {
    await this.modifyMessage(messageId, [], ["INBOX"]);
  }
}

// ---- Calendar Client ----

export class CalendarClient {
  constructor(private tokenProvider: OAuthTokenProvider) {}

  private async fetchWithAuth(url: string, init?: RequestInit): Promise<Response> {
    const token = await this.tokenProvider.getToken();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);

    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GmailApiError(res.status, `Calendar API error ${res.status}: ${body}`);
    }
    return res;
  }

  /** List upcoming events */
  async listEvents(opts?: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
    calendarId?: string;
  }): Promise<CalendarEvent[]> {
    const calendarId = opts?.calendarId ?? "primary";
    const params = new URLSearchParams({
      timeMin: opts?.timeMin ?? new Date().toISOString(),
      maxResults: String(opts?.maxResults ?? 10),
      singleEvents: "true",
      orderBy: "startTime",
    });
    if (opts?.timeMax) params.set("timeMax", opts.timeMax);

    const res = await this.fetchWithAuth(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    );
    const data = await res.json() as { items?: GcalRawEvent[] };
    return (data.items ?? []).map(parseCalendarEvent);
  }

  /** Get a single event */
  async getEvent(eventId: string, calendarId: string = "primary"): Promise<CalendarEvent> {
    const res = await this.fetchWithAuth(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    );
    const raw = await res.json() as GcalRawEvent;
    return parseCalendarEvent(raw);
  }
}

// ---- Internal types & helpers ----

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

interface GcalRawEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  attendees?: Array<{ email: string }>;
  htmlLink?: string;
}

function getHeader(msg: GmailRawMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(padded);
  } catch {
    return data;
  }
}

function extractBody(payload: GmailRawMessage["payload"]): string {
  // Try direct body
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  // Try parts (prefer text/plain, fall back to text/html)
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);

    const htmlPart = payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) return decodeBase64Url(htmlPart.body.data);

    // Nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = part.parts.find(p => p.mimeType === "text/plain");
        if (nested?.body?.data) return decodeBase64Url(nested.body.data);
      }
    }
  }
  return "";
}

function parseGmailMessage(raw: GmailRawMessage): GmailMessage {
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

function parseCalendarEvent(raw: GcalRawEvent): CalendarEvent {
  return {
    id: raw.id,
    summary: raw.summary ?? "(no title)",
    description: raw.description,
    start: raw.start?.dateTime ?? raw.start?.date ?? "",
    end: raw.end?.dateTime ?? raw.end?.date ?? "",
    location: raw.location,
    attendees: raw.attendees?.map(a => a.email) ?? [],
    htmlLink: raw.htmlLink,
  };
}

function buildRawEmail(req: SendMessageRequest): string {
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

export class GmailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}
