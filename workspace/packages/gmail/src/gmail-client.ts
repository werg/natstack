import type {
  CredentialClient,
  UrlCredentialHandle,
} from "@workspace/runtime/credentials";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const googleWorkspaceCredential = {
  id: "google-workspace",
  displayName: "Google Workspace",
  audiences: [
    { url: "https://gmail.googleapis.com/", match: "origin" as const },
    { url: "https://www.googleapis.com/", match: "origin" as const },
  ],
};

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessageBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessageBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  raw?: string;
  payload?: GmailMessagePart;
  [key: string]: unknown;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
  [key: string]: unknown;
}

export interface GmailDraft {
  id: string;
  message: GmailMessage;
  [key: string]: unknown;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: {
    textColor?: string;
    backgroundColor?: string;
  };
  [key: string]: unknown;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
  [key: string]: unknown;
}

export interface GmailHistoryMessageRef {
  id: string;
  threadId: string;
}

export interface GmailHistoryEntry {
  id: string;
  messages?: GmailHistoryMessageRef[];
  messagesAdded?: Array<{ message: GmailMessage }>;
  messagesDeleted?: Array<{ message: GmailHistoryMessageRef }>;
  labelsAdded?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>;
}

export interface GmailHistoryResponse {
  history?: GmailHistoryEntry[];
  historyId: string;
  nextPageToken?: string;
  [key: string]: unknown;
}

export type GmailHistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

export interface ListHistoryOptions {
  startHistoryId: string;
  maxResults?: number;
  labelId?: string;
  historyTypes?: GmailHistoryType[];
}

export interface ListMessagesOptions {
  maxResults?: number;
  labelIds?: string[];
  q?: string;
  pageToken?: string;
  format?: "full" | "metadata" | "minimal" | "raw";
  metadataHeaders?: string[];
}

export interface GetMessageOptions {
  format?: "full" | "metadata" | "minimal" | "raw";
  metadataHeaders?: string[];
}

export interface GetThreadOptions extends GetMessageOptions {}

export interface ListMessagesResult {
  messages: GmailMessage[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface SendMessageParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string | string[];
  headers?: Record<string, string>;
  threadId?: string;
}

export interface CreateDraftParams extends SendMessageParams {}

export interface ModifyLabelsParams {
  messageId?: string;
  threadId?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface GmailThreadDiff {
  threadId: string;
  messagesAdded: GmailMessage[];
  messagesDeleted: GmailHistoryMessageRef[];
  labelsAdded: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
  labelsRemoved: Array<{ message: GmailHistoryMessageRef; labelIds: string[] }>;
}

export interface GmailSyncDiff {
  historyId: string;
  rawHistory: GmailHistoryResponse;
  threads: GmailThreadDiff[];
}

export interface GmailClient {
  handle(): Promise<UrlCredentialHandle>;
  getProfile(): Promise<GmailProfile>;
  listLabels(): Promise<GmailLabel[]>;
  listMessages(opts?: ListMessagesOptions): Promise<ListMessagesResult>;
  search(q: string, opts?: Omit<ListMessagesOptions, "q">): Promise<ListMessagesResult>;
  listHistory(opts: ListHistoryOptions): Promise<GmailHistoryResponse>;
  syncSince(historyId: string): Promise<GmailSyncDiff>;
  getMessage(messageId: string, opts?: GetMessageOptions): Promise<GmailMessage>;
  getThread(threadId: string, opts?: GetThreadOptions): Promise<GmailThread>;
  sendMessage(params: SendMessageParams): Promise<GmailMessage>;
  createDraft(params: CreateDraftParams): Promise<GmailDraft>;
  sendDraft(draftId: string): Promise<GmailMessage>;
  modifyLabels(params: ModifyLabelsParams): Promise<GmailMessage | GmailThread>;
}

function toQueryParams(params?: Record<string, string | number | string[] | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined") continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function sanitizeHeaderValue(field: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `Gmail sendMessage: ${field} value contains CR/LF - header injection rejected`,
    );
  }
  return value;
}

function sanitizeHeaderName(name: string): string {
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
    throw new Error(`Gmail sendMessage: invalid header name "${name}"`);
  }
  return name;
}

function joinAddressList(value?: string | string[]): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildRawMessage(params: SendMessageParams): string {
  const f = (field: string, value: string): string => sanitizeHeaderValue(field, value);
  const rawLines = [
    params.from ? `From: ${f("From", params.from)}` : undefined,
    `To: ${f("To", joinAddressList(params.to) ?? "")}`,
    params.cc ? `Cc: ${f("Cc", joinAddressList(params.cc) ?? "")}` : undefined,
    params.bcc ? `Bcc: ${f("Bcc", joinAddressList(params.bcc) ?? "")}` : undefined,
    params.replyTo ? `Reply-To: ${f("Reply-To", params.replyTo)}` : undefined,
    params.inReplyTo ? `In-Reply-To: ${f("In-Reply-To", params.inReplyTo)}` : undefined,
    params.references ? `References: ${f("References", joinAddressList(params.references) ?? "")}` : undefined,
    `Subject: ${f("Subject", params.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...Object.entries(params.headers ?? {}).map(([key, value]) => {
      const safeKey = sanitizeHeaderName(key);
      return `${safeKey}: ${f(safeKey, value)}`;
    }),
    "",
    params.body,
  ].filter((line): line is string => typeof line === "string");
  return encodeBase64Url(rawLines.join("\r\n"));
}

function appendThread<T extends { raw: string }>(payload: T, threadId?: string): T & { threadId?: string } {
  return threadId ? { ...payload, threadId } : payload;
}

function emptyThreadDiff(threadId: string): GmailThreadDiff {
  return {
    threadId,
    messagesAdded: [],
    messagesDeleted: [],
    labelsAdded: [],
    labelsRemoved: [],
  };
}

function aggregateHistoryByThread(history: GmailHistoryResponse): GmailThreadDiff[] {
  const byThread = new Map<string, GmailThreadDiff>();
  const get = (threadId: string): GmailThreadDiff => {
    let diff = byThread.get(threadId);
    if (!diff) {
      diff = emptyThreadDiff(threadId);
      byThread.set(threadId, diff);
    }
    return diff;
  };

  for (const entry of history.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.threadId) get(added.message.threadId).messagesAdded.push(added.message);
    }
    for (const deleted of entry.messagesDeleted ?? []) {
      if (deleted.message?.threadId) get(deleted.message.threadId).messagesDeleted.push(deleted.message);
    }
    for (const added of entry.labelsAdded ?? []) {
      if (added.message?.threadId) {
        get(added.message.threadId).labelsAdded.push({
          message: added.message,
          labelIds: added.labelIds ?? [],
        });
      }
    }
    for (const removed of entry.labelsRemoved ?? []) {
      if (removed.message?.threadId) {
        get(removed.message.threadId).labelsRemoved.push({
          message: removed.message,
          labelIds: removed.labelIds ?? [],
        });
      }
    }
  }

  return [...byThread.values()];
}

export function createGmailClient(credentials: CredentialClient): GmailClient {
  let handlePromise: Promise<UrlCredentialHandle> | null = null;
  const handle = (): Promise<UrlCredentialHandle> => {
    if (!handlePromise) {
      const p = credentials.forAudience({
        ...googleWorkspaceCredential,
        label: googleWorkspaceCredential.displayName,
      });
      p.catch(() => {
        if (handlePromise === p) handlePromise = null;
      });
      handlePromise = p;
    }
    return handlePromise;
  };

  const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const auth = await handle();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await auth.fetch(`${GMAIL_API_BASE}${path}`, { ...init, headers });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `Gmail API request failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`,
      );
    }
    return (await response.json()) as T;
  };

  const listHistory = async (opts: ListHistoryOptions): Promise<GmailHistoryResponse> => {
    let pageToken: string | undefined;
    const combined: GmailHistoryResponse = { historyId: opts.startHistoryId };
    do {
      const page = await apiFetch<GmailHistoryResponse>(
        `/history${toQueryParams({
          startHistoryId: opts.startHistoryId,
          maxResults: opts.maxResults,
          labelId: opts.labelId,
          historyTypes: opts.historyTypes,
          pageToken,
        })}`,
      );
      combined.historyId = page.historyId;
      combined.history = [...(combined.history ?? []), ...(page.history ?? [])];
      pageToken = page.nextPageToken;
    } while (pageToken);
    return combined;
  };

  const getMessage = async (messageId: string, opts?: GetMessageOptions): Promise<GmailMessage> => {
    const query = toQueryParams({
      format: opts?.format,
      metadataHeaders: opts?.metadataHeaders,
    });
    return apiFetch<GmailMessage>(`/messages/${encodeURIComponent(messageId)}${query}`);
  };

  const getThread = async (threadId: string, opts?: GetThreadOptions): Promise<GmailThread> => {
    const query = toQueryParams({
      format: opts?.format,
      metadataHeaders: opts?.metadataHeaders,
    });
    return apiFetch<GmailThread>(`/threads/${encodeURIComponent(threadId)}${query}`);
  };

  const listMessages = async (opts?: ListMessagesOptions): Promise<ListMessagesResult> => {
    const { format = "full", metadataHeaders, ...query } = opts ?? {};
    const data = await apiFetch<{
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
      resultSizeEstimate?: number;
    }>(`/messages${toQueryParams(query)}`);

    if (!data.messages?.length) {
      return {
        messages: [],
        nextPageToken: data.nextPageToken,
        resultSizeEstimate: data.resultSizeEstimate,
      };
    }

    const messages = await Promise.all(
      data.messages.map((message) => getMessage(message.id, { format, metadataHeaders })),
    );
    return {
      messages,
      nextPageToken: data.nextPageToken,
      resultSizeEstimate: data.resultSizeEstimate,
    };
  };

  const sendMessage = async (params: SendMessageParams): Promise<GmailMessage> =>
    apiFetch<GmailMessage>("/messages/send", {
      method: "POST",
      body: JSON.stringify(appendThread({ raw: buildRawMessage(params) }, params.threadId)),
    });

  return {
    handle,
    getProfile: () => apiFetch<GmailProfile>("/profile"),
    listLabels: async () => {
      const data = await apiFetch<{ labels?: GmailLabel[] }>("/labels");
      return data.labels ?? [];
    },
    listMessages,
    search: (q, opts) => listMessages({ ...opts, q }),
    listHistory,
    syncSince: async (historyId) => {
      const rawHistory = await listHistory({
        startHistoryId: historyId,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      });
      return {
        historyId: rawHistory.historyId,
        rawHistory,
        threads: aggregateHistoryByThread(rawHistory),
      };
    },
    getMessage,
    getThread,
    sendMessage,
    createDraft: (params) => apiFetch<GmailDraft>("/drafts", {
      method: "POST",
      body: JSON.stringify({
        message: appendThread({ raw: buildRawMessage(params) }, params.threadId),
      }),
    }),
    sendDraft: async (draftId) => {
      return apiFetch<GmailMessage>("/drafts/send", {
        method: "POST",
        body: JSON.stringify({ id: draftId }),
      });
    },
    modifyLabels: (params) => {
      if (params.messageId && params.threadId) {
        throw new Error("modifyLabels accepts messageId or threadId, not both");
      }
      const id = params.messageId ?? params.threadId;
      if (!id) throw new Error("modifyLabels requires messageId or threadId");
      const collection = params.threadId ? "threads" : "messages";
      return apiFetch<GmailMessage | GmailThread>(`/${collection}/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        body: JSON.stringify({
          addLabelIds: params.addLabelIds ?? [],
          removeLabelIds: params.removeLabelIds ?? [],
        }),
      });
    },
  };
}
