import type { SqlStorage } from "@workspace/runtime/worker";
import { isGmailApiError, type GmailClient, type GmailThread } from "@workspace/gmail";
import type { GmailAttentionDecision, GmailThreadCardState } from "@workspace/gmail/card-types";
import { handleGmailError, type GmailFailure } from "../errors.js";
import type { AttentionEngine } from "../attention/attention-engine.js";
import { evaluateAttentionRules, type GmailAttentionEvent } from "../attention/rules.js";
import type { GmailCards } from "../cards/cards.js";
import { parseAddressEntries } from "../people/address.js";
import type { PeopleStore } from "../people/people-store.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  INITIAL_THREAD_LOAD_LIMIT,
  type GmailChannelState,
  type GmailThreadStateRow,
} from "../types.js";
import {
  METADATA_HEADERS,
  attentionEventFromThread,
  header,
  threadCardFromRow,
  threadCardState,
} from "./thread-model.js";

const MAX_TRANSIENT_RETRIES = 2;
const RATE_LIMIT_BASE_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60 * 1000;

export type SyncResult =
  | { ok: true; historyId: string; threadsUpdated: number }
  | { ok: false; error: GmailFailure };

export interface SyncEngineDeps {
  sql: SqlStorage;
  gmailFor: (channelId: string) => GmailClient;
  attention: AttentionEngine;
  people: PeopleStore;
  cards: GmailCards;
  getChannelState: (channelId: string) => GmailChannelState;
  saveChannelState: (state: GmailChannelState) => void;
  publishOverview: (channelId: string, email?: string) => Promise<void>;
  startAttentionTurn: (
    channelId: string,
    event: GmailAttentionEvent,
    decision: GmailAttentionDecision
  ) => Promise<void>;
  /** Schedule the poll alarm to fire in `ms` (earliest-wins). */
  schedulePoll: (ms: number) => void;
  now?: () => number;
}

/**
 * History-based incremental Gmail sync into the local thread cache, with the
 * Task B failure policy: auth errors pause polling, rate limits back off,
 * network/server errors retry then surface lastError.
 */
export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

  private get sql(): SqlStorage {
    return this.deps.sql;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async syncChannel(channelId: string): Promise<SyncResult> {
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.syncOnce(channelId);
        this.clearFailureState(channelId);
        await this.deps.publishOverview(channelId);
        return result;
      } catch (err) {
        if (
          (isGmailApiError(err, "network") || isGmailApiError(err, "server")) &&
          attempt < MAX_TRANSIENT_RETRIES
        ) {
          attempt += 1;
          continue;
        }
        const failure = handleGmailError({ channelId, operation: "sync" }, err);
        if (!failure) throw err;
        await this.recordSyncFailure(channelId, failure);
        return { ok: false, error: failure };
      }
    }
  }

  private async syncOnce(
    channelId: string
  ): Promise<{ ok: true; historyId: string; threadsUpdated: number }> {
    const state = this.deps.getChannelState(channelId);
    const gmail = this.deps.gmailFor(channelId);
    if (!state.historyId) {
      const profile = await gmail.getProfile();
      state.historyId = profile.historyId;
      state.emailAddress = profile.emailAddress;
      state.lastSyncAt = this.now();
      state.lastError = undefined;
      this.deps.saveChannelState(state);
      await this.seedRepliedSendersFromSentMail(channelId).catch(() => undefined);
      await this.bootstrapRecentThreads(channelId, profile.emailAddress);
      return { ok: true, historyId: profile.historyId, threadsUpdated: 0 };
    }

    if (!state.emailAddress) {
      const profile = await gmail.getProfile();
      state.emailAddress = profile.emailAddress;
    }
    const diff = await gmail.syncSince(state.historyId);
    for (const thread of diff.threads) {
      await this.refreshThread(channelId, thread.threadId, state.emailAddress, {
        allowWake: true,
      });
    }
    state.historyId = diff.historyId;
    state.lastSyncAt = this.now();
    state.lastError = undefined;
    this.deps.saveChannelState(state);
    return { ok: true, historyId: diff.historyId, threadsUpdated: diff.threads.length };
  }

  /** Apply the failure policy to persisted channel state + inbox card. */
  private async recordSyncFailure(channelId: string, failure: GmailFailure): Promise<void> {
    const state = this.deps.getChannelState(channelId);
    state.lastSyncAt = this.now();
    if (failure.kind === "auth") {
      // Poll alarm scheduling skips auth-needed channels until checkNow succeeds.
      state.syncState = "auth-needed";
      state.lastError = failure.message;
    } else if (failure.kind === "rate-limited") {
      const backoff = Math.min(
        failure.retryAfterMs ?? Math.max((state.backoffMs ?? 0) * 2, RATE_LIMIT_BASE_BACKOFF_MS),
        RATE_LIMIT_MAX_BACKOFF_MS
      );
      state.backoffMs = backoff;
      state.rateLimitedUntil = this.now() + backoff;
      this.deps.schedulePoll(backoff);
    } else {
      state.lastError = failure.message;
    }
    this.deps.saveChannelState(state);
    await this.deps.publishOverview(channelId).catch(() => undefined);
  }

  private clearFailureState(channelId: string): void {
    const state = this.deps.getChannelState(channelId);
    if (
      state.syncState === "ok" &&
      state.rateLimitedUntil === undefined &&
      state.backoffMs === undefined &&
      state.lastError === undefined
    ) {
      return;
    }
    state.syncState = "ok";
    state.rateLimitedUntil = undefined;
    state.backoffMs = undefined;
    state.lastError = undefined;
    this.deps.saveChannelState(state);
  }

  async bootstrapRecentThreads(channelId: string, userEmail: string): Promise<void> {
    const gmail = this.deps.gmailFor(channelId);
    const result = await gmail.listMessages({
      maxResults: INITIAL_THREAD_LOAD_LIMIT,
      labelIds: ["INBOX"],
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    const threadIds = Array.from(
      new Set(
        result.messages
          .map((message) => message.threadId)
          .filter((threadId): threadId is string => Boolean(threadId))
      )
    );
    for (const threadId of threadIds) {
      await this.refreshThread(channelId, threadId, userEmail);
    }
  }

  async seedRepliedSendersFromSentMail(channelId: string): Promise<void> {
    const gmail = this.deps.gmailFor(channelId);
    const result = await gmail.search("in:sent", {
      maxResults: 50,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Bcc"],
    });
    for (const message of result.messages) {
      const at = Number(message.internalDate ?? 0) || this.now();
      for (const headerName of ["To", "Cc", "Bcc"]) {
        const entries = parseAddressEntries(header(message, headerName));
        // The same sent-mail pass backfills the derived people store.
        if (headerName !== "Bcc") this.deps.people.recordOutgoing(channelId, entries, at);
        for (const entry of entries) {
          this.deps.attention.recordRepliedSender(channelId, entry.email, entry.email, "sent-mail");
          this.deps.people.markReplied(channelId, entry.email);
        }
      }
    }
  }

  /** Feed message headers into the derived people store during sync. */
  private harvestPeople(channelId: string, thread: GmailThread, userEmail?: string): void {
    const user = userEmail?.toLowerCase();
    for (const message of thread.messages ?? []) {
      const at = Number(message.internalDate ?? 0) || this.now();
      const from = parseAddressEntries(header(message, "From"))[0];
      const outgoing =
        (message.labelIds ?? []).includes("SENT") || (user !== undefined && from?.email === user);
      if (outgoing) {
        const recipients = [
          ...parseAddressEntries(header(message, "To")),
          ...parseAddressEntries(header(message, "Cc")),
        ].filter((entry) => entry.email !== user);
        this.deps.people.recordOutgoing(channelId, recipients, at);
      } else if (from && from.email !== user) {
        this.deps.people.recordIncoming(channelId, { email: from.email, name: from.name, at });
      }
    }
  }

  async refreshThread(
    channelId: string,
    threadId: string,
    userEmail?: string,
    opts: { allowWake?: boolean } = {}
  ): Promise<GmailThreadCardState> {
    const existing = this.threadRow(channelId, threadId);
    const gmail = this.deps.gmailFor(channelId);
    let thread: GmailThread;
    try {
      thread = await gmail.getThread(threadId, {
        format: "metadata",
        metadataHeaders: METADATA_HEADERS,
      });
    } catch (err) {
      // not-found: the thread vanished in Gmail; reconcile locally as archived.
      if (!existing || !isGmailApiError(err, "not-found")) throw err;
      const archived = threadCardFromRow({
        ...existing,
        unread: 0,
        in_inbox: 0,
        actionable: 0,
        updated_at: this.now(),
      });
      this.sql.exec(
        `UPDATE gmail_threads SET unread = 0, in_inbox = 0, actionable = 0, updated_at = ? WHERE channel_id = ? AND thread_id = ?`,
        archived.updatedAt,
        channelId,
        threadId
      );
      await this.deps.cards.updateThread(channelId, threadId, {
        kind: "statusChange",
        status: "archived",
      });
      return archived;
    }
    this.harvestPeople(channelId, thread, userEmail);
    const event = attentionEventFromThread(thread, userEmail);
    if (event) {
      event.priorReplyToSender = this.deps.attention.hasRepliedToSender(channelId, event.from);
    }
    const attention = event
      ? evaluateAttentionRules(this.deps.attention.getRulesRecord(channelId).ruleSet, event)
      : { wake: false };
    if (event && attention.wake) {
      this.deps.attention.recordHit(channelId, thread.id, attention);
      if (opts.allowWake && this.deps.attention.shouldStartTurn(channelId, event, attention)) {
        await this.deps.startAttentionTurn(channelId, event, attention);
      }
    }
    const card = threadCardState(thread, existing?.category, userEmail, attention);
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_threads
       (channel_id, thread_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      card.threadId,
      card.subject,
      card.from,
      card.snippet,
      card.unread ? 1 : 0,
      card.inInbox ? 1 : 0,
      card.actionable ? 1 : 0,
      card.category ?? null,
      card.updatedAt
    );
    await this.deps.cards.updateThread(channelId, threadId, card);
    return card;
  }

  threadRow(channelId: string, threadId: string): GmailThreadStateRow | null {
    return (
      (this.sql
        .exec(
          `SELECT * FROM gmail_threads WHERE channel_id = ? AND thread_id = ?`,
          channelId,
          threadId
        )
        .toArray()[0] as unknown as GmailThreadStateRow | undefined) ?? null
    );
  }

  listActionableThreads(channelId: string, limit: number): GmailThreadCardState[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_threads
         WHERE channel_id = ? AND actionable = 1
         ORDER BY updated_at DESC
         LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 25))
      )
      .toArray() as unknown as GmailThreadStateRow[];
    return rows.map((row) =>
      threadCardFromRow(row, this.deps.attention.hitForThread(channelId, row.thread_id))
    );
  }

  async applyLocalThreadFlags(
    channelId: string,
    threadId: string,
    flags: {
      unread?: boolean;
      inInbox?: boolean;
      actionable?: boolean;
      status?: GmailThreadCardState["status"];
    }
  ): Promise<void> {
    const existing = this.threadRow(channelId, threadId);
    if (!existing) return;
    this.sql.exec(
      `UPDATE gmail_threads
       SET unread = COALESCE(?, unread),
           in_inbox = COALESCE(?, in_inbox),
           actionable = COALESCE(?, actionable),
           updated_at = ?
       WHERE channel_id = ? AND thread_id = ?`,
      typeof flags.unread === "boolean" ? (flags.unread ? 1 : 0) : null,
      typeof flags.inInbox === "boolean" ? (flags.inInbox ? 1 : 0) : null,
      typeof flags.actionable === "boolean" ? (flags.actionable ? 1 : 0) : null,
      this.now(),
      channelId,
      threadId
    );
    const row = this.threadRow(channelId, threadId);
    if (row) {
      await this.deps.cards.updateThread(channelId, threadId, {
        ...threadCardFromRow(row),
        ...(flags.status ? { status: flags.status } : {}),
      });
    }
  }

  async recomputeAttentionForStoredThreads(channelId: string): Promise<void> {
    const state = this.deps.getChannelState(channelId);
    this.deps.attention.clearHits(channelId);
    const rows = this.sql
      .exec(`SELECT thread_id FROM gmail_threads WHERE channel_id = ?`, channelId)
      .toArray();
    for (const row of rows) {
      const threadId = String(row["thread_id"]);
      try {
        await this.refreshThread(channelId, threadId, state.emailAddress);
      } catch {
        // Stale or inaccessible threads will be reconciled by the next Gmail sync.
      }
    }
  }

  /** Polling interval helper used by the worker alarm. */
  defaultPollInterval(): number {
    return DEFAULT_POLL_INTERVAL_MS;
  }
}
