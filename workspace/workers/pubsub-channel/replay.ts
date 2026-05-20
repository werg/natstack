import type { SqlStorage } from "@workspace/runtime/worker";
import type {
  BootstrapSnapshot,
  ParticipantSnapshot,
  ReplayEnvelope,
  ReplayReady,
  ServerLogEvent,
} from "@workspace/pubsub";
import { parseRowToChannelEvent } from "./broadcast.js";

export type LogRow = Record<string, unknown>;

const LOG_SELECT =
  `SELECT id, message_id, type, payload, sender_id, ts, sender_metadata, attachments, is_root, root_message_id, root_kind FROM messages`;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getLogRowsAfter(sql: SqlStorage, sinceId: number): LogRow[] {
  return sql.exec(`${LOG_SELECT} WHERE id > ? ORDER BY id ASC`, sinceId).toArray();
}

export function getDependentRowsForMessageIds(sql: SqlStorage, rootMessageIds: string[]): LogRow[] {
  if (rootMessageIds.length === 0) return [];
  const placeholders = rootMessageIds.map(() => "?").join(",");
  return sql
    .exec(
      `${LOG_SELECT} WHERE root_message_id IN (${placeholders}) ORDER BY id ASC`,
      ...rootMessageIds
    )
    .toArray();
}

export function getInitialWindowByChatRoots(sql: SqlStorage, rootLimit: number): LogRow[] {
  const roots = sql
    .exec(
      `${LOG_SELECT} WHERE root_kind = 'chat' AND is_root = 1 ORDER BY id DESC LIMIT ?`,
      Math.max(0, rootLimit)
    )
    .toArray()
    .reverse();
  return expandRoots(sql, roots);
}

export function getWindowBeforeChatRoot(
  sql: SqlStorage,
  beforeRootId: number,
  rootLimit: number
): LogRow[] {
  const roots = sql
    .exec(
      `${LOG_SELECT} WHERE root_kind = 'chat' AND is_root = 1 AND id < ? ORDER BY id DESC LIMIT ?`,
      beforeRootId,
      Math.max(0, rootLimit)
    )
    .toArray()
    .reverse();
  return expandRoots(sql, roots);
}

function expandRoots(sql: SqlStorage, roots: LogRow[]): LogRow[] {
  if (roots.length === 0) return [];
  const rootIds = roots.map((row) => row["message_id"] as string);
  const dependents = getDependentRowsForMessageIds(sql, rootIds);
  return [...roots, ...dependents].sort((a, b) => (a["id"] as number) - (b["id"] as number));
}

export function rowToServerLogEvent(row: LogRow): ServerLogEvent {
  return parseRowToChannelEvent(row);
}

function rosterSnapshot(sql: SqlStorage): BootstrapSnapshot {
  const participants: ParticipantSnapshot[] = [];
  for (const row of sql.exec(`SELECT id, metadata FROM participants ORDER BY id ASC`).toArray()) {
    try {
      participants.push({
        id: row["id"] as string,
        metadata: JSON.parse(row["metadata"] as string),
      });
    } catch {
      /* ignore corrupt participant metadata */
    }
  }
  return { kind: "roster-snapshot", participants, ts: Date.now() };
}

function buildReady(
  sql: SqlStorage,
  rows: LogRow[],
  opts: {
    contextId?: string;
    channelConfig?: Record<string, unknown>;
    mode: ReplayEnvelope["mode"];
    beforeRootId?: number;
  }
): ReplayReady {
  const totalCount =
    (sql.exec(`SELECT COUNT(*) as cnt FROM messages`).toArray()[0]?.["cnt"] as number) ?? 0;
  const rootMessageCount =
    (sql
      .exec(`SELECT COUNT(*) as cnt FROM messages WHERE root_kind = 'chat' AND is_root = 1`)
      .toArray()[0]?.["cnt"] as number) ?? 0;
  const firstRootMessageId =
    (sql
      .exec(`SELECT MIN(id) as mid FROM messages WHERE root_kind = 'chat' AND is_root = 1`)
      .toArray()[0]?.["mid"] as number | null) ?? undefined;
  const replayFromId = rows.length > 0 ? asNumber(rows[0]?.["id"]) : undefined;
  const replayToId = rows.length > 0 ? asNumber(rows[rows.length - 1]?.["id"]) : undefined;
  let hasMoreBefore: boolean | undefined;
  if (opts.mode === "initial") {
    hasMoreBefore =
      replayFromId !== undefined &&
      sql
        .exec(
          `SELECT id FROM messages WHERE root_kind = 'chat' AND is_root = 1 AND id < ? LIMIT 1`,
          replayFromId
        )
        .toArray().length > 0;
  } else if (opts.mode === "before") {
    const anchor = replayFromId ?? opts.beforeRootId ?? 0;
    hasMoreBefore =
      anchor > 0 &&
      sql
        .exec(
          `SELECT id FROM messages WHERE root_kind = 'chat' AND is_root = 1 AND id < ? LIMIT 1`,
          anchor
        )
        .toArray().length > 0;
  }
  return {
    contextId: opts.contextId,
    channelConfig: opts.channelConfig,
    totalCount,
    rootMessageCount,
    firstRootMessageId,
    replayFromId,
    replayToId,
    ...(hasMoreBefore !== undefined ? { hasMoreBefore } : {}),
  };
}

export function buildReplayEnvelope(
  sql: SqlStorage,
  opts: {
    mode: "initial" | "after" | "before";
    sinceId?: number;
    beforeRootId?: number;
    rootLimit?: number;
    includeRosterSnapshot?: boolean;
    contextId?: string;
    channelConfig?: Record<string, unknown>;
  }
): ReplayEnvelope {
  const rootLimit = Math.min(Math.max(opts.rootLimit ?? 50, 0), 500);
  let rows: LogRow[];
  if (opts.mode === "after") {
    rows = getLogRowsAfter(sql, opts.sinceId ?? 0);
  } else if (opts.mode === "before") {
    if (opts.beforeRootId == null) throw new Error("beforeRootId required for before replay");
    rows = getWindowBeforeChatRoot(sql, opts.beforeRootId, rootLimit);
  } else {
    rows = getInitialWindowByChatRoots(sql, rootLimit);
  }
  return {
    mode: opts.mode,
    logEvents: rows.map(rowToServerLogEvent),
    snapshots: opts.includeRosterSnapshot ? [rosterSnapshot(sql)] : [],
    ready: buildReady(sql, rows, {
      contextId: opts.contextId,
      channelConfig: opts.channelConfig,
      mode: opts.mode,
      beforeRootId: opts.beforeRootId,
    }),
  };
}
