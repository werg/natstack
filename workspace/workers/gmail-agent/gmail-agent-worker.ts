import { TrajectoryVesselBase, type RespondPolicy } from "@workspace/agentic-do";
import { complete, getModel as getPiModel, type Context } from "@earendil-works/pi-ai";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import {
  AGENTIC_PROTOCOL_VERSION,
  type ActorRef,
  type AgenticEvent,
  type CustomMessageDisplayMode,
  type MessageId,
} from "@workspace/agentic-protocol";
import { createGmailClient, type GmailClient, type GmailMessage, type GmailThread } from "@workspace/gmail";
import { reduce as reduceGmailThread, type GmailThreadState } from "@workspace/gmail/renderers/gmail-thread.reducer";
import type { PiRunnerOptions } from "@natstack/harness";
import type { ParticipantDescriptor } from "@natstack/harness/types";

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const METADATA_HEADERS = ["Subject", "From", "To", "Date", "Message-ID", "References", "In-Reply-To"];
const GMAIL_SYSTEM_CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};
const GMAIL_TOOL_NAMES = new Set([
  "gmail_checkInbox",
  "gmail_search",
  "gmail_summarizeThread",
  "gmail_draftReply",
  "gmail_send",
  "gmail_categorize",
  "gmail_setPollInterval",
  "gmail_listActionableThreads",
]);

type GmailTool = NonNullable<PiRunnerOptions["extraTools"]>[number];

interface GmailChannelState {
  channelId: string;
  historyId?: string;
  emailAddress?: string;
  pollIntervalMs: number;
  inboxMessageId?: string;
  lastSyncAt?: number;
  lastError?: string;
  lastOverviewJson?: string;
}

interface GmailThreadStateRow {
  channel_id: string;
  thread_id: string;
  message_id: string | null;
  subject: string;
  from_addr: string;
  snippet: string;
  unread: number;
  in_inbox: number;
  actionable: number;
  category: string | null;
  updated_at: number;
}

interface GmailThreadCardState extends GmailThreadState {
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  unread: boolean;
  inInbox: boolean;
  category?: string;
  actionable: boolean;
  updatedAt: number;
}

interface GmailComposeState {
  to?: string;
  subject?: string;
  body?: string;
  threadId?: string;
  sourceThreadId?: string;
  status: "draft" | "sending" | "sent" | "error";
  error?: string;
}

interface GmailInboxState {
  email?: string;
  unread: number;
  urgent: number;
  draftCount: number;
  perCategory?: Record<string, number>;
  actionable: GmailThreadCardState[];
  lastSyncedAt?: string;
  lastError?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function header(message: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function latestMessage(thread: GmailThread): GmailMessage | undefined {
  return thread.messages?.[thread.messages.length - 1];
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = typeof Buffer !== "undefined"
    ? Buffer.from(padded, "base64")
    : Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function textFromPart(part: NonNullable<GmailMessage["payload"]> | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const text = textFromPart(child);
    if (text) return text;
  }
  return "";
}

function textContentFromAssistant(message: Awaited<ReturnType<typeof complete>>): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function categoryFromLabels(labels: Set<string>): string | undefined {
  for (const [labelId, category] of Object.entries(GMAIL_SYSTEM_CATEGORIES)) {
    if (labels.has(labelId)) return category;
  }
  return undefined;
}

function isExcludedActionableCategory(labels: Set<string>): boolean {
  return labels.has("CATEGORY_PROMOTIONS")
    || labels.has("CATEGORY_SOCIAL")
    || labels.has("CATEGORY_UPDATES")
    || labels.has("CATEGORY_FORUMS");
}

function addressHeaderIncludes(message: GmailMessage | undefined, email: string | undefined): boolean {
  if (!message || !email) return false;
  const normalizedEmail = email.toLowerCase();
  const recipients = [header(message, "To"), header(message, "Cc"), header(message, "Bcc")]
    .filter((value): value is string => Boolean(value))
    .join(",")
    .toLowerCase();
  return recipients.includes(normalizedEmail);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\b404\b/.test(err.message);
}

function toolResult(details: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function threadCardState(thread: GmailThread, category?: string | null, userEmail?: string): GmailThreadCardState {
  const message = latestMessage(thread) ?? thread.messages?.[0];
  const labels = new Set((thread.messages ?? []).flatMap((m) => m.labelIds ?? []));
  const latestLabels = new Set(message?.labelIds ?? []);
  const resolvedCategory = category ?? categoryFromLabels(labels);
  const actionable = latestLabels.has("UNREAD")
    && !isExcludedActionableCategory(labels)
    && addressHeaderIncludes(message, userEmail);
  const updatedAt = Math.max(
    Date.now(),
    ...((thread.messages ?? [])
      .map((m) => Number(m.internalDate ?? 0))
      .filter((value) => Number.isFinite(value))),
  );
  return {
    threadId: thread.id,
    subject: (message && header(message, "Subject")) || "(no subject)",
    from: (message && header(message, "From")) || "",
    snippet: message?.snippet ?? "",
    participants: Array.from(new Set((thread.messages ?? [])
      .flatMap((m) => [header(m, "From"), header(m, "To")])
      .filter((value): value is string => Boolean(value)))),
    lastSnippet: message?.snippet ?? "",
    unreadCount: labels.has("UNREAD") ? 1 : 0,
    hasDraft: false,
    status: labels.has("INBOX") || labels.has("UNREAD") ? "unread" : "archived",
    unread: labels.has("UNREAD"),
    inInbox: labels.has("INBOX"),
    actionable,
    ...(resolvedCategory ? { category: resolvedCategory } : {}),
    updatedAt,
  };
}

export class GmailAgentWorker extends TrajectoryVesselBase {
  static override schemaVersion = 1;

  private _gmail: GmailClient | null = null;
  private recoveredChannels = new Set<string>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override createTables(): void {
    super.createTables();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_channel_state (
        channel_id TEXT PRIMARY KEY,
        history_id TEXT,
        email_address TEXT,
        poll_interval_ms INTEGER NOT NULL,
        inbox_message_id TEXT,
        last_sync_at INTEGER,
        last_error TEXT,
        last_overview_json TEXT
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN last_overview_json TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    try {
      this.sql.exec(`ALTER TABLE gmail_channel_state ADD COLUMN email_address TEXT`);
    } catch {
      // Column already exists on upgraded objects.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_threads (
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        subject TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        snippet TEXT NOT NULL,
        unread INTEGER NOT NULL,
        in_inbox INTEGER NOT NULL,
        actionable INTEGER NOT NULL DEFAULT 0,
        category TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(channel_id, thread_id)
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE gmail_threads ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists on upgraded objects.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gmail_categories (
        channel_id TEXT NOT NULL,
        category TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY(channel_id, category)
      )
    `);
  }

  protected get gmail(): GmailClient {
    this._gmail ??= this.createGmailClient();
    return this._gmail;
  }

  protected createGmailClient(): GmailClient {
    return createGmailClient(this.credentials);
  }

  protected override getModel(): string {
    return "openai-codex:gpt-5.5";
  }

  protected async generateDraftReplyBody(channelId: string, thread: GmailThread): Promise<string> {
    const modelName = this.getModel();
    const colonIdx = modelName.indexOf(":");
    if (colonIdx < 0) throw new Error(`Model must be "provider:model", got: ${modelName}`);
    const provider = modelName.slice(0, colonIdx);
    const modelId = modelName.slice(colonIdx + 1);
    const model = getPiModel(provider as never, modelId as never);
    if (!model) throw new Error(`No model metadata found for model provider: ${provider}`);

    const latest = latestMessage(thread);
    const context: Context = {
      systemPrompt: [
        "Draft a concise Gmail reply.",
        "Return only the email body, without a subject, greeting explanation, markdown, or signoff unless the thread clearly calls for one.",
        "Do not invent facts. If the answer needs missing information, ask for it briefly.",
      ].join("\n"),
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: [
          `Subject: ${latest ? header(latest, "Subject") ?? "" : ""}`,
          "",
          "Thread:",
          ...(thread.messages ?? []).map((message) => [
            `From: ${header(message, "From") ?? ""}`,
            `Date: ${header(message, "Date") ?? ""}`,
            textFromPart(message.payload).slice(0, 4_000) || message.snippet || "",
          ].join("\n")),
        ].join("\n\n").slice(0, 16_000),
      }],
    };
    const response = await complete(model, context, {
      apiKey: await this.getApiKeyForChannel(channelId)(),
      temperature: 0.2,
      maxTokens: 300,
    });
    return textContentFromAssistant(response) || "Thanks for the note. I will take a look and follow up shortly.";
  }

  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned-strict";
  }

  protected override getRunnerPromptConfig(_channelId: string): { systemPrompt?: string; systemPromptMode?: "replace" } {
    return {
      systemPromptMode: "replace",
      systemPrompt: [
        "You are the Gmail agent for this channel.",
        "Operate narrowly on Gmail tasks: inbox triage, search, summaries, drafting replies, sending only when requested, and explaining Gmail sync state.",
        "Do not start work unless invoked by an action bar, a Gmail custom message, or an explicit @gmail mention.",
        "Prefer Gmail methods and concise answers. Never invent message contents.",
      ].join("\n"),
    };
  }

  protected override getRunnerToolFilter(_channelId: string): PiRunnerOptions["toolFilter"] {
    return (toolName) => GMAIL_TOOL_NAMES.has(toolName);
  }

  protected override getRunnerTools(channelId: string): PiRunnerOptions["extraTools"] {
    return [
      this.gmailTool("gmail_checkInbox", "Synchronize Gmail now and refresh Gmail cards.", async (_toolCallId, params) =>
        this.syncChannel(channelId)),
      this.gmailTool("gmail_search", "Search Gmail. Parameters: { q: string, limit?: number }.", async (_toolCallId, params) =>
        this.search(channelId, record(params))),
      this.gmailTool("gmail_summarizeThread", "Fetch sanitized thread contents for summarization. Parameters: { threadId: string }.", async (_toolCallId, params) =>
        this.getThread(record(params))),
      this.gmailTool("gmail_draftReply", "Create a reply compose card. Parameters: { threadId: string }.", async (_toolCallId, params) =>
        this.draftReply(channelId, record(params))),
      this.gmailTool("gmail_send", "Send a Gmail message. Parameters: { to: string, subject: string, body: string, threadId?: string, messageId?: string }.", async (_toolCallId, params) =>
        this.send(channelId, record(params))),
      this.gmailTool("gmail_categorize", "Set a local category for a Gmail thread. Parameters: { threadId: string, category: string }.", async (_toolCallId, params) =>
        this.categorize(channelId, record(params))),
      this.gmailTool("gmail_setPollInterval", "Configure Gmail polling. Parameters: { pollIntervalMs: number }.", async (_toolCallId, params) =>
        this.setPollInterval(channelId, record(params))),
      this.gmailTool("gmail_listActionableThreads", "List current unread or inbox threads. Parameters: { limit?: number }.", async (_toolCallId, params) =>
        this.listActionableThreads(channelId, numberArg(record(params), "limit") ?? 6)),
    ];
  }

  private gmailTool(
    name: string,
    description: string,
    execute: (toolCallId: string, params: unknown) => Promise<unknown> | unknown,
  ): GmailTool {
    return {
      name,
      label: name,
      description,
      parameters: { type: "object", additionalProperties: true } as never,
      execute: async (toolCallId, params) => toolResult(await execute(toolCallId, params)),
    } as GmailTool;
  }

  protected override getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "gmail",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "Gmail",
      type: "agent",
      metadata: { provider: "gmail" },
      methods: [
        { name: "checkNow", description: "Synchronize Gmail now" },
        { name: "categorize", description: "Set a local category for a Gmail thread" },
        { name: "draftReply", description: "Create a reply compose card for a Gmail thread" },
        { name: "send", description: "Send a Gmail message or compose card" },
        { name: "compose", description: "Create a Gmail compose card" },
        { name: "search", description: "Search Gmail and publish a result card" },
        { name: "listActionableThreads", description: "Return current actionable Gmail threads" },
        { name: "setPollInterval", description: "Configure Gmail polling interval" },
        { name: "getThread", description: "Fetch sanitized Gmail thread contents" },
      ],
    };
  }

  override async subscribeChannel(opts: Parameters<TrajectoryVesselBase["subscribeChannel"]>[0]): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    this.setAlarm(this.getChannelState(opts.channelId).pollIntervalMs);
    return result;
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    const states = this.sql.exec(`SELECT channel_id FROM gmail_channel_state`).toArray();
    for (const row of states) {
      const channelId = String(row["channel_id"]);
      await this.ensureRecovered(channelId);
      await this.syncChannel(channelId).catch((err) => {
        this.recordSyncError(channelId, err);
        console.error(`[GmailAgentWorker] sync failed for channel=${channelId}:`, err);
      });
    }
    const intervals = this.sql.exec(`SELECT poll_interval_ms FROM gmail_channel_state`).toArray();
    const next = intervals
      .map((row) => Number(row["poll_interval_ms"]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0];
    if (next) this.setAlarm(next);
  }

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      switch (methodName) {
        case "checkNow":
          await this.ensureRecovered(channelId);
          return { result: await this.syncChannel(channelId) };
        case "categorize":
          await this.ensureRecovered(channelId);
          return { result: await this.categorize(channelId, record(args)) };
        case "draftReply":
          await this.ensureRecovered(channelId);
          return { result: await this.draftReply(channelId, record(args)) };
        case "send":
          await this.ensureRecovered(channelId);
          return { result: await this.send(channelId, record(args)) };
        case "compose":
          return { result: await this.compose(channelId, record(args)) };
        case "search":
          await this.ensureRecovered(channelId);
          return { result: await this.search(channelId, record(args)) };
        case "listActionableThreads":
          await this.ensureRecovered(channelId);
          return { result: this.listActionableThreads(channelId, numberArg(record(args), "limit") ?? 6) };
        case "setPollInterval":
          return { result: this.setPollInterval(channelId, record(args)) };
        case "getThread":
          return { result: await this.getThread(record(args)) };
        default:
          return { result: { error: `unknown method: ${methodName}` }, isError: true };
      }
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gmail_channel_state (channel_id, poll_interval_ms) VALUES (?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS,
    );
  }

  private getChannelState(channelId: string): GmailChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql.exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId).toArray()[0]!;
    return {
      channelId,
      historyId: row["history_id"] as string | undefined,
      emailAddress: row["email_address"] as string | undefined,
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      inboxMessageId: row["inbox_message_id"] as string | undefined,
      lastSyncAt: row["last_sync_at"] as number | undefined,
      lastError: row["last_error"] as string | undefined,
      lastOverviewJson: row["last_overview_json"] as string | undefined,
    };
  }

  private saveChannelState(state: GmailChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_channel_state
       (channel_id, history_id, email_address, poll_interval_ms, inbox_message_id, last_sync_at, last_error, last_overview_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.historyId ?? null,
      state.emailAddress ?? null,
      state.pollIntervalMs,
      state.inboxMessageId ?? null,
      state.lastSyncAt ?? null,
      state.lastError ?? null,
      state.lastOverviewJson ?? null,
    );
  }

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);

    const folded = await this.indexOwnCustomMessages(channelId, (typeId) => {
      if (typeId === "gmail.thread") {
        return (state, update) => reduceGmailThread(state as GmailThreadState, update as never);
      }
      return undefined;
    });

    const state = this.getChannelState(channelId);
    const inbox = folded.get("gmail.inbox");
    if (!state.inboxMessageId && inbox && inbox.size > 0) {
      state.inboxMessageId = [...inbox.keys()][0];
      this.saveChannelState(state);
    }

    for (const [messageId, value] of folded.get("gmail.thread") ?? []) {
      const thread = record(value);
      const threadId = typeof thread["threadId"] === "string" ? thread["threadId"] : undefined;
      if (!threadId) continue;
      const subject = typeof thread["subject"] === "string" ? thread["subject"] : "(no subject)";
      const from = Array.isArray(thread["participants"]) && typeof thread["participants"][0] === "string"
        ? thread["participants"][0]
        : "";
      const snippet = typeof thread["lastSnippet"] === "string"
        ? thread["lastSnippet"]
        : typeof thread["snippet"] === "string"
          ? thread["snippet"]
          : "";
      const unreadCount = typeof thread["unreadCount"] === "number" ? thread["unreadCount"] : 0;
      const status = typeof thread["status"] === "string" ? thread["status"] : "unread";
      const category = typeof thread["category"] === "string" ? thread["category"] : null;
      const actionable = Boolean(thread["actionable"])
        || (unreadCount > 0 && status !== "archived" && !["Promotions", "Social", "Updates", "Forums"].includes(category ?? ""));
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_threads
         (channel_id, thread_id, message_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        threadId,
        messageId,
        subject,
        from,
        snippet,
        unreadCount > 0 ? 1 : 0,
        status === "archived" ? 0 : 1,
        actionable ? 1 : 0,
        category,
        Date.now(),
      );
    }

    for (const [messageId, value] of folded.get("gmail.category") ?? []) {
      const category = record(value)["name"];
      if (typeof category !== "string" || !category) continue;
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_categories (channel_id, category, message_id) VALUES (?, ?, ?)`,
        channelId,
        category,
        messageId,
      );
    }
  }

  private setPollInterval(channelId: string, args: Record<string, unknown>): { pollIntervalMs: number } {
    const pollIntervalMs = Math.max(60_000, numberArg(args, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS);
    const state = this.getChannelState(channelId);
    state.pollIntervalMs = pollIntervalMs;
    this.saveChannelState(state);
    this.setAlarm(pollIntervalMs);
    return { pollIntervalMs };
  }

  private async syncChannel(channelId: string): Promise<{ ok: true; historyId: string; threadsUpdated: number }> {
    const state = this.getChannelState(channelId);
    if (!state.historyId) {
      const profile = await this.gmail.getProfile();
      state.historyId = profile.historyId;
      state.emailAddress = profile.emailAddress;
      state.lastSyncAt = Date.now();
      state.lastError = undefined;
      this.saveChannelState(state);
      await this.publishOverview(channelId, profile.emailAddress);
      return { ok: true, historyId: profile.historyId, threadsUpdated: 0 };
    }

    if (!state.emailAddress) {
      const profile = await this.gmail.getProfile();
      state.emailAddress = profile.emailAddress;
    }
    const diff = await this.gmail.syncSince(state.historyId);
    for (const thread of diff.threads) {
      await this.refreshThread(channelId, thread.threadId, state.emailAddress);
    }
    state.historyId = diff.historyId;
    state.lastSyncAt = Date.now();
    state.lastError = undefined;
    this.saveChannelState(state);
    await this.publishOverview(channelId);
    return { ok: true, historyId: diff.historyId, threadsUpdated: diff.threads.length };
  }

  private recordSyncError(channelId: string, err: unknown): void {
    const state = this.getChannelState(channelId);
    state.lastSyncAt = Date.now();
    state.lastError = err instanceof Error ? err.message : String(err);
    this.saveChannelState(state);
  }

  private async refreshThread(channelId: string, threadId: string, userEmail?: string): Promise<GmailThreadCardState> {
    const existing = this.threadRow(channelId, threadId);
    let thread: GmailThread;
    try {
      thread = await this.gmail.getThread(threadId, { format: "metadata", metadataHeaders: METADATA_HEADERS });
    } catch (err) {
      if (!existing || !isNotFoundError(err)) throw err;
      const archived = this.threadCardFromRow({ ...existing, unread: 0, in_inbox: 0, actionable: 0, updated_at: Date.now() });
      this.sql.exec(
        `UPDATE gmail_threads SET unread = 0, in_inbox = 0, actionable = 0, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
        archived.updatedAt,
        channelId,
        threadId,
      );
      if (existing.message_id) await this.updateCustom(channelId, existing.message_id, { kind: "statusChange", status: "archived" });
      return archived;
    }
    const card = threadCardState(thread, existing?.category, userEmail);
    const messageId = existing?.message_id ?? await this.publishCustom(channelId, "gmail.thread", card, "row");
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_threads
       (channel_id, thread_id, message_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      card.threadId,
      messageId,
      card.subject,
      card.from,
      card.snippet,
      card.unread ? 1 : 0,
      card.inInbox ? 1 : 0,
      card.actionable ? 1 : 0,
      card.category ?? null,
      card.updatedAt,
    );
    if (existing?.message_id) {
      await this.updateCustom(channelId, existing.message_id, card);
    }
    return card;
  }

  private threadRow(channelId: string, threadId: string): GmailThreadStateRow | null {
    return (this.sql
      .exec(`SELECT * FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`, channelId, threadId)
      .toArray()[0] as GmailThreadStateRow | undefined) ?? null;
  }

  private threadCardFromRow(row: GmailThreadStateRow): GmailThreadCardState {
    return {
      threadId: row.thread_id,
      subject: row.subject,
      from: row.from_addr,
      snippet: row.snippet,
      participants: row.from_addr ? [row.from_addr] : [],
      lastSnippet: row.snippet,
      unreadCount: row.unread === 1 ? 1 : 0,
      hasDraft: false,
      status: row.in_inbox === 1 || row.unread === 1 ? "unread" : "archived",
      unread: row.unread === 1,
      inInbox: row.in_inbox === 1,
      actionable: row.actionable === 1,
      ...(row.category ? { category: row.category } : {}),
      updatedAt: row.updated_at,
    };
  }

  private listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    const rows = this.sql.exec(
      `SELECT * FROM gmail_threads
       WHERE channel_id = ? AND actionable = 1
       ORDER BY updated_at DESC
       LIMIT ?`,
      channelId,
      Math.max(1, Math.min(limit, 25)),
    ).toArray() as unknown as GmailThreadStateRow[];
    return rows.map((row) => this.threadCardFromRow(row));
  }

  private async publishOverview(channelId: string, email?: string): Promise<void> {
    const state = this.getChannelState(channelId);
    const actionable = this.listActionableThreads(channelId, 8);
    const rows = this.sql.exec(
      `SELECT
        SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) AS inbox
       FROM gmail_threads WHERE channel_id = ?`,
      channelId,
    ).toArray()[0] ?? {};
    const payload: GmailInboxState = {
      email,
      unread: Number(rows["unread"] ?? 0),
      urgent: actionable.filter((thread) => thread.category === "urgent").length,
      draftCount: 0,
      perCategory: this.categoryCounts(channelId),
      actionable,
      lastSyncedAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : undefined,
      lastError: state.lastError,
    };
    const overviewJson = JSON.stringify(payload);
    if (!state.inboxMessageId) {
      state.inboxMessageId = await this.publishCustom(channelId, "gmail.inbox", payload, "row");
      state.lastOverviewJson = overviewJson;
      this.saveChannelState(state);
    } else if (state.lastOverviewJson !== overviewJson) {
      await this.updateCustom(channelId, state.inboxMessageId, payload);
      state.lastOverviewJson = overviewJson;
      this.saveChannelState(state);
    }
    await this.publishCategories(channelId);
  }

  private async categorize(channelId: string, args: Record<string, unknown>): Promise<{ threadId: string; category: string }> {
    const threadId = stringArg(args, "threadId");
    const category = stringArg(args, "category");
    if (!threadId || !category) throw new Error("categorize requires threadId and category");
    this.sql.exec(
      `UPDATE gmail_threads SET category = ?, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
      category,
      Date.now(),
      channelId,
      threadId,
    );
    const row = this.threadRow(channelId, threadId);
    if (row?.message_id) {
      await this.updateCustom(channelId, row.message_id, this.threadCardFromRow({ ...row, category, updated_at: Date.now() }));
    }
    await this.publishOverview(channelId);
    return { threadId, category };
  }

  private categoryCounts(channelId: string): Record<string, number> {
    const rows = this.sql.exec(
      `SELECT category, COUNT(*) AS count
       FROM gmail_threads
       WHERE channel_id = ? AND category IS NOT NULL
       GROUP BY category`,
      channelId,
    ).toArray();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const category = row["category"];
      if (typeof category === "string" && category) counts[category] = Number(row["count"] ?? 0);
    }
    return counts;
  }

  private async publishCategories(channelId: string): Promise<void> {
    const categories = Object.keys(this.categoryCounts(channelId));
    for (const category of categories) {
      const rows = this.sql.exec(
        `SELECT * FROM gmail_threads
         WHERE channel_id = ? AND category = ?
         ORDER BY updated_at DESC
         LIMIT 10`,
        channelId,
        category,
      ).toArray() as unknown as GmailThreadStateRow[];
      const payload = {
        name: category,
        unread: rows.filter((row) => row.unread === 1).length,
        threads: rows.map((row) => ({
          threadId: row.thread_id,
          subject: row.subject,
          unreadCount: row.unread === 1 ? 1 : 0,
        })),
      };
      const existing = this.sql.exec(
        `SELECT message_id FROM gmail_categories WHERE channel_id = ? AND category = ?`,
        channelId,
        category,
      ).toArray()[0]?.["message_id"] as string | undefined;
      if (existing) {
        await this.updateCustom(channelId, existing, payload);
      } else {
        const messageId = await this.publishCustom(channelId, "gmail.category", payload, "row");
        this.sql.exec(
          `INSERT OR REPLACE INTO gmail_categories (channel_id, category, message_id) VALUES (?, ?, ?)`,
          channelId,
          category,
          messageId,
        );
      }
    }
  }

  private async compose(channelId: string, args: Record<string, unknown>): Promise<{ messageId: string }> {
    const state: GmailComposeState = {
      to: stringArg(args, "to"),
      subject: stringArg(args, "subject"),
      body: stringArg(args, "body"),
      threadId: stringArg(args, "threadId"),
      sourceThreadId: stringArg(args, "sourceThreadId"),
      status: "draft",
    };
    return { messageId: await this.publishCustom(channelId, "gmail.compose", state, "row") };
  }

  private async draftReply(channelId: string, args: Record<string, unknown>): Promise<{ messageId: string; body: string }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("draftReply requires threadId");
    const thread = await this.gmail.getThread(threadId, { format: "full" });
    const latest = latestMessage(thread);
    const subject = header(latest ?? {} as GmailMessage, "Subject") ?? "";
    const to = header(latest ?? {} as GmailMessage, "From") ?? "";
    const body = await this.generateDraftReplyBody(channelId, thread);
    const messageId = await this.publishCustom(channelId, "gmail.compose", {
      to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      body,
      threadId,
      sourceThreadId: threadId,
      status: "draft",
    } satisfies GmailComposeState, "row");
    return { messageId, body };
  }

  private async resolveReplySendArgs(args: Record<string, unknown>): Promise<{
    to: string;
    subject: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }> {
    const threadId = stringArg(args, "threadId");
    const explicitTo = stringArg(args, "to");
    const explicitSubject = stringArg(args, "subject");
    if (!threadId) {
      if (!explicitTo || !explicitSubject) throw new Error("send requires to and subject");
      return { to: explicitTo, subject: explicitSubject };
    }
    const thread = await this.gmail.getThread(threadId, { format: "metadata", metadataHeaders: METADATA_HEADERS });
    const latest = latestMessage(thread);
    const threadSubject = header(latest ?? {} as GmailMessage, "Subject") ?? "";
    const subject = explicitSubject ?? (threadSubject.startsWith("Re:") ? threadSubject : `Re: ${threadSubject}`);
    const to = explicitTo ?? header(latest ?? {} as GmailMessage, "From") ?? "";
    if (!to || !subject) throw new Error("send could not resolve reply recipient and subject");
    return {
      to,
      subject,
      threadId,
      inReplyTo: header(latest ?? {} as GmailMessage, "Message-ID"),
      references: header(latest ?? {} as GmailMessage, "References") ?? header(latest ?? {} as GmailMessage, "Message-ID"),
    };
  }

  private async send(channelId: string, args: Record<string, unknown>): Promise<{ sent: true; id: string }> {
    const messageId = stringArg(args, "messageId");
    if (messageId) await this.updateCustom(channelId, messageId, { status: "sending" });
    try {
      const replyArgs = await this.resolveReplySendArgs(args);
      const sent = await this.gmail.sendMessage({
        to: replyArgs.to,
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      });
      if (messageId) await this.updateCustom(channelId, messageId, { status: "sent" });
      const sourceThreadId = stringArg(args, "sourceThreadId") ?? stringArg(args, "threadId");
      if (sourceThreadId) {
        await this.gmail.modifyLabels({ threadId: sourceThreadId, removeLabelIds: ["INBOX"] }).catch(() => undefined);
        await this.refreshThread(channelId, sourceThreadId, this.getChannelState(channelId).emailAddress).catch(() => undefined);
      }
      return { sent: true, id: sent.id };
    } catch (err) {
      if (messageId) await this.updateCustom(channelId, messageId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async search(channelId: string, args: Record<string, unknown>): Promise<{ messageId: string; count: number }> {
    const q = stringArg(args, "q");
    if (!q) throw new Error("search requires q");
    const result = await this.gmail.search(q, {
      maxResults: Math.max(1, Math.min(numberArg(args, "limit") ?? 10, 25)),
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const threads = result.messages.map((message) => ({
      threadId: message.threadId,
      subject: header(message, "Subject") ?? "(no subject)",
      from: header(message, "From") ?? "",
      snippet: message.snippet ?? "",
    }));
    const messageId = await this.publishCustom(channelId, "gmail.inbox", {
      search: q,
      unread: 0,
      urgent: 0,
      draftCount: 0,
      perCategory: {},
      actionable: threads,
      lastSyncedAt: new Date().toISOString(),
    }, "row");
    return { messageId, count: threads.length };
  }

  private async getThread(args: Record<string, unknown>): Promise<{ threadId: string; messages: Array<Record<string, unknown>> }> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("getThread requires threadId");
    const thread = await this.gmail.getThread(threadId, { format: "full" });
    return {
      threadId,
      messages: (thread.messages ?? []).map((message) => ({
        id: message.id,
        from: header(message, "From") ?? "",
        to: header(message, "To") ?? "",
        date: header(message, "Date") ?? "",
        subject: header(message, "Subject") ?? "",
        snippet: message.snippet ?? "",
        bodyText: textFromPart(message.payload).slice(0, 20_000),
      })),
    };
  }

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`Gmail agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "Gmail",
      metadata: { type: "agent", handle: "gmail", name: "Gmail" },
    };
  }

  private async publishCustom(
    channelId: string,
    typeId: string,
    initialState: unknown,
    displayMode: CustomMessageDisplayMode,
  ): Promise<string> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    const messageId = crypto.randomUUID();
    const event: AgenticEvent<"custom.started"> = {
      kind: "custom.started",
      actor,
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        typeId,
        displayMode,
        initialState,
        by: actor,
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `gmail:custom:start:${messageId}`,
      senderMetadata: actor.metadata,
    });
    return messageId;
  }

  private async updateCustom(channelId: string, messageId: string, update: unknown): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    const event: AgenticEvent<"custom.updated"> = {
      kind: "custom.updated",
      actor,
      causality: { messageId: messageId as MessageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        messageId: messageId as MessageId,
        update,
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `gmail:custom:update:${messageId}:${crypto.randomUUID()}`,
      senderMetadata: actor.metadata,
    });
  }
}
