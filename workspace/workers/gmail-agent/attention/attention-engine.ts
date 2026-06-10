import type { SqlStorage } from "@workspace/runtime/worker";
import type {
  GmailAttentionDecision,
  GmailAttentionHit,
  GmailAttentionRuleSet,
} from "@workspace/gmail/card-types";
import { normalizeEmailAddress } from "../sync/thread-model.js";
import {
  defaultAttentionRules,
  parseActionsJson,
  validateAttentionRules,
  type GmailAttentionEvent,
} from "./rules.js";

export interface GmailAttentionRuleSetRecord {
  channelId: string;
  ruleSet: GmailAttentionRuleSet;
  updatedAt: number;
}

export interface AttentionEngineDeps {
  sql: SqlStorage;
  now?: () => number;
}

/**
 * Persistence layer for attention rules, hits, replied-sender memory, and
 * turn dedup. Pure rule evaluation lives in rules.ts.
 */
export class AttentionEngine {
  constructor(private readonly deps: AttentionEngineDeps) {}

  private get sql(): SqlStorage {
    return this.deps.sql;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  getRulesRecord(channelId: string): GmailAttentionRuleSetRecord {
    const row = this.sql
      .exec(`SELECT * FROM gmail_attention_rules WHERE channel_id = ?`, channelId)
      .toArray()[0];
    if (!row) {
      return { channelId, ruleSet: defaultAttentionRules(), updatedAt: 0 };
    }
    try {
      const ruleSet = validateAttentionRules(JSON.parse(String(row["rules_json"])));
      return { channelId, ruleSet, updatedAt: Number(row["updated_at"] ?? 0) };
    } catch {
      return {
        channelId,
        ruleSet: defaultAttentionRules(),
        updatedAt: Number(row["updated_at"] ?? 0),
      };
    }
  }

  saveRules(channelId: string, ruleSet: GmailAttentionRuleSet): void {
    const normalized = validateAttentionRules(ruleSet);
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_rules (channel_id, rules_json, updated_at)
       VALUES (?, ?, ?)`,
      channelId,
      JSON.stringify(normalized),
      this.now()
    );
  }

  recordHit(channelId: string, threadId: string, decision: GmailAttentionDecision): void {
    if (!decision.wake || !decision.directiveId || !decision.directiveName) return;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_hits
       (channel_id, thread_id, directive_id, directive_name, reason, actions_json, matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      threadId,
      decision.directiveId,
      decision.directiveName,
      decision.reason ?? decision.directiveName,
      JSON.stringify(decision.actions ?? ["surface"]),
      this.now()
    );
  }

  clearHits(channelId: string): void {
    this.sql.exec(`DELETE FROM gmail_attention_hits WHERE channel_id = ?`, channelId);
  }

  hits(channelId: string, limit = 8): GmailAttentionHit[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ?
         ORDER BY matched_at DESC
         LIMIT ?`,
        channelId,
        Math.max(1, Math.min(limit, 50))
      )
      .toArray();
    return rows.map((row) => ({
      threadId: String(row["thread_id"]),
      directiveId: String(row["directive_id"]),
      directiveName: String(row["directive_name"]),
      reason: String(row["reason"]),
      actions: parseActionsJson(row["actions_json"]),
      matchedAt: Number(row["matched_at"] ?? 0),
    }));
  }

  hitForThread(channelId: string, threadId: string): GmailAttentionHit | null {
    const row = this.sql
      .exec(
        `SELECT * FROM gmail_attention_hits
         WHERE channel_id = ? AND thread_id = ?
         ORDER BY matched_at DESC
         LIMIT 1`,
        channelId,
        threadId
      )
      .toArray()[0];
    return row
      ? {
          threadId,
          directiveId: String(row["directive_id"]),
          directiveName: String(row["directive_name"]),
          reason: String(row["reason"]),
          actions: parseActionsJson(row["actions_json"]),
          matchedAt: Number(row["matched_at"] ?? 0),
        }
      : null;
  }

  recordRepliedSender(
    channelId: string,
    email: string | undefined,
    display: string | undefined,
    source: "sent-mail" | "send"
  ): void {
    if (!email) return;
    const now = this.now();
    this.sql.exec(
      `INSERT INTO gmail_replied_senders
       (channel_id, email, display, first_replied_at, last_replied_at, source)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, email) DO UPDATE SET
         display = COALESCE(excluded.display, gmail_replied_senders.display),
         last_replied_at = excluded.last_replied_at,
         source = excluded.source`,
      channelId,
      email.toLowerCase(),
      display ?? null,
      now,
      now,
      source
    );
  }

  hasRepliedToSender(channelId: string, from: string): boolean {
    const email = normalizeEmailAddress(from);
    if (!email) return false;
    const row = this.sql
      .exec(
        `SELECT email FROM gmail_replied_senders WHERE channel_id = ? AND email = ? LIMIT 1`,
        channelId,
        email
      )
      .toArray()[0];
    return Boolean(row);
  }

  /**
   * Turn dedup: returns true (and records the message key) only the first
   * time a directive matches a given thread message.
   */
  shouldStartTurn(
    channelId: string,
    event: GmailAttentionEvent,
    decision: GmailAttentionDecision
  ): boolean {
    if (!decision.wake || !decision.directiveId) return false;
    if (!event.unread || !event.inInbox) return false;
    const messageKey = event.messageId ?? String(event.internalDate ?? "unknown");
    const row = this.sql
      .exec(
        `SELECT last_message_id FROM gmail_attention_turns
         WHERE channel_id = ? AND thread_id = ? AND directive_id = ?`,
        channelId,
        event.threadId,
        decision.directiveId
      )
      .toArray()[0];
    if (String(row?.["last_message_id"] ?? "") === messageKey) return false;
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_attention_turns
       (channel_id, thread_id, directive_id, last_message_id, started_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      event.threadId,
      decision.directiveId,
      messageKey,
      this.now()
    );
    return true;
  }
}
