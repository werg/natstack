import type { SqlStorage } from "@workspace/runtime/worker";

/**
 * Gmail tables are versioned by drop-and-recreate (pre-release: the local
 * thread cache and rule store are cheap to rebuild from Gmail + replay).
 * Bump the worker schemaVersion whenever a gmail_* table shape changes.
 */
const GMAIL_TABLES = [
  "gmail_channel_state",
  "gmail_threads",
  "gmail_attention_rules",
  "gmail_attention_hits",
  "gmail_replied_senders",
  "gmail_attention_turns",
  "gmail_attention_queue",
  "gmail_wake_turns",
  "gmail_people",
  // Legacy tables from earlier schema generations.
  "gmail_categories",
];

export function dropGmailTables(sql: SqlStorage): void {
  for (const table of GMAIL_TABLES) {
    sql.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

export function createGmailTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_channel_state (
      channel_id TEXT PRIMARY KEY,
      history_id TEXT,
      email_address TEXT,
      credential_id TEXT,
      poll_interval_ms INTEGER NOT NULL,
      last_sync_at INTEGER,
      last_error TEXT,
      last_overview_json TEXT,
      last_search_query TEXT,
      last_search_json TEXT,
      setup_status TEXT NOT NULL DEFAULT 'needs-user-preferences',
      setup_prompted_at INTEGER,
      configured_at INTEGER,
      setup_summary TEXT,
      sync_state TEXT NOT NULL DEFAULT 'ok',
      rate_limited_until INTEGER,
      backoff_ms INTEGER,
      last_setup_json TEXT,
      people_api_status TEXT
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_threads (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
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
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_rules (
      channel_id TEXT PRIMARY KEY,
      rules_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_hits (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      directive_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      matched_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_replied_senders (
      channel_id TEXT NOT NULL,
      email TEXT NOT NULL,
      display TEXT,
      first_replied_at INTEGER NOT NULL,
      last_replied_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY(channel_id, email)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_turns (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_attention_queue (
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      directive_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      reason TEXT NOT NULL,
      actions_json TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      PRIMARY KEY(channel_id, thread_id, directive_id)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_wake_turns (
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS gmail_people (
      channel_id TEXT,
      email TEXT,
      display_name TEXT,
      sent_to_count INTEGER DEFAULT 0,
      received_from_count INTEGER DEFAULT 0,
      last_interaction_at INTEGER,
      you_replied INTEGER DEFAULT 0,
      PRIMARY KEY (channel_id, email)
    )
  `);
}
