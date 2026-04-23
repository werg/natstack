const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
const DEFAULT_POLL_INTERVAL_MS = 60_000

export const manifest = {
  providers: ["google"],
  scopes: {
    google: ["gmail_readonly", "gmail_send"],
  },
  endpoints: {
    google: [
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/*", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", methods: ["POST"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/profile", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/labels", methods: ["GET"] },
      { url: "https://gmail.googleapis.com/gmail/v1/users/me/history", methods: ["GET"] },
    ],
  },
  webhooks: {
    google: [
      { event: "message.new", deliver: "onNewMessage" },
    ],
  },
} as const

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailMessageBody {
  size?: number
  data?: string
  attachmentId?: string
}

export interface GmailMessagePart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: GmailMessageBody
  parts?: GmailMessagePart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  raw?: string
  payload?: GmailMessagePart
  [key: string]: unknown
}

export interface GmailLabel {
  id: string
  name: string
  type?: string
  messageListVisibility?: string
  labelListVisibility?: string
  messagesTotal?: number
  messagesUnread?: number
  threadsTotal?: number
  threadsUnread?: number
  color?: {
    textColor?: string
    backgroundColor?: string
  }
  [key: string]: unknown
}

export interface GmailProfile {
  emailAddress: string
  messagesTotal: number
  threadsTotal: number
  historyId: string
  [key: string]: unknown
}

export interface GmailHistoryMessageRef {
  id: string
  threadId: string
}

export interface GmailHistoryEntry {
  id: string
  messages?: GmailHistoryMessageRef[]
  messagesAdded?: Array<{ message: GmailMessage }>
  messagesDeleted?: Array<{ message: GmailHistoryMessageRef }>
  labelsAdded?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>
  labelsRemoved?: Array<{ message: GmailHistoryMessageRef; labelIds?: string[] }>
}

export interface GmailHistoryResponse {
  history?: GmailHistoryEntry[]
  historyId: string
  nextPageToken?: string
  [key: string]: unknown
}

export interface ListMessagesOptions {
  maxResults?: number
  labelIds?: string[]
  q?: string
  pageToken?: string
  format?: "full" | "metadata" | "minimal" | "raw"
  metadataHeaders?: string[]
}

export interface GetMessageOptions {
  format?: "full" | "metadata" | "minimal" | "raw"
  metadataHeaders?: string[]
}

export interface ListMessagesResult {
  messages: GmailMessage[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface SendMessageParams {
  to: string | string[]
  subject: string
  body: string
  cc?: string | string[]
  bcc?: string | string[]
  from?: string
  replyTo?: string
  inReplyTo?: string
  references?: string | string[]
  headers?: Record<string, string>
}

export interface GmailNewMessageEvent {
  type: "message.new"
  historyId: string
  previousHistoryId?: string
  messages: GmailMessage[]
  rawHistory: GmailHistoryResponse
}

export interface StartPollingOptions {
  historyId?: string
  intervalMs?: number
  onNewMessages?: (event: GmailNewMessageEvent) => void | Promise<void>
  onError?: (error: unknown) => void | Promise<void>
}

interface ListHistoryOptions {
  startHistoryId: string
  maxResults?: number
  labelId?: string
  historyTypes?: Array<"messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved">
}

function toQueryParams(params?: Record<string, string | number | string[] | undefined>): string {
  if (!params) {
    return ""
  }

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined") {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, item)
      }
      continue
    }

    search.set(key, String(value))
  }

  const query = search.toString()
  return query ? `?${query}` : ""
}

async function gmailFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set("Accept", "application/json")

  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const bodyText = await response.text()
    throw new Error(
      `Gmail API request failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ""}`,
    )
  }

  return await response.json() as T
}

function joinAddressList(value?: string | string[]): string | undefined {
  if (!value) {
    return undefined
  }

  return Array.isArray(value) ? value.join(", ") : value
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")
  }

  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

async function listHistory(opts: ListHistoryOptions): Promise<GmailHistoryResponse> {
  let pageToken: string | undefined
  const combined: GmailHistoryResponse = { historyId: opts.startHistoryId }

  do {
    const page = await gmailFetch<GmailHistoryResponse>(
      `/history${toQueryParams({
        startHistoryId: opts.startHistoryId,
        maxResults: opts.maxResults,
        labelId: opts.labelId,
        historyTypes: opts.historyTypes,
        pageToken,
      })}`,
    )

    combined.historyId = page.historyId
    combined.history = [...(combined.history ?? []), ...(page.history ?? [])]
    pageToken = page.nextPageToken
  } while (pageToken)

  return combined
}

function extractNewMessageIds(history: GmailHistoryResponse): string[] {
  const ids = new Set<string>()

  for (const entry of history.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.id) {
        ids.add(added.message.id)
      }
    }
  }

  return [...ids]
}

function isExpiredHistoryCursor(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("404") || message.includes("notFound")
}

export async function listMessages(opts?: ListMessagesOptions): Promise<ListMessagesResult> {
  const { format = "full", metadataHeaders, ...query } = opts ?? {}
  const data = await gmailFetch<{
    messages?: Array<{ id: string; threadId: string }>
    nextPageToken?: string
    resultSizeEstimate?: number
  }>(`/messages${toQueryParams(query)}`)

  if (!data.messages?.length) {
    return {
      messages: [],
      nextPageToken: data.nextPageToken,
      resultSizeEstimate: data.resultSizeEstimate,
    }
  }

  const messages = await Promise.all(
    data.messages.map((message) => getMessage(message.id, { format, metadataHeaders })),
  )

  return {
    messages,
    nextPageToken: data.nextPageToken,
    resultSizeEstimate: data.resultSizeEstimate,
  }
}

export async function getMessage(
  messageId: string,
  opts?: GetMessageOptions,
): Promise<GmailMessage> {
  const query = toQueryParams({
    format: opts?.format,
    metadataHeaders: opts?.metadataHeaders,
  })

  return gmailFetch<GmailMessage>(`/messages/${encodeURIComponent(messageId)}${query}`)
}

export async function sendMessage(params: SendMessageParams): Promise<GmailMessage> {
  const rawLines = [
    params.from ? `From: ${params.from}` : undefined,
    `To: ${joinAddressList(params.to)}`,
    params.cc ? `Cc: ${joinAddressList(params.cc)}` : undefined,
    params.bcc ? `Bcc: ${joinAddressList(params.bcc)}` : undefined,
    params.replyTo ? `Reply-To: ${params.replyTo}` : undefined,
    params.inReplyTo ? `In-Reply-To: ${params.inReplyTo}` : undefined,
    params.references ? `References: ${joinAddressList(params.references)}` : undefined,
    `Subject: ${params.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    ...Object.entries(params.headers ?? {}).map(([key, value]) => `${key}: ${value}`),
    "",
    params.body,
  ].filter((line): line is string => typeof line === "string")

  return gmailFetch<GmailMessage>("/messages/send", {
    method: "POST",
    body: JSON.stringify({
      raw: encodeBase64Url(rawLines.join("\r\n")),
    }),
  })
}

export async function getProfile(): Promise<GmailProfile> {
  return gmailFetch<GmailProfile>("/profile")
}

export async function listLabels(): Promise<GmailLabel[]> {
  const data = await gmailFetch<{ labels?: GmailLabel[] }>("/labels")
  return data.labels ?? []
}

export function startPolling(opts: StartPollingOptions = {}): () => void {
  let disposed = false
  let inFlight = false
  let historyId = opts.historyId

  const poll = async () => {
    if (disposed || inFlight) {
      return
    }

    inFlight = true

    try {
      if (!historyId) {
        historyId = (await getProfile()).historyId
        return
      }

      const history = await listHistory({
        startHistoryId: historyId,
        historyTypes: ["messageAdded"],
      })

      const previousHistoryId = historyId
      historyId = history.historyId

      const messageIds = extractNewMessageIds(history)
      if (messageIds.length === 0) {
        return
      }

      const messages = await Promise.all(messageIds.map((id) => getMessage(id)))
      const event: GmailNewMessageEvent = {
        type: "message.new",
        historyId,
        previousHistoryId,
        messages,
        rawHistory: history,
      }

      await (opts.onNewMessages ?? onNewMessage)(event)
    } catch (error) {
      if (isExpiredHistoryCursor(error)) {
        try {
          historyId = (await getProfile()).historyId
        } catch (profileError) {
          await opts.onError?.(profileError)
        }
      } else {
        await opts.onError?.(error)
      }
    } finally {
      inFlight = false
    }
  }

  void poll()

  const interval = setInterval(() => {
    void poll()
  }, opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS)

  return () => {
    disposed = true
    clearInterval(interval)
  }
}

export async function onNewMessage(_event: GmailNewMessageEvent): Promise<void> {
  // Placeholder hook for runtime webhook delivery or caller-provided overrides.
}

export async function search(
  q: string,
  opts?: Omit<ListMessagesOptions, "q">,
): Promise<ListMessagesResult> {
  return listMessages({ ...opts, q })
}

export const gmail = {
  manifest,
  listMessages,
  getMessage,
  sendMessage,
  getProfile,
  listLabels,
  startPolling,
  onNewMessage,
  search,
  send: sendMessage,
} as const
