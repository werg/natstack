import type { SqlStorage } from "@workspace/runtime/worker";
import { isGmailApiError, type GmailClient, type GmailMessage, type GmailThread } from "@workspace/gmail";
import type {
  GmailAttentionDirective,
  GmailAttentionRuleSet,
  GmailComposeCardState,
  GmailContactCandidate,
  GmailThreadCardState,
} from "@workspace/gmail/card-types";
import { failureResult, handleGmailError } from "../errors.js";
import {
  GMAIL_ATTENTION_ACTIONS,
  GMAIL_ATTENTION_FIELDS,
  GMAIL_ATTENTION_OPERATORS,
  GMAIL_ATTENTION_SCOPES,
  defaultAttentionRules,
  slug,
  validateAttentionRules,
} from "../attention/rules.js";
import type { AttentionEngine } from "../attention/attention-engine.js";
import type { SyncEngine, SyncResult } from "../sync/sync-engine.js";
import type { GmailCards } from "../cards/cards.js";
import {
  METADATA_HEADERS,
  header,
  latestMessage,
  normalizeEmailAddress,
  parseAddressList,
  searchResultCardState,
  textFromPart,
} from "../sync/thread-model.js";
import type { PeopleStore, PersonCandidate } from "../people/people-store.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  booleanArg,
  gmailAgentObjectKey,
  numberArg,
  record,
  stringArg,
  type GmailChannelState,
} from "../types.js";

export interface GmailAttentionRulesSnapshot {
  channelId: string;
  rules: GmailAttentionDirective[];
  ruleSet: GmailAttentionRuleSet;
  updatedAt: number;
  capabilities: {
    fields: typeof GMAIL_ATTENTION_FIELDS;
    operators: typeof GMAIL_ATTENTION_OPERATORS;
    actions: typeof GMAIL_ATTENTION_ACTIONS;
    scopes: typeof GMAIL_ATTENTION_SCOPES;
  };
  rpc: {
    source: "workers/gmail-agent";
    className: "GmailAgentWorker";
    objectKey: string;
    resolveMethod: "workers.resolveDurableObject";
  };
}

export interface GmailHandlersDeps {
  sql: SqlStorage;
  gmailFor: (channelId: string) => GmailClient;
  sync: SyncEngine;
  attention: AttentionEngine;
  people: PeopleStore;
  cards: GmailCards;
  getChannelState: (channelId: string) => GmailChannelState;
  saveChannelState: (state: GmailChannelState) => void;
  publishOverview: (channelId: string, email?: string) => Promise<void>;
  publishSetup: (channelId: string) => Promise<void>;
  setPollAlarm: (ms: number) => void;
  generateDraftReplyBody: (channelId: string, thread: GmailThread) => Promise<string>;
  isSubscribed: (channelId: string) => boolean;
}

/**
 * The single implementation layer for every Gmail operation. Both the runner
 * tools and onMethodCall dispatch route here, so behavior cannot drift
 * between the two surfaces.
 */
export class GmailHandlers {
  constructor(private readonly deps: GmailHandlersDeps) {}

  // ── inbox & sync ──────────────────────────────────────────────────────────

  /** Always attempts (even when auth-needed) so reconnect recovery works. */
  async checkInbox(channelId: string): Promise<SyncResult | ReturnType<typeof failureResult>> {
    const result = await this.deps.sync.syncChannel(channelId);
    if (!result.ok) return failureResult(result.error);
    return result;
  }

  async markConfigured(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ configured: true; configuredAt: string; summary?: string }> {
    const state = this.deps.getChannelState(channelId);
    const summary = stringArg(args, "summary")?.slice(0, 500);
    state.setupStatus = "configured";
    state.configuredAt = Date.now();
    state.setupSummary = summary;
    this.deps.saveChannelState(state);
    await this.deps.publishOverview(channelId);
    await this.deps.publishSetup(channelId);
    return {
      configured: true,
      configuredAt: new Date(state.configuredAt).toISOString(),
      ...(summary ? { summary } : {}),
    };
  }

  setPollInterval(channelId: string, args: Record<string, unknown>): { pollIntervalMs: number } {
    const pollIntervalMs = Math.max(
      60_000,
      numberArg(args, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS
    );
    const state = this.deps.getChannelState(channelId);
    state.pollIntervalMs = pollIntervalMs;
    this.deps.saveChannelState(state);
    this.deps.setPollAlarm(pollIntervalMs);
    return { pollIntervalMs };
  }

  /**
   * Re-verify the Google credential by attempting a sync; a success clears
   * the auth-needed state, a failure keeps the reconnect banner up.
   */
  async reconnect(channelId: string): Promise<{
    ok: boolean;
    auth: { status: "ok" | "reconnect-required" };
    error?: string;
  }> {
    const result = await this.deps.sync.syncChannel(channelId);
    const state = this.deps.getChannelState(channelId);
    await this.deps.publishSetup(channelId);
    return {
      ok: result.ok,
      auth: { status: state.syncState === "auth-needed" ? "reconnect-required" : "ok" },
      ...(result.ok ? {} : { error: result.error.message }),
    };
  }

  /** Publish (or refresh) a standalone thread card so the channel focuses it. */
  async openThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; opened: true } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("openThread requires threadId");
    let card: GmailThreadCardState;
    try {
      card = await this.deps.sync.refreshThread(
        channelId,
        threadId,
        this.deps.getChannelState(channelId).emailAddress
      );
    } catch (err) {
      return await this.failGmail(channelId, "openThread", err);
    }
    await this.deps.cards.publishThread(channelId, card);
    return { threadId, opened: true };
  }

  listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    return this.deps.sync.listActionableThreads(channelId, limit);
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | {
        count: number;
        query: string;
        results: Array<{
          threadId: string;
          subject: string;
          from?: string;
          fromEmail?: string;
          snippet: string;
          unread: boolean;
          date?: string;
        }>;
      }
    | ReturnType<typeof failureResult>
  > {
    const q = stringArg(args, "q");
    if (!q) throw new Error("search requires q");
    try {
      const gmail = this.deps.gmailFor(channelId);
      const result = await gmail.search(q, {
        maxResults: Math.max(1, Math.min(numberArg(args, "limit") ?? 10, 25)),
        format: "metadata",
        metadataHeaders: METADATA_HEADERS,
      });
      const threads = result.messages.map(searchResultCardState);
      const state = this.deps.getChannelState(channelId);
      state.lastSearchQuery = q;
      state.lastSearchJson = JSON.stringify(threads);
      this.deps.saveChannelState(state);
      await this.deps.publishOverview(channelId);
      // Return the actual results, not just a count: the caller (model or
      // another agent) must be able to act on them directly instead of
      // peeking at the inbox card's UI state.
      return {
        query: q,
        count: threads.length,
        results: threads.map((thread) => ({
          threadId: thread.threadId,
          subject: thread.subject,
          ...(thread.from ? { from: thread.from } : {}),
          // Bare parsed address alongside the display string so callers can
          // address mail without re-parsing the header themselves.
          ...(normalizeEmailAddress(thread.from)
            ? { fromEmail: normalizeEmailAddress(thread.from) }
            : {}),
          snippet: thread.lastSnippet,
          unread: thread.unreadCount > 0,
          date: new Date(thread.updatedAt).toISOString(),
        })),
      };
    } catch (err) {
      return await this.failGmail(channelId, "search", err);
    }
  }

  async clearSearch(channelId: string): Promise<{ cleared: true }> {
    const state = this.deps.getChannelState(channelId);
    state.lastSearchQuery = undefined;
    state.lastSearchJson = undefined;
    this.deps.saveChannelState(state);
    await this.deps.publishOverview(channelId);
    return { cleared: true };
  }

  // ── contact resolution ────────────────────────────────────────────────────

  /**
   * Resolve a person name to recipient candidates. Derived mail-history
   * store first; when it has nothing, fall back to the Google address book
   * (People API). Missing People scopes degrade gracefully: the failure is
   * remembered per channel (people_api_status) and surfaced on the setup
   * card instead of erroring the call.
   */
  async resolveContact(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ query: string; candidates: GmailContactCandidate[] }> {
    const name = stringArg(args, "name");
    if (!name) throw new Error("resolveContact requires name");
    const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 5, 10));
    const fromHistory = this.deps.people
      .resolve(channelId, name, limit)
      .map((candidate) => historyCandidate(candidate));
    if (fromHistory.length > 0) return { query: name, candidates: fromHistory };

    const state = this.deps.getChannelState(channelId);
    if (state.peopleApiStatus === "unavailable") return { query: name, candidates: [] };
    try {
      const gmail = this.deps.gmailFor(channelId);
      const contacts = await gmail.searchContacts(name, { pageSize: limit });
      const others =
        contacts.length >= limit ? [] : await gmail.searchOtherContacts(name, { pageSize: limit });
      const seen = new Set<string>();
      const candidates: GmailContactCandidate[] = [];
      for (const contact of [...contacts, ...others]) {
        if (seen.has(contact.email)) continue;
        seen.add(contact.email);
        candidates.push({
          email: contact.email,
          ...(contact.displayName ? { displayName: contact.displayName } : {}),
          sentTo: 0,
          receivedFrom: 0,
          youReplied: false,
          source: "google-contacts",
          score: 0,
        });
        if (candidates.length >= limit) break;
      }
      await this.setPeopleApiStatus(channelId, "ok");
      return { query: name, candidates };
    } catch (err) {
      if (isGmailApiError(err, "forbidden") || isGmailApiError(err, "auth-expired")) {
        await this.setPeopleApiStatus(channelId, "unavailable");
        return { query: name, candidates: [] };
      }
      throw err;
    }
  }

  /** Derived-store-only typeahead — never touches the network. */
  contactSuggest(
    channelId: string,
    args: Record<string, unknown>
  ): { prefix: string; candidates: GmailContactCandidate[] } {
    const prefix = stringArg(args, "prefix");
    if (!prefix) return { prefix: "", candidates: [] };
    const limit = Math.max(1, Math.min(numberArg(args, "limit") ?? 5, 10));
    return {
      prefix,
      candidates: this.deps.people
        .suggest(channelId, prefix, limit)
        .map((candidate) => historyCandidate(candidate)),
    };
  }

  private async setPeopleApiStatus(channelId: string, status: "ok" | "unavailable"): Promise<void> {
    const state = this.deps.getChannelState(channelId);
    if (state.peopleApiStatus === status) return;
    state.peopleApiStatus = status;
    this.deps.saveChannelState(state);
    await this.deps.publishSetup(channelId).catch(() => undefined);
  }

  // ── thread operations ─────────────────────────────────────────────────────

  async getThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { threadId: string; messages: Array<Record<string, unknown>> }
    | ReturnType<typeof failureResult>
  > {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("getThread requires threadId");
    try {
      const gmail = this.deps.gmailFor(channelId);
      const thread = await gmail.getThread(threadId, { format: "full" });
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
    } catch (err) {
      return await this.failGmail(channelId, "getThread", err);
    }
  }

  async archiveThread(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; archived: true } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("archiveThread requires threadId");
    try {
      const gmail = this.deps.gmailFor(channelId);
      await gmail.modifyLabels({ threadId, removeLabelIds: ["INBOX"] });
    } catch (err) {
      return await this.failGmail(channelId, "archiveThread", err);
    }
    await this.deps.sync.applyLocalThreadFlags(channelId, threadId, {
      inInbox: false,
      actionable: false,
      status: "archived",
    });
    await this.deps.publishOverview(channelId);
    return { threadId, archived: true };
  }

  async markRead(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; read: true } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("markRead requires threadId");
    try {
      const gmail = this.deps.gmailFor(channelId);
      await gmail.modifyLabels({ threadId, removeLabelIds: ["UNREAD"] });
    } catch (err) {
      return await this.failGmail(channelId, "markRead", err);
    }
    await this.deps.sync.applyLocalThreadFlags(channelId, threadId, {
      unread: false,
      actionable: false,
      status: "open",
    });
    await this.deps.publishOverview(channelId);
    return { threadId, read: true };
  }

  async categorize(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ threadId: string; category: string }> {
    const threadId = stringArg(args, "threadId");
    const category = stringArg(args, "category");
    if (!threadId || !category) throw new Error("categorize requires threadId and category");
    this.deps.sql.exec(
      `UPDATE gmail_threads SET category = ?, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
      category,
      Date.now(),
      channelId,
      threadId
    );
    await this.deps.cards.updateThread(channelId, threadId, { category });
    await this.deps.publishOverview(channelId);
    return { threadId, category };
  }

  // ── compose / send ────────────────────────────────────────────────────────

  async compose(channelId: string, args: Record<string, unknown>): Promise<{ messageId: string }> {
    const state: GmailComposeCardState = {
      to: stringArg(args, "to"),
      cc: stringArg(args, "cc"),
      bcc: stringArg(args, "bcc"),
      subject: stringArg(args, "subject"),
      body: stringArg(args, "body"),
      threadId: stringArg(args, "threadId"),
      sourceThreadId: stringArg(args, "sourceThreadId"),
      status: "drafting",
      ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
    };
    const handle = await this.deps.cards.createCompose(channelId, state);
    return { messageId: handle.messageId };
  }

  /**
   * Multi-agent draft request: produce a compose card in "review" without
   * sending. Only the user's Send click (or an explicit user instruction to
   * this agent) ever sends mail.
   */
  async requestDraft(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ messageId: string; status: "review" } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (threadId) {
      const result = await this.draftReply(channelId, { threadId });
      if ("error" in result) return result;
      return { messageId: result.messageId, status: "review" };
    }
    const intent = stringArg(args, "intent");
    if (!intent) throw new Error("requestDraft requires threadId or intent");
    const handle = await this.deps.cards.createCompose(channelId, {
      to: stringArg(args, "to"),
      subject: stringArg(args, "subject"),
      body: intent,
      status: "review",
    });
    return { messageId: handle.messageId, status: "review" };
  }

  async draftReply(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ messageId: string; body: string } | ReturnType<typeof failureResult>> {
    const threadId = stringArg(args, "threadId");
    if (!threadId) throw new Error("draftReply requires threadId");
    let thread: GmailThread;
    try {
      const gmail = this.deps.gmailFor(channelId);
      thread = await gmail.getThread(threadId, { format: "full" });
    } catch (err) {
      return await this.failGmail(channelId, "draftReply", err);
    }
    const latest = latestMessage(thread);
    const subject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const to = header(latest ?? ({} as GmailMessage), "From") ?? "";
    const body = await this.deps.generateDraftReplyBody(channelId, thread);
    // Agent-generated drafts always land in review; the user's Send click on
    // the compose card is the authorization to send.
    const handle = await this.deps.cards.createCompose(channelId, {
      to,
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      body,
      threadId,
      sourceThreadId: threadId,
      status: "review",
      ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
    });
    return { messageId: handle.messageId, body };
  }

  private async resolveReplySendArgs(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{
    to: string;
    cc?: string;
    bcc?: string;
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
      return {
        to: explicitTo,
        ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
        ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
        subject: explicitSubject,
      };
    }
    const gmail = this.deps.gmailFor(channelId);
    const thread = await gmail.getThread(threadId, {
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const latest = latestMessage(thread);
    const threadSubject = header(latest ?? ({} as GmailMessage), "Subject") ?? "";
    const subject =
      explicitSubject ?? (threadSubject.startsWith("Re:") ? threadSubject : `Re: ${threadSubject}`);
    const to = explicitTo ?? header(latest ?? ({} as GmailMessage), "From") ?? "";
    if (!to || !subject) throw new Error("send could not resolve reply recipient and subject");
    return {
      to,
      ...(stringArg(args, "cc") ? { cc: stringArg(args, "cc") } : {}),
      ...(stringArg(args, "bcc") ? { bcc: stringArg(args, "bcc") } : {}),
      subject,
      threadId,
      inReplyTo: header(latest ?? ({} as GmailMessage), "Message-ID"),
      references:
        header(latest ?? ({} as GmailMessage), "References") ??
        header(latest ?? ({} as GmailMessage), "Message-ID"),
    };
  }

  async send(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ sent: true; id: string } | ReturnType<typeof failureResult>> {
    const messageId = stringArg(args, "messageId");
    await this.deps.cards.updateCompose(channelId, messageId, { status: "sending" });
    try {
      const gmail = this.deps.gmailFor(channelId);
      const replyArgs = await this.resolveReplySendArgs(channelId, args);
      const sent = await gmail.sendMessage({
        to: replyArgs.to,
        ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
        ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      });
      for (const email of parseAddressList([replyArgs.to, replyArgs.cc ?? "", replyArgs.bcc ?? ""])) {
        this.deps.attention.recordRepliedSender(channelId, email, email, "send");
        this.deps.people.markReplied(channelId, email);
      }
      this.deps.people.recordOutgoing(
        channelId,
        parseAddressList([replyArgs.to, replyArgs.cc ?? ""]).map((email) => ({ email })),
        Date.now()
      );
      await this.deps.cards.updateCompose(channelId, messageId, { status: "sent" });
      const sourceThreadId = stringArg(args, "sourceThreadId") ?? stringArg(args, "threadId");
      if (sourceThreadId) {
        await gmail
          .modifyLabels({ threadId: sourceThreadId, removeLabelIds: ["INBOX"] })
          .catch(() => undefined);
        await this.deps.sync
          .refreshThread(channelId, sourceThreadId, this.deps.getChannelState(channelId).emailAddress)
          .catch(() => undefined);
        await this.deps.sync.applyLocalThreadFlags(channelId, sourceThreadId, {
          inInbox: false,
          actionable: false,
          status: "archived",
        });
        if (this.deps.isSubscribed(channelId)) await this.deps.publishOverview(channelId);
      }
      return { sent: true, id: sent.id };
    } catch (err) {
      // Recoverable compose error: keep the card editable with an error badge.
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return await this.failGmail(channelId, "send", err);
    }
  }

  async saveDraft(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<
    | { saved: true; draftId: string }
    | { ok: true; composeId: string; cardCreated: boolean; note: string }
    | ReturnType<typeof failureResult>
  > {
    const messageId = stringArg(args, "messageId");
    // Forgiving compose: a draft without a resolvable recipient is not an
    // error — park it on a compose card in "drafting" so the user (or a
    // later resolveContact call) can fill the To field.
    if (!stringArg(args, "threadId") && (!stringArg(args, "to") || !stringArg(args, "subject"))) {
      const patch: Partial<GmailComposeCardState> = {
        status: "drafting",
        to: stringArg(args, "to"),
        cc: stringArg(args, "cc"),
        bcc: stringArg(args, "bcc"),
        subject: stringArg(args, "subject"),
        body: stringArg(args, "body"),
        ...(candidatesArg(args) ? { toCandidates: candidatesArg(args) } : {}),
      };
      let composeId = messageId;
      let cardCreated = false;
      if (composeId && this.deps.cards.composeByMessageId(channelId, composeId)) {
        await this.deps.cards.updateCompose(channelId, composeId, patch);
      } else {
        const handle = await this.deps.cards.createCompose(channelId, {
          ...patch,
          status: "drafting",
        });
        composeId = handle.messageId;
        cardCreated = true;
      }
      return {
        ok: true,
        composeId,
        cardCreated,
        note:
          "No recipient yet — resolve with gmail_resolveContact or let the user fill the To field on the card (it has address autocomplete).",
      };
    }
    try {
      const gmail = this.deps.gmailFor(channelId);
      const replyArgs = await this.resolveReplySendArgs(channelId, args);
      const draft = await gmail.createDraft({
        to: replyArgs.to,
        ...(replyArgs.cc ? { cc: replyArgs.cc } : {}),
        ...(replyArgs.bcc ? { bcc: replyArgs.bcc } : {}),
        subject: replyArgs.subject,
        body: stringArg(args, "body") ?? "",
        ...(replyArgs.threadId ? { threadId: replyArgs.threadId } : {}),
        ...(replyArgs.inReplyTo ? { inReplyTo: replyArgs.inReplyTo } : {}),
        ...(replyArgs.references ? { references: replyArgs.references } : {}),
      });
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "saved",
        draftId: draft.id,
      });
      return { saved: true, draftId: draft.id };
    } catch (err) {
      await this.deps.cards.updateCompose(channelId, messageId, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return await this.failGmail(channelId, "saveDraft", err);
    }
  }

  async discardCompose(
    channelId: string,
    args: Record<string, unknown>
  ): Promise<{ discarded: true }> {
    const messageId = stringArg(args, "messageId");
    await this.deps.cards.updateCompose(channelId, messageId, { status: "discarded" });
    return { discarded: true };
  }

  // ── attention rules ───────────────────────────────────────────────────────

  listAttentionRules(channelId: string): GmailAttentionRulesSnapshot {
    const ruleRecord = this.deps.attention.getRulesRecord(channelId);
    return {
      channelId,
      rules: ruleRecord.ruleSet.directives,
      ruleSet: ruleRecord.ruleSet,
      updatedAt: ruleRecord.updatedAt,
      capabilities: {
        fields: GMAIL_ATTENTION_FIELDS,
        operators: GMAIL_ATTENTION_OPERATORS,
        actions: GMAIL_ATTENTION_ACTIONS,
        scopes: GMAIL_ATTENTION_SCOPES,
      },
      rpc: {
        source: "workers/gmail-agent",
        className: "GmailAgentWorker",
        objectKey: gmailAgentObjectKey(channelId),
        resolveMethod: "workers.resolveDurableObject",
      },
    };
  }

  async upsertAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    const input = record(args);
    const rawRule = input["rule"] ?? input["directive"] ?? input;
    const rule = validateAttentionRules({ version: 1, directives: [rawRule] }).directives[0]!;
    const current = this.deps.attention.getRulesRecord(channelId).ruleSet;
    const directives = [
      ...current.directives.filter((directive) => directive.id !== rule.id),
      rule,
    ].sort((a, b) => b.priority - a.priority);
    const ruleSet = validateAttentionRules({ version: 1, directives });
    await this.applyRuleSet(channelId, ruleSet);
    return { saved: true, rule, ruleSet };
  }

  async setAttentionRuleEnabled(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    const input = record(args);
    const id = slug(stringArg(input, "id") ?? "");
    if (!id) throw new Error("setAttentionRuleEnabled requires id");
    const enabled = booleanArg(input, "enabled");
    if (enabled === undefined) throw new Error("setAttentionRuleEnabled requires enabled");
    const current = this.deps.attention.getRulesRecord(channelId).ruleSet;
    const rule = current.directives.find((directive) => directive.id === id);
    if (!rule) throw new Error(`attention rule not found: ${id}`);
    const ruleSet = validateAttentionRules({
      version: 1,
      directives: current.directives.map((directive) =>
        directive.id === id ? { ...directive, enabled } : directive
      ),
    });
    await this.applyRuleSet(channelId, ruleSet);
    return {
      saved: true,
      rule: ruleSet.directives.find((directive) => directive.id === id)!,
      ruleSet,
    };
  }

  async deleteAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ deleted: true; id: string; ruleSet: GmailAttentionRuleSet }> {
    const id = slug(stringArg(record(args), "id") ?? "");
    if (!id) throw new Error("deleteAttentionRule requires id");
    const current = this.deps.attention.getRulesRecord(channelId).ruleSet;
    const ruleSet = validateAttentionRules({
      version: 1,
      directives: current.directives.filter((directive) => directive.id !== id),
    });
    if (ruleSet.directives.length === current.directives.length) {
      throw new Error(`attention rule not found: ${id}`);
    }
    await this.applyRuleSet(channelId, ruleSet);
    return { deleted: true, id, ruleSet };
  }

  async clearAttentionRules(channelId: string): Promise<{
    cleared: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    const ruleSet = validateAttentionRules({ version: 1, directives: [] });
    await this.applyRuleSet(channelId, ruleSet);
    return { cleared: true, ruleSet, rules: [] };
  }

  async resetAttentionRules(channelId: string): Promise<{
    reset: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    const ruleSet = defaultAttentionRules();
    await this.applyRuleSet(channelId, ruleSet);
    return { reset: true, ruleSet, rules: ruleSet.directives };
  }

  private async applyRuleSet(channelId: string, ruleSet: GmailAttentionRuleSet): Promise<void> {
    this.deps.attention.saveRules(channelId, ruleSet);
    await this.deps.sync.recomputeAttentionForStoredThreads(channelId);
    await this.deps.publishOverview(channelId);
    await this.deps.publishSetup(channelId);
  }

  // ── error policy ──────────────────────────────────────────────────────────

  /**
   * Convert a thrown GmailApiError into a structured tool result. Auth errors
   * additionally pause polling and surface a reconnect banner on the inbox
   * card. Non-Gmail errors are rethrown.
   */
  private async failGmail(
    channelId: string,
    operation: string,
    err: unknown
  ): Promise<ReturnType<typeof failureResult>> {
    const failure = handleGmailError({ channelId, operation }, err);
    if (!failure) throw err;
    if (failure.kind === "auth") {
      const state = this.deps.getChannelState(channelId);
      if (state.syncState !== "auth-needed") {
        state.syncState = "auth-needed";
        this.deps.saveChannelState(state);
        await this.deps.publishOverview(channelId).catch(() => undefined);
        await this.deps.publishSetup(channelId).catch(() => undefined);
      }
      return failureResult(failure);
    }
    if (failure.kind === "rate-limited") {
      return failureResult(failure);
    }
    throw err;
  }
}

function historyCandidate(candidate: PersonCandidate): GmailContactCandidate {
  return { ...candidate, source: "history" };
}

/** Sanitize an agent-supplied toCandidates array for compose card state. */
export function candidatesArg(args: Record<string, unknown>): GmailContactCandidate[] | undefined {
  const raw = args["toCandidates"];
  if (!Array.isArray(raw)) return undefined;
  const candidates = raw
    .map((item) => record(item))
    .filter((item) => typeof item["email"] === "string" && item["email"])
    .map((item) => ({
      email: String(item["email"]).toLowerCase(),
      ...(typeof item["displayName"] === "string" && item["displayName"]
        ? { displayName: item["displayName"] }
        : {}),
      sentTo: typeof item["sentTo"] === "number" ? item["sentTo"] : 0,
      receivedFrom: typeof item["receivedFrom"] === "number" ? item["receivedFrom"] : 0,
      ...(typeof item["lastInteractionAt"] === "number"
        ? { lastInteractionAt: item["lastInteractionAt"] }
        : {}),
      youReplied: item["youReplied"] === true,
      source: item["source"] === "google-contacts" ? ("google-contacts" as const) : ("history" as const),
      score: typeof item["score"] === "number" ? item["score"] : 0,
    }));
  return candidates.length > 0 ? candidates : undefined;
}
