import { DurableObjectBase, rpc } from "@workspace/runtime/worker";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  GENESIS_EVENT_HASH,
  assertAgenticEventStoredValuesEncoded,
  brandId,
  collectStoredValueRefs,
  publicActorRef,
  publicParticipantMetadata,
  publicParticipantRef,
  sanitizeAgenticEventParticipantRefs,
  storedAgenticEventSchema,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type LogEnvelope,
  type LogEventCausality,
  type LogKind,
  type ParticipantRef,
  type ParticipantSelector,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";
import {
  gadAppendErrorMessage,
  logEnvelopeHashPreimage,
  logEnvelopeSemantic,
  type AppendIdempotency,
  manifestHashForEntries,
  sha256HexSyncText,
  sortJson,
  stableJson,
  stableSha256Hex,
  stateHashForRoot,
  EMPTY_MANIFEST_HASH,
  EMPTY_STATE_HASH,
  type LogEnvelopeSemanticInput,
} from "@workspace/agentic-protocol";

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;

const CHANNEL_LOG_HEAD = "main";

/** Tables that must exist before a schema version is recorded as ready
 *  (validated by DurableObjectBase after every createTables()). Lazily
 *  created tables (memory index) are deliberately absent. */
const GAD_REQUIRED_TABLES = [
  "log_heads",
  "log_events",
  "log_blob_refs",
  "refs",
  "ref_log",
  "trajectory_turns",
  "trajectory_messages",
  "trajectory_message_blocks",
  "trajectory_invocations",
  "trajectory_invocation_outputs",
  "trajectory_approvals",
  "trajectory_usage_rollups",
  "trajectory_checkpoints",
  "channel_message_types",
  "channel_roster",
  "gad_blobs",
  "gad_worktree_states",
  "gad_file_versions",
  "gad_manifest_nodes",
  "gad_manifest_entries",
  "gad_state_transitions",
  "gad_transition_parents",
  "gad_worktree_edit_ops",
  "gad_claims",
  "gad_gc_candidates",
] as const;

/** Log kinds whose events are full agentic trajectory events (validated and
 *  projected). `log_kind` stays metadata for append/fork/replay/integrity —
 *  this set only gates content validation and projection dispatch. */
const AGENTIC_LOG_KINDS = new Set<string>(["trajectory", "vcs"]);

const TERMINAL_INVOCATION_KINDS = new Set([
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
]);

const STATE_TRANSITION_KINDS = new Set([
  "state.transition_recorded",
  "state.snapshot_ingested",
  "state.merge_applied",
]);

/**
 * GC creation-time grace period: values created within this window are never
 * collected, so multi-step flows (e.g. stageWorktreeState → setPendingMerge)
 * cannot lose freshly created values to a GC run that lands between steps.
 */
const GC_CREATION_GRACE_MS = 15 * 60 * 1000;

export interface LogAppendEventInput {
  envelopeId?: string | null;
  actor: ParticipantRef;
  to?: ParticipantRef[] | ParticipantSelector | null;
  payloadKind: string;
  payload: unknown;
  causality?: LogEventCausality | null;
  annotations?: Record<string, unknown> | null;
  appendedAt?: string | null;
  publish?: { channels: Array<{ channelId: string; audience?: unknown }> } | null;
}

export interface AppendLogEventInput {
  logId: string;
  head: string;
  logKind: LogKind | string;
  owner?: { kind: string; id: string } | null;
  expectedHeadHash?: string | null;
  /** Append idempotency intent — see AppendIdempotency in agentic-protocol.
   *  Default "exact": same-id-different-content is a hard integrity error.
   *  "idempotent-by-id" (client publish paths only): first write wins; the
   *  journaled original is returned in `envelopes` as a replay. */
  idempotency?: AppendIdempotency | null;
  events: LogAppendEventInput[];
}

export interface AppendLogEventResult {
  logId: string;
  head: string;
  headSeq: number;
  headHash: string;
  envelopes: LogEnvelope[];
  published: Array<{ originEnvelopeId: string; channelId: string; envelopeId: string }>;
}

export interface ForkLogInput {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  atSeq?: number | null;
  owner?: { kind: string; id: string } | null;
}

export interface ForkLogResult {
  fromLogId: string;
  fromHead: string;
  toLogId: string;
  toHead: string;
  forkSeq: number;
  forkHash: string;
  inherited: number;
}

export interface ReadLogInput {
  logId: string;
  head: string;
  afterSeq?: number | null;
  beforeSeq?: number | null;
  limit?: number | null;
  payloadKind?: string | null;
}

export interface LogHeadInfo {
  logId: string;
  head: string;
  logKind: string;
  seq: number;
  hash: string;
  envelopeId: string | null;
  forkSeq: number | null;
  forkHash: string | null;
  parentLogId: string | null;
  parentHead: string | null;
}

export interface RefRecord {
  refName: string;
  kind: string;
  target: unknown;
  updatedAt: string;
}

export interface IngestWorktreeStateInput {
  files: Array<{ path: string; contentHash: string; size?: number | null; mode?: number | null }>;
  baseStateHash?: string | null;
  parentStateHashes?: string[] | null;
  logId: string;
  head: string;
  logKind?: LogKind | string | null;
  ref?: string | null;
  expectedRefStateHash?: string | null;
  actor: ParticipantRef;
  summary?: string | null;
  eventId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Transition kind: ordinary snapshot (default) or a completed merge. */
  eventKind?: "state.snapshot_ingested" | "state.merge_applied" | null;
  /** The op union that authored this commit (provenance/intent), recorded in
   *  gad_worktree_edit_ops keyed to the transition event. */
  editOps?: Array<{
    kind: "replace" | "write" | "create" | "delete" | "chmod";
    path: string;
    oldContentHash?: string | null;
    newContentHash?: string | null;
    hunks?: unknown;
    mode?: number | null;
  }> | null;
}

// ---------------------------------------------------------------------------
// Legacy adapter shapes (deleted in the Stage B cut along with the adapters)
// ---------------------------------------------------------------------------

export interface TrajectoryAppendItem {
  event: AgenticEvent;
  eventId?: string | null;
  publish?: {
    channelIds: string[];
    audience?: unknown;
  } | null;
}

export interface AppendTrajectoryBatchInput {
  trajectoryId: string;
  branchId: string;
  owner: { kind: "agent"; id: string };
  expectedHeadEventHash?: string | null;
  events: TrajectoryAppendItem[];
}

export interface AppendTrajectoryBatchResult {
  trajectoryId: string;
  branchId: string;
  headEventId: string | null;
  headEventHash: string | null;
  headStateHash: string | null;
  events: TrajectoryEvent[];
  published: Array<{ eventId: string; channelId: string; envelopeId: string }>;
}

export interface ChannelPublication {
  eventId: string;
  trajectoryId: string;
  branchId: string;
  channelId: string;
  channelSeq: number;
  envelopeId: string;
  publishedAt: string;
}

export interface EnvelopeLineage {
  publication: ChannelPublication;
  envelope: ChannelEnvelope;
  trajectoryEvent: TrajectoryEvent;
}

export interface PublishedArtifact {
  lineage: EnvelopeLineage;
}

export interface PrivateLineageForPublishedEnvelope {
  lineage: EnvelopeLineage;
  branchEvents: TrajectoryEvent[];
}

export interface ChannelReplayWindow {
  envelopes: ChannelEnvelope[];
  totalCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

export interface ChannelEnvelopeInspection {
  envelopeId: string;
  channelId: string;
  seq: number;
  payloadKind?: string;
  from: JsonRecord;
  metadata?: JsonRecord;
  bytes: {
    from: number;
    to: number;
    payload: number;
    metadata: number;
    attachments: number;
  };
  payloadSummary: unknown;
  storedRefs: JsonRecord[];
  publishedAt: string;
}

export interface PublicationIntegrityInspection {
  summary: {
    expectedMappings: number;
    missingMappings: number;
    orphanMappings: number;
    missingPublicationEvents: number;
    missingPublicationEnvelopes: number;
    sequenceMismatches: number;
    channelOriginAgenticEnvelopes: number;
  };
  rows: JsonRecord[];
}

export interface TurnStateInspection {
  summary: {
    branches: number;
    openTurns: number;
    streamingMessages: number;
    nonterminalInvocations: number;
    duplicateOpenedTurns: number;
  };
  rows: JsonRecord[];
}

export interface InvocationStateInspection {
  summary: {
    projected: number;
    startedEvents: number;
    terminalEvents: number;
    openProjectedInvocations: number;
  };
  rows: JsonRecord[];
}

export interface ChannelRosterInspection {
  summary: {
    rows: number;
    activeParticipants: number;
    inactiveParticipants: number;
  };
  rows: JsonRecord[];
}

export interface AgentHealthInspection {
  channelId: string;
  branchId: string;
  generatedAt: string;
  summary: {
    ok: boolean;
    publicationIssues: number;
    openTurns: number;
    streamingMessages: number;
    nonterminalInvocations: number;
    activeParticipants: number;
    storageIssues: number;
  };
  publicationIntegrity: PublicationIntegrityInspection;
  turnState: TurnStateInspection;
  invocationState: InvocationStateInspection;
  roster: ChannelRosterInspection;
  envelopes: { rows: ChannelEnvelopeInspection[] };
  storage: { rows: JsonRecord[] };
}

export interface ForkChannelLogInput {
  fromChannelId: string;
  toChannelId: string;
  throughSeq?: number | null;
}

export interface ForkChannelLogResult {
  fromChannelId: string;
  toChannelId: string;
  throughSeq: number | null;
  copied: number;
  firstSeq?: number;
  lastSeq?: number;
  lineage: Array<{
    sourceEnvelopeId: string;
    forkEnvelopeId: string;
    sourceSeq: number;
    forkSeq: number;
  }>;
}

export interface ForkTrajectoryBranchInput {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  throughSeq?: number | null;
  throughEventHash?: string | null;
  throughPublishedChannelId?: string | null;
  throughPublishedChannelSeq?: number | null;
  toPublishedChannelId?: string | null;
  owner?: { kind: "agent"; id: string } | null;
}

export interface ForkTrajectoryBranchResult {
  fromTrajectoryId: string;
  fromBranchId: string;
  toTrajectoryId: string;
  toBranchId: string;
  copied: number;
  headEventId: string | null;
  headEventHash: string | null;
  headStateHash: string | null;
  lineage: Array<{
    sourceEventId: string;
    forkEventId: string;
    sourceSeq: number;
    forkSeq: number;
    sourceEventHash: string;
    forkEventHash: string;
  }>;
}

export interface ChannelMessageTypeDefinition {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "code"; code: string } | { type: "file"; path: string };
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
  registeredBy?: Record<string, unknown>;
  updatedAtSeq: number;
  clearedAtSeq?: number;
}

export type RegistryMutationInput =
  | {
      kind: "upsertMessageType";
      typeId: string;
      row: Omit<ChannelMessageTypeDefinition, "typeId" | "updatedAtSeq" | "clearedAtSeq">;
    }
  | { kind: "clearMessageType"; typeId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  return JSON.parse(value) as unknown;
}

function parseRecord(value: string | null | undefined): JsonRecord {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : {};
}

function readOnlySql(sql: string): boolean {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\n\r]*/gu, " ")
    .replace(/'(?:''|[^'])*'/gu, "''")
    .replace(/"(?:[^"]|"")*"/gu, '""')
    .trimStart();
  const verb = normalized.match(/^[A-Za-z]+/u)?.[0]?.toUpperCase();
  if (verb === "SELECT" || verb === "EXPLAIN" || verb === "PRAGMA") return true;
  if (verb !== "WITH") return false;
  if (!/\bSELECT\b/iu.test(normalized)) return false;
  return !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH|DETACH)\b/iu.test(
    normalized
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Invalid worktree-relative path: ${path}`);
  }
  return normalized;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Quote each term so user input can't inject FTS5 query syntax. */
function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => term.replace(/"/gu, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => `"${term}"`)
    .join(" ");
}

/** Short context window around the first query-term hit. */
function snippetAround(text: string, query: string, radius = 160): string {
  const firstTerm = query.split(/\s+/u).find((term) => term.length > 0) ?? "";
  const index = firstTerm ? text.toLowerCase().indexOf(firstTerm.toLowerCase()) : -1;
  if (index < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + firstTerm.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function summarizeJsonForInspection(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 240
      ? { type: "string", chars: value.length, preview: value.slice(0, 240) }
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const sample = value.slice(0, 20).map((item) => summarizeJsonForInspection(item, depth + 1));
    return value.length > sample.length
      ? [...sample, { omittedItems: value.length - sample.length }]
      : sample;
  }
  if (typeof value === "object") {
    if (depth >= 4) return { type: "object" };
    const entries = Object.entries(value as Record<string, unknown>);
    const sample = entries
      .slice(0, 40)
      .map(([key, child]) => [key, summarizeJsonForInspection(child, depth + 1)]);
    const out = Object.fromEntries(sample) as Record<string, unknown>;
    if (entries.length > sample.length) out["omittedKeys"] = entries.length - sample.length;
    return out;
  }
  return String(value);
}

function isActorRefLike(value: unknown): value is {
  kind: "user" | "agent" | "system" | "panel" | "external";
  id: string;
  metadata?: Record<string, unknown>;
} {
  const kind =
    !!value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["kind"]
      : undefined;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (kind === "user" ||
      kind === "agent" ||
      kind === "system" ||
      kind === "panel" ||
      kind === "external") &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  );
}

function sanitizeRegistryMutation(mutation: RegistryMutationInput): RegistryMutationInput {
  if (mutation.kind !== "upsertMessageType") return mutation;
  const registeredBy = mutation.row.registeredBy;
  return {
    ...mutation,
    row: {
      ...mutation.row,
      ...(isActorRefLike(registeredBy)
        ? { registeredBy: publicActorRef(registeredBy) }
        : registeredBy !== undefined
          ? { registeredBy: publicParticipantMetadata(registeredBy) }
          : {}),
    },
  };
}

function findPrivateParticipantMetadataPath(value: unknown, path = "$"): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPrivateParticipantMetadataPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if ("methods" in record && Array.isArray(record["methods"])) {
    for (const [index, method] of (record["methods"] as unknown[]).entries()) {
      if (!method || typeof method !== "object" || Array.isArray(method)) continue;
      const methodRecord = method as Record<string, unknown>;
      if (
        "parameters" in methodRecord ||
        "returns" in methodRecord ||
        "description" in methodRecord
      ) {
        return `${path}.methods[${index}]`;
      }
    }
  }
  for (const key of Object.keys(record)) {
    if (key === "parameters" || key === "returns" || key === "description") continue;
    const found = findPrivateParticipantMetadataPath(record[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function sanitizeAudience(
  audience: ParticipantRef[] | ParticipantSelector | null | undefined
): ParticipantRef[] | ParticipantSelector | undefined {
  if (audience == null) return undefined;
  if (!Array.isArray(audience)) return audience;
  return audience.map((participant) => publicParticipantRef(participant));
}

function isAgenticEventPayload(payload: unknown): payload is AgenticEvent {
  return (
    !!payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>)["kind"] === "string" &&
    typeof (payload as Record<string, unknown>)["actor"] === "object" &&
    typeof (payload as Record<string, unknown>)["createdAt"] === "string"
  );
}

/** Strip cross-log/turn keys so the remaining causality matches the agentic
 *  trajectory causality shape. */
function agenticCausality(
  causality: LogEventCausality | null | undefined
): Record<string, unknown> | undefined {
  if (!causality) return undefined;
  const {
    originLogId: _originLogId,
    originHead: _originHead,
    originEnvelopeId: _originEnvelopeId,
    turnId: _turnId,
    ...rest
  } = causality as Record<string, unknown>;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Rebuild the semantic agentic event from a unified log envelope. */
function agenticEventFromEnvelope(envelope: LogEnvelope): Record<string, unknown> {
  const causality = agenticCausality(envelope.causality);
  const turnId = envelope.causality?.turnId;
  return {
    kind: envelope.payloadKind,
    actor: envelope.actor,
    ...(turnId ? { turnId } : {}),
    ...(causality ? { causality } : {}),
    payload: envelope.payload,
    createdAt: envelope.appendedAt,
  };
}

function terminalInvocationSignatureFromEnvelope(envelope: LogEnvelope): string {
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  return stableJson({
    actor: envelope.actor,
    kind: envelope.payloadKind,
    turnId: causality["turnId"],
    causality: {
      invocationId: causality["invocationId"],
      modelToolCallId: causality["modelToolCallId"],
      transportCallId: causality["transportCallId"],
    },
    payload: envelope.payload,
  });
}

interface PreparedLogEvent {
  envelopeId: string;
  /** Whether the caller supplied appendedAt (idempotent replays of implicit-
   *  timestamp appends compare against the stored timestamp instead). */
  appendedAtExplicit: boolean;
  actor: ParticipantRef;
  to?: ParticipantRef[] | ParticipantSelector;
  payloadKind: string;
  payload: unknown;
  annotations?: Record<string, unknown>;
  causality?: LogEventCausality;
  appendedAt: string;
  publish: Array<{ channelId: string; audience?: unknown }>;
}

interface LineageSegment {
  logId: string;
  head: string;
  /** Highest seq visible from the descendant's perspective (Infinity for self). */
  throughSeq: number;
}

interface LineageEventStats {
  count: number;
  firstSeq?: number;
}

interface ProjectionKey {
  logId: string;
  head: string;
}

export class GadWorkspaceDO extends DurableObjectBase {
  // v18: schema cut removes unimplemented knowledge sidecar projection tables.
  // v17 changed envelope hash preimage format v2 (length-prefixed fields).
  static override schemaVersion = 18;

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
    void this.setOwnTitle("GAD store");
  }

  protected createTables(): void {
    this.createFreshSchema();
  }

  protected override migrate(fromVersion: number, _toVersion: number): void {
    // Big-bang schema: no data migration across versions — drop and let
    // createTables() (called after migrate by the base) recreate fresh.
    if (fromVersion > 0) this.dropPersistenceTables();
  }

  protected override requiredTables(): readonly string[] {
    return GAD_REQUIRED_TABLES;
  }

  private dropPersistenceTables(): void {
    const rows = this.sql
      .exec(
        `SELECT type, name, sql FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND (
             name LIKE 'trajectory_%' OR name LIKE 'channel_%' OR name LIKE 'gad_%'
             OR name LIKE 'log_%'
             OR name IN ('refs', 'ref_log', 'branches', 'sessions', 'conversation_turns',
                         'tool_calls', 'file_versions', 'tracked_files', 'blobs')
           )`
      )
      .toArray() as Array<{ type: string; name: string; sql: string | null }>;
    const isVirtual = (row: { sql: string | null }) =>
      /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "");
    // FTS5 virtual tables and their shadow tables (…_data, _idx, _content,
    // _docsize, _config) are interdependent: drop the virtual tables FIRST so
    // SQLite tears down their shadows, then drop the remaining ordinary
    // tables, skipping any name the virtual-table drop already removed.
    for (const row of rows) {
      if (row.type === "view") this.sql.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(row.name)}`);
    }
    for (const row of rows) {
      if (row.type === "table" && isVirtual(row)) {
        this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(row.name)}`);
      }
    }
    for (const row of rows) {
      if (row.type !== "table" || isVirtual(row)) continue;
      const stillExists =
        this.sql
          .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, row.name)
          .toArray().length > 0;
      if (stillExists) this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(row.name)}`);
    }
  }

  private createFreshSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_heads (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        log_kind TEXT NOT NULL,
        owner_json TEXT,
        parent_log_id TEXT,
        parent_head TEXT,
        fork_seq INTEGER,
        fork_hash TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_events (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_id TEXT NOT NULL,
        payload_kind TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        to_json TEXT,
        causality_json TEXT,
        annotations_json TEXT,
        payload_ref_json TEXT NOT NULL,
        appended_at TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        prev_hash TEXT NOT NULL,
        origin_log_id TEXT,
        origin_head TEXT,
        origin_envelope_id TEXT,
        turn_id TEXT,
        PRIMARY KEY (log_id, head, seq),
        UNIQUE (log_id, head, envelope_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_kind ON log_events(payload_kind, log_id, head, seq)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_log_events_origin ON log_events(origin_envelope_id)`
    );
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_events_envelope ON log_events(envelope_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_events_turn ON log_events(turn_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_blob_refs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, envelope_id, field_path)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_log_blob_refs_digest ON log_blob_refs(digest)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        ref_name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ref_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_name TEXT NOT NULL,
        old_target_json TEXT,
        new_target_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_ref_log_name ON ref_log(ref_name, id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_turns (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary TEXT,
        PRIMARY KEY (log_id, head, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_messages (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, message_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_message_blocks (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        block_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        invocation_id TEXT,
        PRIMARY KEY (log_id, head, block_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_invocations (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        transport_call_id TEXT,
        kind TEXT,
        status TEXT NOT NULL,
        terminal_outcome TEXT,
        terminal_reason_code TEXT,
        request_ref_json TEXT,
        result_ref_json TEXT,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_trajectory_invocations_transport ON trajectory_invocations(transport_call_id)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_invocation_outputs (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_approvals (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        requested_by_json TEXT,
        resolved_by_json TEXT,
        requested_event_id TEXT,
        resolved_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, approval_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_usage_rollups (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (log_id, head, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trajectory_checkpoints (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        anchor_event_hash TEXT NOT NULL,
        materialized_blob_json TEXT NOT NULL,
        materializer_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, anchor_event_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_message_types (
        channel_id TEXT NOT NULL,
        type_id TEXT NOT NULL,
        display_mode TEXT,
        source_json TEXT,
        imports_json TEXT,
        schema_json TEXT,
        registered_by_json TEXT,
        updated_at_seq INTEGER NOT NULL DEFAULT -1,
        cleared_at_seq INTEGER,
        PRIMARY KEY (channel_id, type_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_roster (
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        left_at TEXT,
        roles_json TEXT,
        PRIMARY KEY (channel_id, participant_id, joined_at)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_worktree_states (
        state_hash TEXT PRIMARY KEY,
        manifest_root_hash TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_file_versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mode INTEGER NOT NULL DEFAULT 33188,
        created_at TEXT NOT NULL,
        UNIQUE (path, content_hash, mode)
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_file_versions_path ON gad_file_versions(path)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_nodes (
        manifest_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_entries (
        manifest_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        child_manifest_hash TEXT,
        file_version_id INTEGER,
        PRIMARY KEY (manifest_hash, name)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_state_transitions (
        event_id TEXT PRIMARY KEY,
        invocation_id TEXT,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        produced_by_mutation_id TEXT,
        summary TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_state_transitions_output ON gad_state_transitions(output_state_hash)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_transition_parents (
        event_id TEXT NOT NULL,
        parent_state_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (event_id, ordinal)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_worktree_edit_ops (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        old_content_hash TEXT,
        new_content_hash TEXT,
        hunks_json TEXT,
        mode INTEGER
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_gad_edit_ops_event ON gad_worktree_edit_ops(event_id)`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_claims (
        claim_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      -- GC: two-phase blob deletion candidates (marked unreferenced; swept
      -- only when still unreferenced on a later pass).
      CREATE TABLE IF NOT EXISTS gad_gc_candidates (
        digest TEXT PRIMARY KEY,
        marked_at TEXT NOT NULL
      )
    `);
    this.ensureEmptyState();
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  rawSql(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    if (!readOnlySql(sql)) throw new Error("rawSql writes are disabled");
    return { rows: this.sql.exec(sql, ...bindings).toArray() as JsonRecord[] };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  query(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    return this.rawSql(sql, bindings);
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  ensureBlob(hash: string, size = 0, mimeType?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_blobs (hash, size, mime_type, created_at) VALUES (?, ?, ?, ?)`,
      hash,
      size,
      mimeType ?? null,
      nowIso()
    );
  }

  // -------------------------------------------------------------------------
  // Refs — the only mutable pointers (P1). Every update is CAS + reflog.
  // -------------------------------------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  resolveRef(input: { refName: string }): RefRecord | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM refs WHERE ref_name = ?`, input.refName)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return {
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    };
  }

  @rpc({ callers: ["do", "server"] })
  updateRef(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    this.ensureReady();
    return this.updateRefInternal(input);
  }

  private updateRefInternal(input: {
    refName: string;
    kind: string;
    target: unknown;
    expected?: unknown;
  }): RefRecord {
    const existing = this.resolveRef({ refName: input.refName });
    if ("expected" in input) {
      const expected = input.expected ?? null;
      const current = existing?.target ?? null;
      if (stableJson(expected) !== stableJson(current)) {
        throw new Error(`ref CAS conflict: ${input.refName}`);
      }
    }
    const now = nowIso();
    const targetJson = JSON.stringify(input.target);
    this.sql.exec(
      `INSERT INTO refs (ref_name, kind, target_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ref_name) DO UPDATE SET
         kind = excluded.kind,
         target_json = excluded.target_json,
         updated_at = excluded.updated_at`,
      input.refName,
      input.kind,
      targetJson,
      now
    );
    this.sql.exec(
      `INSERT INTO ref_log (ref_name, old_target_json, new_target_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      input.refName,
      existing ? JSON.stringify(existing.target) : null,
      targetJson,
      now
    );
    return { refName: input.refName, kind: input.kind, target: input.target, updatedAt: now };
  }

  private deleteRefInternal(refName: string): void {
    this.sql.exec(`DELETE FROM refs WHERE ref_name = ?`, refName);
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listRefs(input: { kind?: string | null; prefix?: string | null } = {}): RefRecord[] {
    this.ensureReady();
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      bindings.push(input.kind);
    }
    if (input.prefix) {
      clauses.push("ref_name LIKE ?");
      bindings.push(`${input.prefix}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.sql
        .exec(`SELECT * FROM refs ${where} ORDER BY ref_name ASC`, ...bindings)
        .toArray() as JsonRecord[]
    ).map((row) => ({
      refName: String(row["ref_name"]),
      kind: String(row["kind"]),
      target: parseJson(asString(row["target_json"])),
      updatedAt: String(row["updated_at"]),
    }));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listRefLog(input: { refName: string; limit?: number | null }): JsonRecord[] {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    return this.sql
      .exec(
        `SELECT * FROM ref_log WHERE ref_name = ? ORDER BY id ASC LIMIT ?`,
        input.refName,
        limit
      )
      .toArray() as JsonRecord[];
  }

  private logHeadRefName(logId: string, head: string): string {
    return `log:${logId}:${head}`;
  }

  private worktreeRefName(logId: string, head: string): string {
    return `worktree:${logId}:${head}`;
  }

  // -------------------------------------------------------------------------
  // Unified log core (one code path for every log kind — P5)
  // -------------------------------------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getLogHead(input: { logId: string; head: string }): LogHeadInfo | null {
    this.ensureReady();
    const row = this.logHeadRow(input.logId, input.head);
    if (!row) return null;
    const pointer = this.headPointer(input.logId, input.head, row);
    return {
      logId: input.logId,
      head: input.head,
      logKind: String(row["log_kind"]),
      seq: pointer.seq,
      hash: pointer.hash,
      envelopeId: pointer.envelopeId,
      forkSeq: row["fork_seq"] == null ? null : asNumber(row["fork_seq"]),
      forkHash: asString(row["fork_hash"]),
      parentLogId: asString(row["parent_log_id"]),
      parentHead: asString(row["parent_head"]),
    };
  }

  private logHeadRow(logId: string, head: string): JsonRecord | null {
    return (
      (this.sql
        .exec(`SELECT * FROM log_heads WHERE log_id = ? AND head = ?`, logId, head)
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  /** Current head pointer: ref target when present, else the fork point /
   *  genesis baseline. */
  private headPointer(
    logId: string,
    head: string,
    headRow?: JsonRecord | null
  ): { seq: number; hash: string; envelopeId: string | null } {
    const ref = this.resolveRef({ refName: this.logHeadRefName(logId, head) });
    if (ref && ref.target && typeof ref.target === "object") {
      const target = ref.target as Record<string, unknown>;
      return {
        seq: asNumber(target["seq"]),
        hash: String(target["hash"] ?? GENESIS_EVENT_HASH),
        envelopeId: asString(target["envelopeId"]),
      };
    }
    const row = headRow ?? this.logHeadRow(logId, head);
    if (row && row["fork_seq"] != null) {
      return {
        seq: asNumber(row["fork_seq"]),
        hash: asString(row["fork_hash"]) ?? GENESIS_EVENT_HASH,
        envelopeId: null,
      };
    }
    return { seq: 0, hash: GENESIS_EVENT_HASH, envelopeId: null };
  }

  /** Lineage segments, self first, each capped at the seq visible from the
   *  descendant chain. Cycle-guarded. */
  private logLineage(logId: string, head: string): LineageSegment[] {
    const segments: LineageSegment[] = [];
    const seen = new Set<string>();
    let currentLogId = logId;
    let currentHead = head;
    let cap = Number.POSITIVE_INFINITY;
    for (;;) {
      const key = `${currentLogId}\u0000${currentHead}`;
      if (seen.has(key)) throw new Error(`log lineage cycle at ${currentLogId}:${currentHead}`);
      seen.add(key);
      segments.push({ logId: currentLogId, head: currentHead, throughSeq: cap });
      const row = this.logHeadRow(currentLogId, currentHead);
      if (!row) break;
      const parentLogId = asString(row["parent_log_id"]);
      const parentHead = asString(row["parent_head"]);
      if (!parentLogId || !parentHead || row["fork_seq"] == null) break;
      cap = Math.min(cap, asNumber(row["fork_seq"]));
      currentLogId = parentLogId;
      currentHead = parentHead;
    }
    return segments;
  }

  /** Sync twin of the protocol's computeLogEnvelopeHash — same preimage
   *  builder, sync sha256 (workerd has no sync crypto and hashes are needed
   *  inside SQL transactions). */
  private computeEnvelopeHash(
    logId: string,
    head: string,
    seq: number,
    prevHash: string,
    semantic: Record<string, unknown>
  ): string {
    return sha256HexSyncText(logEnvelopeHashPreimage({ prevHash, logId, head, seq, semantic }));
  }

  /** The hash-covered slice — the protocol's logEnvelopeSemantic. */
  private semanticSlice(event: LogEnvelopeSemanticInput): Record<string, unknown> {
    return logEnvelopeSemantic(event);
  }

  private mapLogEnvelope(row: JsonRecord): LogEnvelope {
    return {
      logId: String(row["log_id"]),
      head: String(row["head"]),
      seq: asNumber(row["seq"]),
      envelopeId: brandId<EnvelopeId>(String(row["envelope_id"])),
      actor: parseRecord(asString(row["actor_json"])) as unknown as ParticipantRef,
      ...(row["to_json"] ? { to: parseJson(asString(row["to_json"])) as LogEnvelope["to"] } : {}),
      payloadKind: String(row["payload_kind"]),
      payload: parseJson(asString(row["payload_ref_json"])),
      ...(row["annotations_json"]
        ? { annotations: parseRecord(asString(row["annotations_json"])) }
        : {}),
      ...(row["causality_json"]
        ? { causality: parseRecord(asString(row["causality_json"])) as LogEventCausality }
        : {}),
      appendedAt: String(row["appended_at"]),
      prevHash: String(row["prev_hash"]),
      hash: String(row["hash"]),
    };
  }

  private logEventWhereForSegment(
    segment: LineageSegment,
    input: Pick<ReadLogInput, "afterSeq" | "beforeSeq" | "payloadKind">
  ): { where: string; bindings: SqlBinding[] } {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [segment.logId, segment.head, input.afterSeq ?? 0];
    if (Number.isFinite(segment.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(segment.throughSeq);
    }
    if (Number.isFinite(input.beforeSeq ?? Number.POSITIVE_INFINITY)) {
      clauses.push("seq < ?");
      bindings.push(input.beforeSeq ?? Number.POSITIVE_INFINITY);
    }
    if (input.payloadKind) {
      clauses.push("payload_kind = ?");
      bindings.push(input.payloadKind);
    }
    return { where: clauses.join(" AND "), bindings };
  }

  private lineageEventStats(input: ReadLogInput): LineageEventStats {
    let count = 0;
    let firstSeq: number | undefined;
    for (const segment of this.logLineage(input.logId, input.head)) {
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const row = this.sql
        .exec(`SELECT COUNT(*) AS cnt, MIN(seq) AS first_seq FROM log_events WHERE ${where}`, ...bindings)
        .one();
      const segmentCount = asNumber(row["cnt"]);
      count += segmentCount;
      if (segmentCount > 0) {
        const segmentFirst = asNumber(row["first_seq"]);
        firstSeq = firstSeq === undefined ? segmentFirst : Math.min(firstSeq, segmentFirst);
      }
    }
    return { count, ...(firstSeq !== undefined ? { firstSeq } : {}) };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  readLog(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit =
      input.limit != null && input.limit > 0 ? Math.max(Math.trunc(input.limit), 0) : null;
    const segments = this.logLineage(input.logId, input.head);
    const collected: LogEnvelope[] = [];
    // Ancestors hold the lowest seqs: walk root-first.
    for (const segment of [...segments].reverse()) {
      const remaining = limit != null ? limit - collected.length : null;
      if (remaining != null && remaining <= 0) return collected;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq ASC${
            remaining != null ? " LIMIT ?" : ""
          }`,
          ...(remaining != null ? [...bindings, remaining] : bindings)
        )
        .toArray() as JsonRecord[];
      for (const row of rows) {
        collected.push(this.mapLogEnvelope(row));
      }
    }
    return collected;
  }

  private readLogTail(input: ReadLogInput): LogEnvelope[] {
    this.ensureReady();
    const limit = input.limit == null ? null : Math.max(Math.trunc(input.limit), 0);
    if (limit === 0) return [];
    if (limit == null) return this.readLog(input);
    const collected: JsonRecord[] = [];
    for (const segment of this.logLineage(input.logId, input.head)) {
      const remaining = limit - collected.length;
      if (remaining <= 0) break;
      const { where, bindings } = this.logEventWhereForSegment(segment, input);
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE ${where} ORDER BY seq DESC LIMIT ?`,
          ...bindings,
          remaining
        )
        .toArray() as JsonRecord[];
      collected.push(...rows);
    }
    return collected.reverse().map((row) => this.mapLogEnvelope(row));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getLogEvent(input: { logId: string; head: string; envelopeId: string }): LogEnvelope | null {
    this.ensureReady();
    const row = this.lineageEventRow(input.logId, input.head, input.envelopeId);
    return row ? this.mapLogEnvelope(row) : null;
  }

  private lineageEventRow(logId: string, head: string, envelopeId: string): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      const clauses = ["log_id = ?", "head = ?", "envelope_id = ?"];
      const bindings: SqlBinding[] = [segment.logId, segment.head, envelopeId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const row = this.sql
        .exec(`SELECT * FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`, ...bindings)
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }
  private lineageEventBySeq(logId: string, head: string, seq: number): JsonRecord | null {
    for (const segment of this.logLineage(logId, head)) {
      if (Number.isFinite(segment.throughSeq) && seq > segment.throughSeq) continue;
      const row = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? AND seq = ? LIMIT 1`,
          segment.logId,
          segment.head,
          seq
        )
        .toArray()[0] as JsonRecord | undefined;
      if (row) return row;
    }
    return null;
  }

  private lineageEventCountThrough(logId: string, head: string, throughSeq: number): number {
    let count = 0;
    for (const segment of this.logLineage(logId, head)) {
      const cap = Number.isFinite(segment.throughSeq)
        ? Math.min(segment.throughSeq, throughSeq)
        : throughSeq;
      count += asNumber(
        this.sql
          .exec(
            `SELECT COUNT(*) AS cnt FROM log_events WHERE log_id = ? AND head = ? AND seq <= ?`,
            segment.logId,
            segment.head,
            cap
          )
          .one()["cnt"]
      );
    }
    return count;
  }

  @rpc({ callers: ["do", "server"] })
  async appendLogEvent(input: AppendLogEventInput): Promise<AppendLogEventResult> {
    this.ensureReady();
    return this.transaction(() => this.appendLogEventInTxn(input));
  }

  private appendLogEventInTxn(input: AppendLogEventInput): AppendLogEventResult {
    if (!input.logId) throw new Error("appendLogEvent requires logId");
    if (!input.head) throw new Error("appendLogEvent requires head");
    if (!input.events.length) throw new Error("appendLogEvent requires at least one event");

    const existingHead = this.logHeadRow(input.logId, input.head);
    if (existingHead && String(existingHead["log_kind"]) !== String(input.logKind)) {
      throw new Error(
        `log kind mismatch for ${input.logId}:${input.head}: ` +
          `${String(existingHead["log_kind"])} != ${String(input.logKind)}`
      );
    }
    const logKind = existingHead ? String(existingHead["log_kind"]) : String(input.logKind);

    const prepared = input.events.map((event) => this.prepareLogEvent(logKind, event));

    // Lineage-scoped idempotent replay: skip the longest already-applied prefix.
    const replayed: LogEnvelope[] = [];
    for (const event of prepared) {
      const existing = existingHead
        ? this.lineageEventRow(input.logId, input.head, event.envelopeId)
        : null;
      if (!existing) break;
      const stored = this.mapLogEnvelope(existing);
      const incomingSemantic = this.semanticSlice({
        ...event,
        appendedAt: event.appendedAtExplicit ? event.appendedAt : stored.appendedAt,
      });
      const storedSemantic = this.semanticSlice(stored);
      if (stableJson(incomingSemantic) !== stableJson(storedSemantic)) {
        if (input.idempotency === "idempotent-by-id") {
          // Client retry with a stable id and volatile payload fields:
          // first write wins, the journaled original is the result.
          replayed.push(stored);
          continue;
        }
        throw new Error(
          gadAppendErrorMessage(
            "id-collision",
            `log envelope id collision with different content: ${event.envelopeId}`
          )
        );
      }
      replayed.push(stored);
    }
    for (const event of prepared.slice(replayed.length)) {
      if (existingHead && this.lineageEventRow(input.logId, input.head, event.envelopeId)) {
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            "log append replay has already-applied events after a new suffix"
          )
        );
      }
    }
    const remaining = prepared.slice(replayed.length);

    if (!existingHead) {
      this.sql.exec(
        `INSERT INTO log_heads (log_id, head, log_kind, owner_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.logId,
        input.head,
        logKind,
        json(input.owner ?? null),
        nowIso()
      );
    }

    const pointer = this.headPointer(input.logId, input.head);
    if (
      replayed.length === 0 &&
      "expectedHeadHash" in input &&
      (input.expectedHeadHash ?? GENESIS_EVENT_HASH) !== pointer.hash
    ) {
      throw new Error(
        gadAppendErrorMessage("head-conflict", `log head conflict for ${input.logId}:${input.head}`)
      );
    }
    if (remaining.length > 0 && replayed.length > 0) {
      const lastReplayed = replayed[replayed.length - 1]!;
      if (lastReplayed.hash !== pointer.hash) {
        throw new Error(
          gadAppendErrorMessage(
            "replay-mismatch",
            "log append replay prefix is not the current head"
          )
        );
      }
    }

    const published: AppendLogEventResult["published"] = [];
    // Recover the publication list for replayed events from the causality edges.
    for (const envelope of replayed) {
      for (const publication of this.publicationsForOrigin(
        input.logId,
        input.head,
        String(envelope.envelopeId)
      )) {
        published.push(publication);
      }
    }

    const appended: LogEnvelope[] = [];
    let seq = pointer.seq;
    let prevHash = pointer.hash;
    for (const event of remaining) {
      if (
        AGENTIC_LOG_KINDS.has(logKind) &&
        event.payloadKind === "turn.opened" &&
        event.causality?.turnId
      ) {
        this.assertTurnNotOpened(input.logId, input.head, event.causality.turnId, appended);
      }
      seq += 1;
      const semantic = this.semanticSlice(event);
      const hash = this.computeEnvelopeHash(input.logId, input.head, seq, prevHash, semantic);
      const envelope: LogEnvelope = {
        logId: input.logId,
        head: input.head,
        seq,
        envelopeId: brandId<EnvelopeId>(event.envelopeId),
        actor: event.actor,
        ...(event.to !== undefined ? { to: event.to } : {}),
        payloadKind: event.payloadKind,
        payload: event.payload,
        ...(event.annotations !== undefined ? { annotations: event.annotations } : {}),
        ...(event.causality !== undefined ? { causality: event.causality } : {}),
        appendedAt: event.appendedAt,
        prevHash,
        hash,
      };
      this.insertLogEvent(envelope);
      this.applyProjections(logKind, envelope);
      prevHash = hash;
      appended.push(envelope);

      for (const target of event.publish) {
        const pubEnvelopeId = `pub:${event.envelopeId}:${target.channelId}`;
        const result = this.appendLogEventInTxn({
          logId: target.channelId,
          head: CHANNEL_LOG_HEAD,
          logKind: "channel",
          events: [
            {
              envelopeId: pubEnvelopeId,
              actor: event.actor,
              to: (target.audience ?? null) as LogAppendEventInput["to"],
              payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
              payload: agenticEventFromEnvelope(envelope),
              causality: {
                originLogId: input.logId,
                originHead: input.head,
                originEnvelopeId: event.envelopeId,
              },
              appendedAt: event.appendedAt,
            },
          ],
        });
        void result;
        published.push({
          originEnvelopeId: event.envelopeId,
          channelId: target.channelId,
          envelopeId: pubEnvelopeId,
        });
      }
    }

    if (appended.length > 0) {
      const last = appended[appended.length - 1]!;
      this.updateRefInternal({
        refName: this.logHeadRefName(input.logId, input.head),
        kind: "log-head",
        target: { seq: last.seq, hash: last.hash, envelopeId: String(last.envelopeId) },
      });
    }

    const finalPointer = this.headPointer(input.logId, input.head);
    return {
      logId: input.logId,
      head: input.head,
      headSeq: finalPointer.seq,
      headHash: finalPointer.hash,
      envelopes: [...replayed, ...appended],
      published,
    };
  }

  private publicationsForOrigin(
    originLogId: string,
    originHead: string,
    originEnvelopeId: string
  ): AppendLogEventResult["published"] {
    const rows = this.sql
      .exec(
        `SELECT log_id, envelope_id FROM log_events
         WHERE origin_log_id = ? AND origin_head = ? AND origin_envelope_id = ?
         ORDER BY log_id ASC, seq ASC`,
        originLogId,
        originHead,
        originEnvelopeId
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => ({
      originEnvelopeId,
      channelId: String(row["log_id"]),
      envelopeId: String(row["envelope_id"]),
    }));
  }

  private assertTurnNotOpened(
    logId: string,
    head: string,
    turnId: string,
    pendingBatch: LogEnvelope[]
  ): void {
    for (const envelope of pendingBatch) {
      if (envelope.payloadKind === "turn.opened" && envelope.causality?.turnId === turnId) {
        throw new Error(`duplicate turn.opened for turn ${turnId}`);
      }
    }
    for (const segment of this.logLineage(logId, head)) {
      const clauses = ["log_id = ?", "head = ?", "payload_kind = 'turn.opened'", "turn_id = ?"];
      const bindings: SqlBinding[] = [segment.logId, segment.head, turnId];
      if (Number.isFinite(segment.throughSeq)) {
        clauses.push("seq <= ?");
        bindings.push(segment.throughSeq);
      }
      const exists = this.sql
        .exec(`SELECT 1 AS ok FROM log_events WHERE ${clauses.join(" AND ")} LIMIT 1`, ...bindings)
        .toArray()[0];
      if (exists) throw new Error(`duplicate turn.opened for turn ${turnId}`);
    }
  }

  /** Validate + sanitize one append input into its storable form. */
  private prepareLogEvent(logKind: string, input: LogAppendEventInput): PreparedLogEvent {
    if (!input.payloadKind) throw new Error("appendLogEvent requires payloadKind");
    const envelopeId = input.envelopeId ?? crypto.randomUUID();
    const appendedAtExplicit = input.appendedAt != null;
    const appendedAt = input.appendedAt ?? nowIso();
    const actor = publicParticipantRef(input.actor) as ParticipantRef;
    const to = sanitizeAudience(input.to ?? undefined);
    let payload = input.payload;
    const causality = input.causality ?? undefined;
    let annotations = input.annotations ?? undefined;
    if (annotations && "metadata" in annotations && annotations["metadata"] != null) {
      annotations = {
        ...annotations,
        metadata: publicParticipantMetadata(annotations["metadata"] as Record<string, unknown>),
      };
    }

    const agenticKind = AGENTIC_LOG_KINDS.has(logKind) && isStoredEventKind(input.payloadKind);
    if (agenticKind) {
      const causalityForEvent = agenticCausality(causality);
      const reconstructed = storedAgenticEventSchema.parse({
        kind: input.payloadKind,
        actor: input.actor,
        ...(causality?.turnId ? { turnId: causality.turnId } : {}),
        ...(causalityForEvent ? { causality: causalityForEvent } : {}),
        payload,
        createdAt: appendedAt,
      }) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(reconstructed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = sanitized.payload;
      if (STATE_TRANSITION_KINDS.has(input.payloadKind)) {
        this.assertStateTransitionPayloadValid(input.payloadKind, payload);
      }
    } else if (input.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      if (!isAgenticEventPayload(payload)) {
        throw new Error("agentic channel payload must be a stored agentic event");
      }
      const parsed = storedAgenticEventSchema.parse(payload) as AgenticEvent;
      const sanitized = sanitizeAgenticEventParticipantRefs(parsed);
      assertAgenticEventStoredValuesEncoded(sanitized);
      payload = sanitized;
    }

    return {
      envelopeId,
      appendedAtExplicit,
      actor,
      ...(to !== undefined ? { to } : {}),
      payloadKind: input.payloadKind,
      payload,
      ...(annotations !== undefined ? { annotations } : {}),
      ...(causality !== undefined ? { causality } : {}),
      appendedAt,
      publish: input.publish?.channels ?? [],
    };
  }

  /** Snapshot/merge events reference pre-created VALUES; reject appends whose
   *  output state does not exist. */
  private assertStateTransitionPayloadValid(payloadKind: string, payload: unknown): void {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const outputStateHash = asString(record["outputStateHash"]);
    if (!outputStateHash) {
      throw new Error(`${payloadKind} requires payload.outputStateHash`);
    }
    if (!this.stateExists(outputStateHash)) {
      throw new Error(`${payloadKind} output state value does not exist: ${outputStateHash}`);
    }
  }

  private insertLogEvent(envelope: LogEnvelope): void {
    this.sql.exec(
      `INSERT INTO log_events (
         log_id, head, seq, envelope_id, payload_kind, actor_json, to_json,
         causality_json, annotations_json, payload_ref_json, appended_at,
         hash, prev_hash, origin_log_id, origin_head, origin_envelope_id, turn_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.logId,
      envelope.head,
      envelope.seq,
      String(envelope.envelopeId),
      envelope.payloadKind,
      JSON.stringify(envelope.actor),
      envelope.to !== undefined ? JSON.stringify(envelope.to) : null,
      json(envelope.causality),
      json(envelope.annotations),
      JSON.stringify(envelope.payload),
      envelope.appendedAt,
      envelope.hash,
      envelope.prevHash,
      envelope.causality?.originLogId ?? null,
      envelope.causality?.originHead ?? null,
      envelope.causality?.originEnvelopeId ?? null,
      envelope.causality?.turnId ?? null
    );
    for (const { path, ref } of collectStoredValueRefs(envelope.payload)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO log_blob_refs (
           log_id, head, envelope_id, field_path, digest, purpose, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        String(envelope.envelopeId),
        path,
        ref.digest,
        "payload",
        ref.size,
        nowIso()
      );
      this.ensureBlob(
        ref.digest,
        ref.size,
        ref.encoding === "json" ? "application/json" : "text/plain"
      );
    }
  }

  @rpc({ callers: ["do", "server"] })
  forkLog(input: ForkLogInput): ForkLogResult {
    this.ensureReady();
    return this.transaction(() => {
      if (!input.fromLogId || !input.fromHead) throw new Error("forkLog requires a source");
      if (!input.toLogId || !input.toHead) throw new Error("forkLog requires a target");
      if (input.fromLogId === input.toLogId && input.fromHead === input.toHead) {
        throw new Error("forkLog requires distinct source and target");
      }
      const sourceRow = this.logHeadRow(input.fromLogId, input.fromHead);
      if (!sourceRow) {
        throw new Error(`forkLog source does not exist: ${input.fromLogId}:${input.fromHead}`);
      }
      const sourcePointer = this.headPointer(input.fromLogId, input.fromHead, sourceRow);
      const forkSeq = input.atSeq ?? sourcePointer.seq;
      if (forkSeq > sourcePointer.seq) {
        throw new Error(`forkLog atSeq ${forkSeq} is beyond the source head ${sourcePointer.seq}`);
      }
      let forkHash = GENESIS_EVENT_HASH;
      let forkEnvelopeId: string | null = null;
      if (forkSeq > 0) {
        const eventRow = this.lineageEventBySeq(input.fromLogId, input.fromHead, forkSeq);
        if (!eventRow) throw new Error(`forkLog atSeq ${forkSeq} not found in source lineage`);
        forkHash = String(eventRow["hash"]);
        forkEnvelopeId = String(eventRow["envelope_id"]);
      }

      const existing = this.logHeadRow(input.toLogId, input.toHead);
      if (existing) {
        if (
          asString(existing["parent_log_id"]) !== input.fromLogId ||
          asString(existing["parent_head"]) !== input.fromHead ||
          asNumber(existing["fork_seq"]) !== forkSeq ||
          asString(existing["fork_hash"]) !== forkHash
        ) {
          throw new Error(
            `target log already exists with different fork lineage: ${input.toLogId}:${input.toHead}`
          );
        }
        return {
          fromLogId: input.fromLogId,
          fromHead: input.fromHead,
          toLogId: input.toLogId,
          toHead: input.toHead,
          forkSeq,
          forkHash,
          inherited: this.lineageEventCountThrough(input.toLogId, input.toHead, forkSeq),
        };
      }

      const logKind = String(sourceRow["log_kind"]);
      this.sql.exec(
        `INSERT INTO log_heads (
           log_id, head, log_kind, owner_json, parent_log_id, parent_head,
           fork_seq, fork_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.toLogId,
        input.toHead,
        logKind,
        json(input.owner ?? parseJson(asString(sourceRow["owner_json"]))),
        input.fromLogId,
        input.fromHead,
        forkSeq,
        forkHash,
        nowIso()
      );
      this.updateRefInternal({
        refName: this.logHeadRefName(input.toLogId, input.toHead),
        kind: "log-head",
        target: { seq: forkSeq, hash: forkHash, envelopeId: forkEnvelopeId },
        expected: null,
      });

      // Seed the child's projection caches (P1: caches, rebuildable) by folding
      // the inherited lineage view under the child key. No log rows are copied.
      const inherited = this.readLog({
        logId: input.toLogId,
        head: input.toHead,
        limit: 0,
      });
      for (const envelope of inherited) {
        this.applyProjections(logKind, {
          ...envelope,
          logId: input.toLogId,
          head: input.toHead,
        });
      }

      return {
        fromLogId: input.fromLogId,
        fromHead: input.fromHead,
        toLogId: input.toLogId,
        toHead: input.toHead,
        forkSeq,
        forkHash,
        inherited: inherited.length,
      };
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  async checkLogIntegrity(
    input: { logId?: string | null; head?: string | null } = {}
  ): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    this.ensureReady();
    const errors: JsonRecord[] = [];
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.logId) {
      clauses.push("log_id = ?");
      bindings.push(input.logId);
    }
    if (input.head) {
      clauses.push("head = ?");
      bindings.push(input.head);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const heads = this.sql
      .exec(`SELECT * FROM log_heads ${where} ORDER BY log_id, head`, ...bindings)
      .toArray() as JsonRecord[];
    for (const headRow of heads) {
      const logId = String(headRow["log_id"]);
      const head = String(headRow["head"]);
      const startSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
      const startHash = asString(headRow["fork_hash"]) ?? GENESIS_EVENT_HASH;
      const rows = this.sql
        .exec(
          `SELECT * FROM log_events WHERE log_id = ? AND head = ? ORDER BY seq ASC`,
          logId,
          head
        )
        .toArray() as JsonRecord[];
      let expectedSeq = startSeq;
      let prevHash = startHash;
      for (const row of rows) {
        const envelope = this.mapLogEnvelope(row);
        expectedSeq += 1;
        if (envelope.seq !== expectedSeq) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq gap: expected ${expectedSeq}, found ${envelope.seq}`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
          expectedSeq = envelope.seq;
        }
        if (envelope.prevHash !== prevHash) {
          errors.push({
            type: "log-chain",
            message: `log ${logId}:${head} seq ${envelope.seq} prevHash does not link`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        const recomputed = this.computeEnvelopeHash(
          logId,
          head,
          envelope.seq,
          envelope.prevHash,
          this.semanticSlice(envelope)
        );
        if (recomputed !== envelope.hash) {
          errors.push({
            type: "log-hash",
            message: `log ${logId}:${head} seq ${envelope.seq} hash mismatch (${String(envelope.envelopeId)})`,
            logId,
            head,
            envelopeId: String(envelope.envelopeId),
          });
        }
        prevHash = envelope.hash;
      }
      const pointer = this.headPointer(logId, head, headRow);
      const lastSeq = rows.length > 0 ? asNumber(rows[rows.length - 1]!["seq"]) : startSeq;
      const lastHash = rows.length > 0 ? String(rows[rows.length - 1]!["hash"]) : startHash;
      if (pointer.seq !== lastSeq || pointer.hash !== lastHash) {
        errors.push({
          type: "log-head-ref",
          message: `log head ref disagrees with the stored chain for ${logId}:${head}`,
          logId,
          head,
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // Projections (caches over the log — P1; rebuildable at any time — P3)
  // -------------------------------------------------------------------------

  private applyProjections(logKind: string, envelope: LogEnvelope): void {
    if (envelope.payloadKind === "presence") {
      this.applyChannelRosterProjection(envelope);
      return;
    }
    if (envelope.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      this.projectMessageTypeEvent(envelope);
      return;
    }
    if (!AGENTIC_LOG_KINDS.has(logKind) || !isStoredEventKind(envelope.payloadKind)) return;
    const kind = envelope.payloadKind;
    if (kind === "turn.opened" || kind === "turn.closed") {
      this.projectTurn(envelope);
      return;
    }
    if (kind.startsWith("message.")) {
      this.projectMessage(envelope);
      return;
    }
    if (kind.startsWith("invocation.")) {
      this.projectInvocation(envelope);
      return;
    }
    if (kind.startsWith("approval.")) {
      this.projectApproval(envelope);
      return;
    }
    if (STATE_TRANSITION_KINDS.has(kind)) {
      this.projectStateTransition(envelope);
      return;
    }
    if (kind.startsWith("knowledge.")) {
      this.projectKnowledge(envelope);
    }
  }

  private projectTurn(envelope: LogEnvelope): void {
    const turnId = envelope.causality?.turnId;
    if (!turnId) return;
    const payload = envelope.payload as JsonRecord;
    if (envelope.payloadKind === "turn.opened") {
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_turns (log_id, head, turn_id, opened_at, summary)
         VALUES (?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        turnId,
        envelope.appendedAt,
        asString(payload["summary"])
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO trajectory_turns (log_id, head, turn_id, closed_at, summary)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, turn_id) DO UPDATE SET
         closed_at = excluded.closed_at,
         summary = COALESCE(excluded.summary, trajectory_turns.summary)`,
      envelope.logId,
      envelope.head,
      turnId,
      envelope.appendedAt,
      asString(payload["summary"])
    );
  }

  private projectMessage(envelope: LogEnvelope): void {
    const messageId = envelope.causality?.messageId;
    if (!messageId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT role FROM trajectory_messages WHERE log_id = ? AND head = ? AND message_id = ?`,
        envelope.logId,
        envelope.head,
        messageId
      )
      .toArray()[0] as JsonRecord | undefined;
    const status =
      kind === "message.completed"
        ? "completed"
        : kind === "message.failed"
          ? "failed"
          : kind === "message.delta"
            ? "streaming"
            : "started";
    this.sql.exec(
      `INSERT INTO trajectory_messages (
         log_id, head, message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, message_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_messages.turn_id, excluded.turn_id),
         role = COALESCE(excluded.role, trajectory_messages.role),
         status = excluded.status,
         started_event_id = COALESCE(trajectory_messages.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_messages.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      messageId,
      envelope.causality?.turnId ?? null,
      asString(payload["role"]) ?? asString(existing?.["role"]) ?? envelope.actor.kind,
      status,
      kind === "message.started" ? String(envelope.envelopeId) : null,
      kind === "message.completed" || kind === "message.failed"
        ? String(envelope.envelopeId)
        : null,
      nowIso()
    );

    const blocks = Array.isArray(payload["blocks"]) ? payload["blocks"] : [];
    const memoryTexts: string[] = [];
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return;
      const record = block as JsonRecord;
      const blockId = asString(record["blockId"]) ?? `${messageId}:block:${index}`;
      this.sql.exec(
        `INSERT OR REPLACE INTO trajectory_message_blocks (
           log_id, head, block_id, message_id, block_index, block_type, invocation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        blockId,
        messageId,
        index,
        asString(record["type"]) ?? "data",
        asString(record["invocationId"])
      );
      if (record["type"] === "text" && typeof record["content"] === "string") {
        memoryTexts.push(record["content"]);
      }
    });
    // Memory index (WS4): completed message text becomes searchable.
    if (kind === "message.completed" && memoryTexts.length > 0) {
      this.indexMemoryRow({
        text: memoryTexts.join("\n"),
        kind: "message",
        logId: envelope.logId,
        head: envelope.head,
        eventId: String(envelope.envelopeId),
        anchor: { messageId, turnId: envelope.causality?.turnId ?? null },
      });
    }
  }

  private projectInvocation(envelope: LogEnvelope): void {
    const invocationId = envelope.causality?.invocationId;
    if (!invocationId) return;
    const kind = envelope.payloadKind;
    const existing = this.sql
      .exec(
        `SELECT * FROM trajectory_invocations WHERE log_id = ? AND head = ? AND invocation_id = ?`,
        envelope.logId,
        envelope.head,
        invocationId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (
      TERMINAL_INVOCATION_KINDS.has(kind) &&
      existing &&
      TERMINAL_INVOCATION_KINDS.has(`invocation.${String(existing["status"])}`)
    ) {
      if (
        this.matchesExistingTerminalInvocation(envelope, existing) ||
        this.matchesExistingTerminalProjection(envelope, existing)
      ) {
        return;
      }
      throw new Error(`duplicate terminal invocation event for ${invocationId}`);
    }
    const payload = envelope.payload as JsonRecord;
    if (kind === "invocation.output" || kind === "invocation.progress") {
      this.sql.exec(
        `INSERT OR IGNORE INTO trajectory_invocation_outputs (
           log_id, head, invocation_id, seq, chunk_ref_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        envelope.logId,
        envelope.head,
        invocationId,
        envelope.seq,
        JSON.stringify(payload),
        envelope.appendedAt
      );
    }
    this.sql.exec(
      `INSERT INTO trajectory_invocations (
         log_id, head, invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome,
         terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, invocation_id) DO UPDATE SET
         turn_id = COALESCE(trajectory_invocations.turn_id, excluded.turn_id),
         transport_call_id = COALESCE(excluded.transport_call_id, trajectory_invocations.transport_call_id),
         kind = COALESCE(excluded.kind, trajectory_invocations.kind),
         status = excluded.status,
         terminal_outcome = COALESCE(excluded.terminal_outcome, trajectory_invocations.terminal_outcome),
         terminal_reason_code = COALESCE(excluded.terminal_reason_code, trajectory_invocations.terminal_reason_code),
         request_ref_json = COALESCE(excluded.request_ref_json, trajectory_invocations.request_ref_json),
         result_ref_json = COALESCE(excluded.result_ref_json, trajectory_invocations.result_ref_json),
         started_event_id = COALESCE(trajectory_invocations.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_invocations.completed_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      invocationId,
      envelope.causality?.turnId ?? null,
      envelope.causality?.transportCallId ?? null,
      asString(payload["name"]),
      kind.replace("invocation.", ""),
      asString(payload["terminalOutcome"]),
      asString(payload["terminalReasonCode"]),
      kind === "invocation.started" ? json(payload["request"]) : null,
      kind === "invocation.completed" ? json(payload["result"]) : null,
      kind === "invocation.started" ? String(envelope.envelopeId) : null,
      TERMINAL_INVOCATION_KINDS.has(kind) ? String(envelope.envelopeId) : null,
      nowIso()
    );
  }

  private matchesExistingTerminalInvocation(envelope: LogEnvelope, existing: JsonRecord): boolean {
    const completedEventId = asString(existing["completed_event_id"]);
    if (!completedEventId) return false;
    const priorRow = this.lineageEventRow(envelope.logId, envelope.head, completedEventId);
    if (!priorRow) return false;
    const prior = this.mapLogEnvelope(priorRow);
    return (
      terminalInvocationSignatureFromEnvelope(prior) ===
      terminalInvocationSignatureFromEnvelope(envelope)
    );
  }

  private matchesExistingTerminalProjection(envelope: LogEnvelope, existing: JsonRecord): boolean {
    const payload = envelope.payload as JsonRecord;
    const nextStatus = envelope.payloadKind.replace("invocation.", "");
    if (asString(existing["status"]) !== nextStatus) return false;
    if (asString(existing["terminal_outcome"]) !== asString(payload["terminalOutcome"])) {
      return false;
    }
    // The first terminal event owns the projection. Later terminals with the
    // same status/outcome can be replays from runner recovery; preserve the
    // first row, keep the raw duplicate in the log.
    return true;
  }

  private projectApproval(envelope: LogEnvelope): void {
    const approvalId = envelope.causality?.approvalId;
    if (!approvalId) return;
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const status =
      kind === "approval.resolved"
        ? payload["granted"] === true
          ? "granted"
          : "denied"
        : "requested";
    // Approvals resolve once: reject a second terminal against an already
    // granted/denied approval so a duplicate cannot overwrite the decision.
    if (kind === "approval.resolved") {
      const existing = this.sql
        .exec(
          `SELECT status FROM trajectory_approvals WHERE log_id = ? AND head = ? AND approval_id = ?`,
          envelope.logId,
          envelope.head,
          approvalId
        )
        .toArray()[0] as JsonRecord | undefined;
      const existingStatus = existing ? String(existing["status"]) : null;
      if (existingStatus === "granted" || existingStatus === "denied") {
        throw new Error(`duplicate terminal approval event for ${approvalId}`);
      }
    }
    this.sql.exec(
      `INSERT INTO trajectory_approvals (
         log_id, head, approval_id, invocation_id, status, requested_by_json, resolved_by_json,
         requested_event_id, resolved_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id, head, approval_id) DO UPDATE SET
         status = excluded.status,
         resolved_by_json = COALESCE(excluded.resolved_by_json, trajectory_approvals.resolved_by_json),
         resolved_event_id = COALESCE(excluded.resolved_event_id, trajectory_approvals.resolved_event_id),
         updated_at = excluded.updated_at`,
      envelope.logId,
      envelope.head,
      approvalId,
      envelope.causality?.invocationId ?? null,
      status,
      kind === "approval.requested" ? JSON.stringify(envelope.actor) : null,
      kind === "approval.resolved" ? json(payload["resolvedBy"]) : null,
      kind === "approval.requested" ? String(envelope.envelopeId) : null,
      kind === "approval.resolved" ? String(envelope.envelopeId) : null,
      nowIso()
    );
  }

  /** Generic state-transition projector (P5 applied to worktree events):
   *  snapshot ingest and merge transitions are handled uniformly — parent rows
   *  and ref advance included. */
  private projectStateTransition(envelope: LogEnvelope): void {
    const payload = envelope.payload as JsonRecord;
    const kind = envelope.payloadKind;
    const eventId = String(envelope.envelopeId);
    const invocationId =
      envelope.causality?.invocationId ?? asString(payload["invocationId"]) ?? null;
    const inputStateHash =
      asString(payload["inputStateHash"]) ?? this.latestStateHash(envelope.logId, envelope.head);
    const extraParents = Array.isArray(payload["parentStateHashes"])
      ? (payload["parentStateHashes"] as unknown[]).map((value) => String(value))
      : [];

    const declared = asString(payload["outputStateHash"]);
    if (!declared) throw new Error(`${kind} requires payload.outputStateHash`);
    if (!this.stateExists(declared)) {
      throw new Error(`${kind} output state value does not exist: ${declared}`);
    }
    const outputStateHash = declared;

    this.sql.exec(
      `INSERT OR IGNORE INTO gad_state_transitions (
         event_id, invocation_id, input_state_hash, output_state_hash,
         produced_by_mutation_id, summary, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      invocationId,
      inputStateHash,
      outputStateHash,
      asString(payload["mutationId"]) ?? null,
      asString(payload["summary"]) ?? asString(payload["rationale"]),
      JSON.stringify(payload),
      envelope.appendedAt
    );
    const parents = [inputStateHash, ...extraParents];
    parents.forEach((parentStateHash, ordinal) => {
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_transition_parents (event_id, parent_state_hash, ordinal)
         VALUES (?, ?, ?)`,
        eventId,
        parentStateHash,
        ordinal
      );
    });

    this.updateRefInternal({
      refName: this.worktreeRefName(envelope.logId, envelope.head),
      kind: "worktree-branch",
      target: { stateHash: outputStateHash },
    });
  }

  private projectKnowledge(envelope: LogEnvelope): void {
    const payload = envelope.payload as JsonRecord;
    if (!envelope.payloadKind.startsWith("knowledge.claim_")) return;
    const claimId =
      asString(payload["claimId"]) ?? asString(payload["id"]) ?? String(envelope.envelopeId);
    if (envelope.payloadKind === "knowledge.claim_retracted") {
      this.sql.exec(
        `UPDATE gad_claims SET status = 'retracted', trajectory_event_id = ?, updated_at = ? WHERE claim_id = ?`,
        String(envelope.envelopeId),
        envelope.appendedAt,
        claimId
      );
      return;
    }
    if (
      envelope.payloadKind !== "knowledge.claim_recorded" &&
      envelope.payloadKind !== "knowledge.claim_updated"
    ) {
      return;
    }
    this.sql.exec(
      `INSERT INTO gad_claims (
         claim_id, trajectory_event_id, invocation_id, subject, predicate, object,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_id) DO UPDATE SET
         trajectory_event_id = excluded.trajectory_event_id,
         subject = COALESCE(excluded.subject, gad_claims.subject),
         predicate = COALESCE(excluded.predicate, gad_claims.predicate),
         object = COALESCE(excluded.object, gad_claims.object),
         status = excluded.status,
         updated_at = excluded.updated_at`,
      claimId,
      String(envelope.envelopeId),
      envelope.causality?.invocationId ?? null,
      asString(payload["subject"]),
      asString(payload["predicate"]),
      asString(payload["object"]),
      asString(payload["status"]) ?? "active",
      envelope.appendedAt,
      envelope.appendedAt
    );
    // Memory index (WS4): claims are the semantic sidecar's retrieval surface.
    const claimText = [payload["subject"], payload["predicate"], payload["object"]]
      .map((value) => asString(value))
      .filter(Boolean)
      .join(" ");
    if (claimText) {
      this.indexMemoryRow({
        text: claimText,
        kind: "claim",
        logId: envelope.logId,
        head: envelope.head,
        eventId: String(envelope.envelopeId),
        anchor: { claimId },
      });
    }
  }

  private applyChannelRosterProjection(envelope: LogEnvelope): void {
    const payload =
      envelope.payload && typeof envelope.payload === "object"
        ? (envelope.payload as JsonRecord)
        : {};
    const action = asString(payload["action"]);
    if (action !== "join" && action !== "update" && action !== "leave") return;
    const actor = envelope.actor as unknown as JsonRecord;
    const participantId = asString(actor["participantId"]) ?? asString(actor["id"]);
    if (!participantId) return;
    const channelId = envelope.logId;
    const metadata = parseRecord(
      JSON.stringify(
        payload["metadata"] ?? envelope.annotations?.["metadata"] ?? actor["metadata"] ?? null
      )
    );
    const rolesJson = Object.keys(metadata).length > 0 ? JSON.stringify(sortJson(metadata)) : null;
    const openRow = this.sql
      .exec(
        `SELECT joined_at FROM channel_roster
         WHERE channel_id = ? AND participant_id = ? AND left_at IS NULL
         ORDER BY joined_at DESC
         LIMIT 1`,
        channelId,
        participantId
      )
      .toArray()[0] as JsonRecord | undefined;

    if (action === "join") {
      if (openRow) {
        if (rolesJson) {
          this.sql.exec(
            `UPDATE channel_roster
             SET roles_json = ?
             WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
            rolesJson,
            channelId,
            participantId,
            String(openRow["joined_at"])
          );
        }
        return;
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_roster (channel_id, participant_id, joined_at, roles_json)
         VALUES (?, ?, ?, ?)`,
        channelId,
        participantId,
        envelope.appendedAt,
        rolesJson
      );
      return;
    }

    if (!openRow) return;
    if (action === "update") {
      if (rolesJson) {
        this.sql.exec(
          `UPDATE channel_roster
           SET roles_json = ?
           WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
          rolesJson,
          channelId,
          participantId,
          String(openRow["joined_at"])
        );
      }
      return;
    }

    this.sql.exec(
      `UPDATE channel_roster
       SET left_at = COALESCE(left_at, ?),
           roles_json = COALESCE(?, roles_json)
       WHERE channel_id = ? AND participant_id = ? AND joined_at = ?`,
      envelope.appendedAt,
      rolesJson,
      channelId,
      participantId,
      String(openRow["joined_at"])
    );
  }

  // -------------------------------------------------------------------------
  // Recursive manifests & worktree states (content-addressed VALUES — P1)
  // -------------------------------------------------------------------------

  private latestStateHash(logId: string, head: string): string {
    const ref = this.resolveRef({ refName: this.worktreeRefName(logId, head) });
    if (ref && ref.target && typeof ref.target === "object") {
      const stateHash = asString((ref.target as Record<string, unknown>)["stateHash"]);
      if (stateHash) return stateHash;
    }
    return EMPTY_STATE_HASH;
  }

  private ensureFileVersion(path: string, contentHash: string, mode: number): number {
    this.ensureBlob(contentHash);
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_file_versions (path, content_hash, mode, created_at)
       VALUES (?, ?, ?, ?)`,
      path,
      contentHash,
      mode,
      nowIso()
    );
    return asNumber(
      this.sql
        .exec(
          `SELECT id FROM gad_file_versions WHERE path = ? AND content_hash = ? AND mode = ?`,
          path,
          contentHash,
          mode
        )
        .one()["id"]
    );
  }

  private manifestRootForState(stateHash: string): string {
    const state = this.sql
      .exec(`SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!state) throw new Error(`Unknown worktree state: ${stateHash}`);
    return asString(state["manifest_root_hash"]) ?? EMPTY_MANIFEST_HASH;
  }

  private manifestEntries(manifestHash: string): JsonRecord[] {
    return this.sql
      .exec(
        `SELECT e.name, e.entry_kind, e.child_manifest_hash, e.file_version_id,
                f.content_hash, f.mode
         FROM gad_manifest_entries e
         LEFT JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.manifest_hash = ?
         ORDER BY e.name ASC`,
        manifestHash
      )
      .toArray() as JsonRecord[];
  }

  /** Canonical content hash of a dir node from its entry list. */
  private manifestHashForEntries(
    entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number }
      | { name: string; kind: "dir"; childHash: string }
    >
  ): string {
    // Shared implementation — MUST stay byte-identical to the server-side
    // local hashing (see @workspace/agentic-protocol worktree-hash.ts).
    return manifestHashForEntries(entries);
  }

  private storeManifestNode(
    entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number; fileVersionId: number }
      | { name: string; kind: "dir"; childHash: string }
    >
  ): string {
    const hash = this.manifestHashForEntries(
      entries.map((entry) =>
        entry.kind === "file"
          ? { name: entry.name, kind: "file", contentHash: entry.contentHash, mode: entry.mode }
          : { name: entry.name, kind: "dir", childHash: entry.childHash }
      )
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (manifest_hash, kind, created_at) VALUES (?, 'dir', ?)`,
      hash,
      nowIso()
    );
    for (const entry of entries) {
      this.sql.exec(
        `INSERT OR REPLACE INTO gad_manifest_entries (
           manifest_hash, name, entry_kind, child_manifest_hash, file_version_id
         ) VALUES (?, ?, ?, ?, ?)`,
        hash,
        entry.name,
        entry.kind,
        entry.kind === "dir" ? entry.childHash : null,
        entry.kind === "file" ? entry.fileVersionId : null
      );
    }
    return hash;
  }

  /** Build a recursive manifest tree from a flat file list; returns root hash.
   *  Structural sharing falls out of content addressing (OR IGNORE). */
  private createManifestTree(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>
  ): string {
    interface DirNode {
      dirs: Map<string, DirNode>;
      files: Map<string, { fileVersionId: number; contentHash: string; mode: number }>;
    }
    const root: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const segments = file.path.split("/");
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1]!, {
        fileVersionId: file.fileVersionId,
        contentHash: file.contentHash,
        mode: file.mode,
      });
    }
    const build = (node: DirNode): string => {
      const entries: Array<
        | { name: string; kind: "file"; contentHash: string; mode: number; fileVersionId: number }
        | { name: string; kind: "dir"; childHash: string }
      > = [];
      for (const [name, child] of node.dirs) {
        entries.push({ name, kind: "dir", childHash: build(child) });
      }
      for (const [name, file] of node.files) {
        entries.push({ name, kind: "file", ...file });
      }
      return this.storeManifestNode(entries);
    };
    if (files.length === 0) {
      this.ensureEmptyState();
      return EMPTY_MANIFEST_HASH;
    }
    return build(root);
  }

  private stateHashForRoot(rootHash: string): string {
    return stateHashForRoot(rootHash);
  }

  private createWorktreeState(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>,
    metadata: Record<string, unknown>
  ): string {
    const rootHash = this.createManifestTree(files);
    const stateHash = this.stateHashForRoot(rootHash);
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?)`,
      stateHash,
      rootHash,
      JSON.stringify(metadata),
      nowIso()
    );
    return stateHash;
  }

  /** Resolve the manifest hash of the dir at `path` (root when empty). */
  private manifestDirAtPath(stateHash: string, path: string | null | undefined): string | null {
    let manifestHash = this.manifestRootForState(stateHash);
    if (!path) return manifestHash;
    for (const segment of normalizePath(path).split("/")) {
      const entry = this.sql
        .exec(
          `SELECT * FROM gad_manifest_entries WHERE manifest_hash = ? AND name = ? LIMIT 1`,
          manifestHash,
          segment
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!entry || entry["entry_kind"] !== "dir" || !entry["child_manifest_hash"]) return null;
      manifestHash = String(entry["child_manifest_hash"]);
    }
    return manifestHash;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listManifest(input: { stateHash: string; path?: string | null }): JsonRecord[] {
    this.ensureReady();
    const dirHash = this.manifestDirAtPath(input.stateHash, input.path);
    if (!dirHash) return [];
    return this.manifestEntries(dirHash).map(
      (entry): JsonRecord =>
        entry["entry_kind"] === "dir"
          ? {
              name: String(entry["name"]),
              kind: "dir",
              childManifestHash: String(entry["child_manifest_hash"]),
            }
          : {
              name: String(entry["name"]),
              kind: "file",
              fileVersionId: asNumber(entry["file_version_id"]),
              contentHash: String(entry["content_hash"]),
              mode: asNumber(entry["mode"]),
            }
    );
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getSubtreeHash(input: { stateHash: string; path: string }): { subtreeHash: string | null } {
    this.ensureReady();
    const segments = normalizePath(input.path).split("/");
    let manifestHash: string | null = this.manifestRootForState(input.stateHash);
    for (let index = 0; index < segments.length; index += 1) {
      if (!manifestHash) return { subtreeHash: null };
      const entry = this.sql
        .exec(
          `SELECT * FROM gad_manifest_entries WHERE manifest_hash = ? AND name = ? LIMIT 1`,
          manifestHash,
          segments[index]!
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!entry) return { subtreeHash: null };
      if (index === segments.length - 1) {
        return {
          subtreeHash:
            entry["entry_kind"] === "dir"
              ? asString(entry["child_manifest_hash"])
              : (
                    this.sql
                      .exec(
                        `SELECT content_hash FROM gad_file_versions WHERE id = ?`,
                        asNumber(entry["file_version_id"])
                      )
                      .toArray()[0] as JsonRecord | undefined
                  )?.["content_hash"] != null
                ? String(
                    (
                      this.sql
                        .exec(
                          `SELECT content_hash FROM gad_file_versions WHERE id = ?`,
                          asNumber(entry["file_version_id"])
                        )
                        .one() as Record<string, unknown>
                    )["content_hash"]
                  )
                : null,
        };
      }
      if (entry["entry_kind"] !== "dir") return { subtreeHash: null };
      manifestHash = asString(entry["child_manifest_hash"]);
    }
    return { subtreeHash: null };
  }

  /** Batch form of getSubtreeHash — one DO round trip for a whole unit list
   *  (buildV2 EV computation hashes every workspace unit at once). */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getSubtreeHashes(input: { stateHash: string; paths: string[] }): {
    subtreeHashes: Record<string, string | null>;
  } {
    this.ensureReady();
    const subtreeHashes: Record<string, string | null> = {};
    for (const path of input.paths) {
      subtreeHashes[path] = this.getSubtreeHash({ stateHash: input.stateHash, path }).subtreeHash;
    }
    return { subtreeHashes };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  readGadFileAtState(input: { stateHash: string; path: string }): JsonRecord | null {
    this.ensureReady();
    const path = normalizePath(input.path);
    const segments = path.split("/");
    const dirHash = this.manifestDirAtPath(input.stateHash, segments.slice(0, -1).join("/"));
    if (!dirHash) return null;
    const entry = this.sql
      .exec(
        `SELECT e.*, f.content_hash, f.mode
         FROM gad_manifest_entries e
         LEFT JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.manifest_hash = ? AND e.name = ? AND e.entry_kind = 'file'
         LIMIT 1`,
        dirHash,
        segments[segments.length - 1]!
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!entry) return null;
    return {
      path,
      file_version_id: asNumber(entry["file_version_id"]),
      content_hash: String(entry["content_hash"]),
      mode: asNumber(entry["mode"]),
    };
  }

  private filesForState(stateHash: string): JsonRecord[] {
    const files: JsonRecord[] = [];
    const walk = (manifestHash: string, prefix: string): void => {
      for (const entry of this.manifestEntries(manifestHash)) {
        const name = String(entry["name"]);
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry["entry_kind"] === "dir") {
          const child = asString(entry["child_manifest_hash"]);
          if (child) walk(child, path);
        } else {
          files.push({
            path,
            file_version_id: asNumber(entry["file_version_id"]),
            content_hash: String(entry["content_hash"]),
            mode: asNumber(entry["mode"]),
          });
        }
      }
    };
    walk(this.manifestRootForState(stateHash), "");
    return files.sort((a, b) => String(a["path"]).localeCompare(String(b["path"])));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listGadBranchFiles(input: { branchId: string; trajectoryId?: string | null }): JsonRecord[] {
    this.ensureReady();
    const stateHash = input.trajectoryId
      ? this.latestStateHash(input.trajectoryId, input.branchId)
      : this.latestStateHashByHeadOnly(input.branchId);
    return this.filesForState(stateHash);
  }

  private latestStateHashByHeadOnly(head: string): string {
    const rows = this.listRefs({ kind: "worktree-branch" });
    for (const ref of rows) {
      if (ref.refName.endsWith(`:${head}`)) {
        const stateHash = asString((ref.target as Record<string, unknown>)["stateHash"]);
        if (stateHash) return stateHash;
      }
    }
    return EMPTY_STATE_HASH;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): {
    added: JsonRecord[];
    removed: JsonRecord[];
    changed: JsonRecord[];
  } {
    this.ensureReady();
    const added: JsonRecord[] = [];
    const removed: JsonRecord[] = [];
    const changed: JsonRecord[] = [];
    const collect = (manifestHash: string, prefix: string, sink: JsonRecord[]): void => {
      for (const entry of this.manifestEntries(manifestHash)) {
        const name = String(entry["name"]);
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry["entry_kind"] === "dir") {
          const child = asString(entry["child_manifest_hash"]);
          if (child) collect(child, path, sink);
        } else {
          sink.push({
            path,
            file_version_id: asNumber(entry["file_version_id"]),
            content_hash: String(entry["content_hash"]),
            mode: asNumber(entry["mode"]),
          });
        }
      }
    };
    const fileRecord = (entry: JsonRecord, path: string): JsonRecord => ({
      path,
      file_version_id: asNumber(entry["file_version_id"]),
      content_hash: String(entry["content_hash"]),
      mode: asNumber(entry["mode"]),
    });
    const walk = (leftHash: string | null, rightHash: string | null, prefix: string): void => {
      if (leftHash === rightHash) return; // structural-sharing prune
      const leftEntries = leftHash ? this.manifestEntries(leftHash) : [];
      const rightEntries = rightHash ? this.manifestEntries(rightHash) : [];
      const leftByName = new Map(leftEntries.map((entry) => [String(entry["name"]), entry]));
      const rightByName = new Map(rightEntries.map((entry) => [String(entry["name"]), entry]));
      for (const [name, rightEntry] of rightByName) {
        const path = prefix ? `${prefix}/${name}` : name;
        const leftEntry = leftByName.get(name);
        if (!leftEntry) {
          if (rightEntry["entry_kind"] === "dir") {
            const child = asString(rightEntry["child_manifest_hash"]);
            if (child) collect(child, path, added);
          } else {
            added.push(fileRecord(rightEntry, path));
          }
          continue;
        }
        if (leftEntry["entry_kind"] === "dir" && rightEntry["entry_kind"] === "dir") {
          walk(
            asString(leftEntry["child_manifest_hash"]),
            asString(rightEntry["child_manifest_hash"]),
            path
          );
        } else if (leftEntry["entry_kind"] === "file" && rightEntry["entry_kind"] === "file") {
          if (
            leftEntry["content_hash"] !== rightEntry["content_hash"] ||
            leftEntry["mode"] !== rightEntry["mode"]
          ) {
            changed.push({
              path,
              before: fileRecord(leftEntry, path),
              after: fileRecord(rightEntry, path),
            });
          }
        } else {
          if (leftEntry["entry_kind"] === "dir") {
            const child = asString(leftEntry["child_manifest_hash"]);
            if (child) collect(child, path, removed);
            added.push(fileRecord(rightEntry, path));
          } else {
            removed.push(fileRecord(leftEntry, path));
            const child = asString(rightEntry["child_manifest_hash"]);
            if (child) collect(child, path, added);
          }
        }
      }
      for (const [name, leftEntry] of leftByName) {
        if (rightByName.has(name)) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (leftEntry["entry_kind"] === "dir") {
          const child = asString(leftEntry["child_manifest_hash"]);
          if (child) collect(child, path, removed);
        } else {
          removed.push(fileRecord(leftEntry, path));
        }
      }
    };
    walk(
      this.manifestRootForState(input.leftStateHash),
      this.manifestRootForState(input.rightStateHash),
      ""
    );
    return { added, removed, changed };
  }

  /** Full recursive file listing of a worktree state (vcs materialize). */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listStateFiles(input: { stateHash: string }): JsonRecord[] {
    this.ensureReady();
    return this.filesForState(input.stateHash);
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getGadStateProducer(input: { stateHash: string }): JsonRecord | null {
    this.ensureReady();
    return (
      (this.sql
        .exec(
          `SELECT * FROM gad_state_transitions WHERE output_state_hash = ? ORDER BY created_at DESC LIMIT 1`,
          input.stateHash
        )
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  /** The op union (provenance/intent) that authored a worktree state. */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listWorktreeEditOps(input: { outputStateHash: string }): JsonRecord[] {
    this.ensureReady();
    return this.sql
      .exec(
        `SELECT ordinal, kind, path, old_content_hash, new_content_hash, hunks_json, mode
         FROM gad_worktree_edit_ops WHERE output_state_hash = ? ORDER BY ordinal ASC`,
        input.outputStateHash
      )
      .toArray() as JsonRecord[];
  }

  /** Validate a manifest tree recursively; report missing nodes and hash
   *  mismatches into `errors`. Returns the recomputed hash or null. */
  private recomputeManifestHashDeep(
    manifestHash: string,
    errors: JsonRecord[],
    seen: Map<string, string | null>
  ): string | null {
    const cached = seen.get(manifestHash);
    if (cached !== undefined) return cached;
    seen.set(manifestHash, null); // cycle guard
    const node = this.sql
      .exec(`SELECT kind FROM gad_manifest_nodes WHERE manifest_hash = ?`, manifestHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!node) {
      errors.push({
        type: "manifest",
        message: `missing manifest node ${manifestHash}`,
        manifestHash,
      });
      return null;
    }
    const entries: Array<
      | { name: string; kind: "file"; contentHash: string; mode: number }
      | { name: string; kind: "dir"; childHash: string }
    > = [];
    let broken = false;
    for (const entry of this.manifestEntries(manifestHash)) {
      const name = String(entry["name"]);
      if (entry["entry_kind"] === "dir") {
        const childHash = asString(entry["child_manifest_hash"]);
        if (!childHash) {
          broken = true;
          continue;
        }
        const recomputedChild = this.recomputeManifestHashDeep(childHash, errors, seen);
        if (recomputedChild === null) {
          broken = true;
          continue;
        }
        entries.push({ name, kind: "dir", childHash: recomputedChild });
      } else {
        entries.push({
          name,
          kind: "file",
          contentHash: String(entry["content_hash"]),
          mode: asNumber(entry["mode"]),
        });
      }
    }
    if (broken) return null;
    const recomputed = this.manifestHashForEntries(entries);
    if (recomputed !== manifestHash) {
      errors.push({
        type: "manifest",
        message: `manifest hash mismatch for ${manifestHash}`,
        manifestHash,
        recomputed,
      });
    }
    seen.set(manifestHash, recomputed);
    return recomputed;
  }

  // -------------------------------------------------------------------------
  // Worktree ingest (out-of-band edits become first-class observed transitions)
  // -------------------------------------------------------------------------

  @rpc({ callers: ["do", "server"] })
  async ingestWorktreeState(input: IngestWorktreeStateInput): Promise<{
    stateHash: string;
    eventId: string;
    headHash: string;
  }> {
    this.ensureReady();
    return this.transaction(() => {
      const refName = input.ref ?? this.worktreeRefName(input.logId, input.head);
      const current = this.resolveRef({ refName });
      const currentStateHash = current
        ? (asString((current.target as Record<string, unknown>)["stateHash"]) ?? EMPTY_STATE_HASH)
        : EMPTY_STATE_HASH;
      if (
        input.expectedRefStateHash !== undefined &&
        input.expectedRefStateHash !== null &&
        input.expectedRefStateHash !== currentStateHash
      ) {
        throw new Error(`ref CAS conflict: ${refName}`);
      }
      const baseStateHash = input.baseStateHash ?? currentStateHash;
      const files = input.files.map((file) => {
        const path = normalizePath(file.path);
        const mode = file.mode ?? 33188;
        this.ensureBlob(file.contentHash, file.size ?? 0);
        return {
          path,
          contentHash: file.contentHash,
          mode,
          fileVersionId: this.ensureFileVersion(path, file.contentHash, mode),
        };
      });
      const stateHash = this.createWorktreeState(files, {
        ingest: true,
        ...(input.summary ? { summary: input.summary } : {}),
      });
      const existingLog = this.logHeadRow(input.logId, input.head);
      const logKind = existingLog
        ? String(existingLog["log_kind"])
        : String(input.logKind ?? "trajectory");
      const eventId = input.eventId ?? crypto.randomUUID();
      const result = this.appendLogEventInTxn({
        logId: input.logId,
        head: input.head,
        logKind,
        events: [
          {
            envelopeId: eventId,
            actor: input.actor,
            payloadKind: input.eventKind ?? "state.snapshot_ingested",
            payload: {
              protocol: "agentic.trajectory.v1",
              inputStateHash: baseStateHash,
              outputStateHash: stateHash,
              ...(input.parentStateHashes && input.parentStateHashes.length > 0
                ? { parentStateHashes: input.parentStateHashes }
                : {}),
              ...(input.summary ? { summary: input.summary } : {}),
              ...(input.metadata ? { metadata: input.metadata } : {}),
            },
          },
        ],
      });
      if (input.editOps && input.editOps.length > 0) {
        input.editOps.forEach((op, ordinal) => {
          this.sql.exec(
            `INSERT INTO gad_worktree_edit_ops (
               event_id, output_state_hash, ordinal, kind, path,
               old_content_hash, new_content_hash, hunks_json, mode
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            eventId,
            stateHash,
            ordinal,
            op.kind,
            normalizePath(op.path),
            op.oldContentHash ?? null,
            op.newContentHash ?? null,
            op.hunks !== undefined ? JSON.stringify(op.hunks) : null,
            typeof op.mode === "number" ? op.mode : null
          );
        });
      }
      if (refName !== this.worktreeRefName(input.logId, input.head)) {
        this.updateRefInternal({
          refName,
          kind: "worktree-branch",
          target: { stateHash },
        });
      }
      return { stateHash, eventId, headHash: result.headHash };
    });
  }

  // -------------------------------------------------------------------------
  // Merge support (WS3.P4) — value staging, merge-base, pending-merge ref
  // -------------------------------------------------------------------------

  /**
   * Create a worktree state VALUE from a file list. Provisional merge states
   * stay as unreferenced values; authored drafts that pass base/transition
   * metadata also append a normal log-backed transition edge.
   */
  @rpc({ callers: ["do", "server"] })
  stageWorktreeState(input: {
    files: Array<{ path: string; contentHash: string; size?: number | null; mode?: number | null }>;
    summary?: string | null;
    /** When set, record a `base -> staged` ancestry edge so a draft authored
     *  off a known base is a first-class DAG node (merge-base/blame), not a
     *  dangling value. */
    baseStateHash?: string | null;
    transition?: {
      logId: string;
      head: string;
      logKind?: LogKind | string | null;
      actor: ParticipantRef;
      eventId?: string | null;
      metadata?: Record<string, unknown> | null;
    } | null;
  }): { stateHash: string; eventId: string | null; headHash: string | null } {
    this.ensureReady();
    return this.transaction(() => {
      const files = input.files.map((file) => {
        const path = normalizePath(file.path);
        const mode = file.mode ?? 33188;
        this.ensureBlob(file.contentHash, file.size ?? 0);
        return {
          path,
          contentHash: file.contentHash,
          mode,
          fileVersionId: this.ensureFileVersion(path, file.contentHash, mode),
        };
      });
      const stateHash = this.createWorktreeState(files, {
        staged: true,
        ...(input.summary ? { summary: input.summary } : {}),
      });
      let eventId: string | null = null;
      let headHash: string | null = null;
      if (input.baseStateHash && input.baseStateHash !== stateHash) {
        if (!input.transition) {
          throw new Error("stageWorktreeState with baseStateHash requires transition metadata");
        }
        const existingLog = this.logHeadRow(input.transition.logId, input.transition.head);
        const logKind = existingLog
          ? String(existingLog["log_kind"])
          : String(input.transition.logKind ?? "vcs");
        eventId = input.transition.eventId ?? crypto.randomUUID();
        const result = this.appendLogEventInTxn({
          logId: input.transition.logId,
          head: input.transition.head,
          logKind,
          events: [
            {
              envelopeId: eventId,
              actor: input.transition.actor,
              payloadKind: "state.transition_recorded",
              payload: {
                protocol: "agentic.trajectory.v1",
                inputStateHash: input.baseStateHash,
                outputStateHash: stateHash,
                ...(input.summary ? { summary: input.summary } : {}),
                ...(input.transition.metadata ? { metadata: input.transition.metadata } : {}),
              },
            },
          ],
        });
        headHash = result.headHash;
      }
      return { stateHash, eventId, headHash };
    });
  }

  /**
   * Lowest common ancestor of two worktree states over the transition DAG
   * (edges: output → input + extra parents). Multiple candidate bases pick
   * the one closest to `left` (newest-first BFS); null when histories are
   * unrelated (callers fall back to the empty state).
   */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getMergeBase(input: { leftStateHash: string; rightStateHash: string }): {
    baseStateHash: string | null;
  } {
    this.ensureReady();
    const ancestors = (start: string): Map<string, number> => {
      const seen = new Map<string, number>([[start, 0]]);
      const queue: string[] = [start];
      while (queue.length > 0) {
        const current = queue.shift()!;
        const depth = seen.get(current)!;
        const rows = this.sql
          .exec(
            `SELECT t.input_state_hash AS parent FROM gad_state_transitions t
              WHERE t.output_state_hash = ?
             UNION
             SELECT p.parent_state_hash AS parent FROM gad_transition_parents p
              JOIN gad_state_transitions t2 ON t2.event_id = p.event_id
              WHERE t2.output_state_hash = ?`,
            current,
            current
          )
          .toArray() as JsonRecord[];
        for (const row of rows) {
          const parent = asString(row["parent"]);
          if (!parent || seen.has(parent)) continue;
          seen.set(parent, depth + 1);
          queue.push(parent);
        }
      }
      return seen;
    };
    const leftAncestors = ancestors(input.leftStateHash);
    const rightAncestors = ancestors(input.rightStateHash);
    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [state, depth] of leftAncestors) {
      if (!rightAncestors.has(state)) continue;
      if (depth < bestDepth) {
        best = state;
        bestDepth = depth;
      }
    }
    return { baseStateHash: best };
  }

  /**
   * Pending-merge lifecycle ref for a head: set when a conflicted merge has
   * been materialized into the head's working tree; consumed by the
   * resolution commit (which records the merge parents). One pending merge
   * per head.
   */
  @rpc({ callers: ["do", "server"] })
  setPendingMerge(input: {
    logId: string;
    head: string;
    info: {
      oursStateHash: string;
      theirsStateHash: string;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      /**
       * False until the provisional (conflict-marked) state has been
       * materialized into the head's working tree. Readers that see
       * `materialized: false` (crash between set and materialize) must
       * re-materialize before treating the worktree as the resolution.
       */
      materialized?: boolean;
    };
  }): void {
    this.ensureReady();
    this.setStateValue(`merge:${input.logId}:${input.head}`, JSON.stringify(input.info));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getPendingMerge(input: { logId: string; head: string }): {
    info: {
      oursStateHash: string;
      theirsStateHash: string;
      baseStateHash: string | null;
      theirsHead: string;
      conflicts: Array<{ path: string; kind: string }>;
      provisionalStateHash: string;
      materialized?: boolean;
    } | null;
  } {
    this.ensureReady();
    const raw = this.getStateValue(`merge:${input.logId}:${input.head}`);
    if (!raw) return { info: null };
    try {
      return { info: JSON.parse(raw) };
    } catch {
      return { info: null };
    }
  }

  @rpc({ callers: ["do", "server"] })
  clearPendingMerge(input: { logId: string; head: string }): void {
    this.ensureReady();
    this.deleteStateValue(`merge:${input.logId}:${input.head}`);
  }

  // -------------------------------------------------------------------------
  // Memory (WS4) — FTS index over messages/claims/files + provenance recall
  // -------------------------------------------------------------------------

  /** "fts" under workerd SQLite; "plain" (LIKE search) where FTS5 is absent
   *  (the sql.js test harness). Same write/read logic either way. */
  private memoryIndexMode: "fts" | "plain" | null = null;

  private ensureMemoryIndex(): "fts" | "plain" {
    if (this.memoryIndexMode) return this.memoryIndexMode;
    try {
      this.sql.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS gad_memory_fts USING fts5(
           text, kind UNINDEXED, log_id UNINDEXED, head UNINDEXED,
           event_id UNINDEXED, path UNINDEXED, content_hash UNINDEXED,
           anchor_json UNINDEXED
         )`
      );
      this.memoryIndexMode = "fts";
    } catch {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS gad_memory_fts (
           text TEXT NOT NULL, kind TEXT NOT NULL, log_id TEXT, head TEXT,
           event_id TEXT, path TEXT, content_hash TEXT, anchor_json TEXT
         )`
      );
      this.memoryIndexMode = "plain";
    }
    return this.memoryIndexMode;
  }

  private indexMemoryRow(row: {
    text: string;
    kind: "message" | "claim" | "file";
    logId?: string | null;
    head?: string | null;
    eventId?: string | null;
    path?: string | null;
    contentHash?: string | null;
    anchor?: Record<string, unknown> | null;
  }): void {
    this.ensureMemoryIndex();
    const text = row.text.slice(0, 64_000);
    if (!text.trim()) return;
    // One row per identity: events index once (idempotent replay), files keep
    // only their latest content.
    if (row.eventId) {
      this.sql.exec(
        `DELETE FROM gad_memory_fts
          WHERE event_id = ?
            AND COALESCE(log_id, '') = COALESCE(?, '')
            AND COALESCE(head, '') = COALESCE(?, '')`,
        row.eventId,
        row.logId ?? null,
        row.head ?? null
      );
    } else if (row.path) {
      this.sql.exec(`DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`, row.path);
    }
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      text,
      row.kind,
      row.logId ?? null,
      row.head ?? null,
      row.eventId ?? null,
      row.path ?? null,
      row.contentHash ?? null,
      row.anchor ? JSON.stringify(row.anchor) : null
    );
  }

  /** Batch file-text indexing (the server pushes changed file text — bytes
   *  live in the filesystem CAS, not in this DO). */
  @rpc({ callers: ["do", "server"] })
  indexMemoryFiles(input: {
    files: Array<{ path: string; contentHash: string; text: string }>;
    removedPaths?: string[] | null;
  }): { indexed: number } {
    this.ensureReady();
    this.ensureMemoryIndex();
    for (const removed of input.removedPaths ?? []) {
      this.sql.exec(`DELETE FROM gad_memory_fts WHERE path = ? AND kind = 'file'`, removed);
    }
    for (const file of input.files) {
      this.indexMemoryRow({
        text: file.text,
        kind: "file",
        path: file.path,
        contentHash: file.contentHash,
      });
    }
    return { indexed: input.files.length };
  }

  /** Index marker (P1 cache pointer): which state the file index reflects. */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getMemoryIndexMarker(input: { key: string }): { value: string | null } {
    this.ensureReady();
    return { value: this.getStateValue(`memidx:${input.key}`) };
  }

  @rpc({ callers: ["do", "server"] })
  setMemoryIndexMarker(input: { key: string; value: string }): void {
    this.ensureReady();
    this.setStateValue(`memidx:${input.key}`, input.value);
  }

  /** Generic named marker (vcs bridge export positions etc.). */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getMarker(input: { key: string }): { value: string | null } {
    this.ensureReady();
    return { value: this.getStateValue(`marker:${input.key}`) };
  }

  @rpc({ callers: ["do", "server"] })
  setMarker(input: { key: string; value: string }): void {
    this.ensureReady();
    this.setStateValue(`marker:${input.key}`, input.value);
  }

  /**
   * Search the memory index. Results carry provenance: the matching row's
   * anchor plus (for event-anchored rows) the event's actor and timestamp,
   * and (for file rows) the current content hash.
   */
  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  recallMemory(input: { query: string; kinds?: string[] | null; limit?: number | null }): {
    results: Array<{
      kind: string;
      snippet: string;
      score: number | null;
      logId: string | null;
      head: string | null;
      eventId: string | null;
      path: string | null;
      contentHash: string | null;
      anchor: Record<string, unknown> | null;
      actor: unknown;
      appendedAt: string | null;
    }>;
  } {
    this.ensureReady();
    const mode = this.ensureMemoryIndex();
    const limit = Math.min(input.limit ?? 10, 50);
    const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : null;
    let rows: JsonRecord[];
    if (mode === "fts") {
      const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      rows = this.sql
        .exec(
          `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  bm25(gad_memory_fts) AS score
             FROM gad_memory_fts
            WHERE gad_memory_fts MATCH ?${kindFilter}
            ORDER BY score LIMIT ?`,
          sanitizeFtsQuery(input.query),
          ...(kinds ?? []),
          limit
        )
        .toArray() as JsonRecord[];
    } else {
      const terms = input.query
        .split(/\s+/u)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 8);
      if (terms.length === 0) return { results: [] };
      const likeClauses = terms.map(() => `text LIKE ? ESCAPE '\\'`).join(" AND ");
      const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      rows = this.sql
        .exec(
          `SELECT text, kind, log_id, head, event_id, path, content_hash, anchor_json,
                  NULL AS score
             FROM gad_memory_fts
            WHERE ${likeClauses}${kindFilter}
            LIMIT ?`,
          ...terms.map((term) => `%${term.replace(/[%_\\]/gu, "\\$&")}%`),
          ...(kinds ?? []),
          limit
        )
        .toArray() as JsonRecord[];
    }

    const results = rows.map((row) => {
      const eventId = asString(row["event_id"]);
      const logId = asString(row["log_id"]);
      const head = asString(row["head"]);
      let actor: unknown = null;
      let appendedAt: string | null = null;
      if (eventId && logId && head) {
        const event = this.getLogEvent({ logId, head, envelopeId: eventId });
        if (event) {
          actor = event.actor;
          appendedAt = event.appendedAt;
        }
      }
      const text = String(row["text"]);
      return {
        kind: String(row["kind"]),
        snippet: snippetAround(text, input.query),
        score: row["score"] == null ? null : asNumber(row["score"]),
        logId,
        head,
        eventId,
        path: asString(row["path"]),
        contentHash: asString(row["content_hash"]),
        anchor: parseJson(asString(row["anchor_json"])) as Record<string, unknown> | null,
        actor,
        appendedAt,
      };
    });
    return { results };
  }

  // -------------------------------------------------------------------------
  // GC (WS3.P5) — mark-and-sweep over values; two-phase blob deletion
  // -------------------------------------------------------------------------

  /**
   * Mark phase: compute the live value set (ancestor closure of every
   * ref/pending-merge root over the transition DAG, those states' manifest
   * trees, the file versions kept manifests or blame rows reference) and:
   *  - delete orphaned worktree states / manifest nodes / file versions
   *    (DO-local rows, transactional — safe immediately),
   *  - record unreferenced blob digests as sweep candidates.
   * The log itself is never collected (it IS the authority).
   */
  @rpc({ callers: ["server", "harness"] })
  runGadGcMark(): {
    keptStates: number;
    sweptStates: number;
    sweptManifests: number;
    sweptFileVersions: number;
    blobCandidates: number;
  } {
    this.ensureReady();
    return this.transaction(() => {
      // 1. Root states: every ref target with a stateHash + pending merges.
      const roots = new Set<string>([EMPTY_STATE_HASH]);
      for (const ref of this.listRefs({})) {
        const stateHash = asString((ref.target as Record<string, unknown>)["stateHash"]);
        if (stateHash) roots.add(stateHash);
      }
      const mergeRows = this.sql
        .exec(`SELECT value FROM state WHERE key LIKE 'merge:%'`)
        .toArray() as JsonRecord[];
      for (const row of mergeRows) {
        try {
          const info = JSON.parse(String(row["value"])) as Record<string, unknown>;
          for (const key of [
            "oursStateHash",
            "theirsStateHash",
            "baseStateHash",
            "provisionalStateHash",
          ]) {
            const value = asString(info[key]);
            if (value) roots.add(value);
          }
        } catch {
          // unparseable pending merge — ignore
        }
      }
      // Freshly created worktree states are temporary roots so a GC run cannot
      // race a multi-step flow that has created a state but not yet referenced
      // it. Once the grace window expires, unreferenced staged states are
      // garbage; pending merges root their provisional states explicitly.
      const graceCutoff = new Date(Date.now() - GC_CREATION_GRACE_MS).toISOString();
      const protectedRows = this.sql
        .exec(
          `SELECT state_hash, created_at FROM gad_worktree_states
            WHERE created_at > ?`,
          graceCutoff
        )
        .toArray() as JsonRecord[];
      for (const row of protectedRows) {
        roots.add(String(row["state_hash"]));
      }

      // 2. Ancestor closure over the transition DAG (history retention).
      const keptStates = new Set<string>(roots);
      const queue = [...roots];
      while (queue.length > 0) {
        const current = queue.pop()!;
        const parents = this.sql
          .exec(
            `SELECT t.input_state_hash AS parent FROM gad_state_transitions t
              WHERE t.output_state_hash = ?
             UNION
             SELECT p.parent_state_hash AS parent FROM gad_transition_parents p
              JOIN gad_state_transitions t2 ON t2.event_id = p.event_id
              WHERE t2.output_state_hash = ?`,
            current,
            current
          )
          .toArray() as JsonRecord[];
        for (const row of parents) {
          const parent = asString(row["parent"]);
          if (parent && !keptStates.has(parent)) {
            keptStates.add(parent);
            queue.push(parent);
          }
        }
      }

      // 3. Manifest closure of kept states.
      const keptManifests = new Set<string>();
      const walkManifest = (manifestHash: string): void => {
        if (keptManifests.has(manifestHash)) return;
        keptManifests.add(manifestHash);
        for (const entry of this.manifestEntries(manifestHash)) {
          if (entry["entry_kind"] === "dir") {
            const child = asString(entry["child_manifest_hash"]);
            if (child) walkManifest(child);
          }
        }
      };
      for (const stateHash of keptStates) {
        const row = this.sql
          .exec(
            `SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`,
            stateHash
          )
          .toArray()[0] as JsonRecord | undefined;
        const rootHash = asString(row?.["manifest_root_hash"]);
        if (rootHash) walkManifest(rootHash);
      }

      // 4. Kept file versions: referenced by kept manifests.
      const keptFileVersions = new Set<number>();
      for (const manifestHash of keptManifests) {
        for (const entry of this.manifestEntries(manifestHash)) {
          const id = entry["file_version_id"];
          if (typeof id === "number") keptFileVersions.add(id);
        }
      }

      // 5. Sweep orphaned rows.
      let sweptStates = 0;
      for (const row of this.sql
        .exec(`SELECT state_hash FROM gad_worktree_states`)
        .toArray() as JsonRecord[]) {
        const stateHash = String(row["state_hash"]);
        if (keptStates.has(stateHash)) continue;
        this.sql.exec(`DELETE FROM gad_worktree_states WHERE state_hash = ?`, stateHash);
        sweptStates += 1;
      }
      let sweptManifests = 0;
      for (const row of this.sql
        .exec(`SELECT manifest_hash FROM gad_manifest_nodes`)
        .toArray() as JsonRecord[]) {
        const manifestHash = String(row["manifest_hash"]);
        if (keptManifests.has(manifestHash)) continue;
        this.sql.exec(`DELETE FROM gad_manifest_entries WHERE manifest_hash = ?`, manifestHash);
        this.sql.exec(`DELETE FROM gad_manifest_nodes WHERE manifest_hash = ?`, manifestHash);
        sweptManifests += 1;
      }
      let sweptFileVersions = 0;
      for (const row of this.sql
        .exec(`SELECT id FROM gad_file_versions`)
        .toArray() as JsonRecord[]) {
        const id = asNumber(row["id"]);
        if (keptFileVersions.has(id)) continue;
        this.sql.exec(`DELETE FROM gad_file_versions WHERE id = ?`, id);
        sweptFileVersions += 1;
      }

      // 6. Blob candidates: not referenced by surviving file versions nor log
      // payload spills (the same blob reachability collectGarbageBlobRefs
      // uses); drop candidates that regained a reference.
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_gc_candidates (digest, marked_at)
         SELECT b.hash, ? FROM gad_blobs b
          WHERE NOT EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = b.hash)
            AND NOT EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = b.hash)`,
        nowIso()
      );
      this.sql.exec(
        `DELETE FROM gad_gc_candidates
          WHERE EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = gad_gc_candidates.digest)
             OR EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = gad_gc_candidates.digest)`
      );
      const candidates = asNumber(
        (this.sql.exec(`SELECT COUNT(*) AS c FROM gad_gc_candidates`).one() as JsonRecord)["c"]
      );
      return {
        keptStates: keptStates.size,
        sweptStates,
        sweptManifests,
        sweptFileVersions,
        blobCandidates: candidates,
      };
    });
  }

  /**
   * Sweep phase: candidates older than `minAgeMs` that are STILL
   * unreferenced lose their metadata row; the returned digests are for the
   * caller to delete from the filesystem CAS (second phase of the two-phase
   * deletion).
   */
  @rpc({ callers: ["server", "harness"] })
  runGadGcSweep(input: { minAgeMs?: number | null } = {}): { digests: string[] } {
    this.ensureReady();
    const minAge = input.minAgeMs ?? 60_000;
    const cutoff = new Date(Date.now() - minAge).toISOString();
    // Creation-time grace: a blob created within the grace window may belong
    // to an in-flight multi-step flow that has not referenced it yet.
    const graceCutoff = new Date(Date.now() - GC_CREATION_GRACE_MS).toISOString();
    return this.transaction(() => {
      const rows = this.sql
        .exec(
          `SELECT digest FROM gad_gc_candidates
            WHERE marked_at <= ?
              AND NOT EXISTS (SELECT 1 FROM gad_file_versions fv WHERE fv.content_hash = gad_gc_candidates.digest)
              AND NOT EXISTS (SELECT 1 FROM log_blob_refs lbr WHERE lbr.digest = gad_gc_candidates.digest)
              AND NOT EXISTS (
                SELECT 1 FROM gad_blobs b
                 WHERE b.hash = gad_gc_candidates.digest AND b.created_at > ?)`,
          cutoff,
          graceCutoff
        )
        .toArray() as JsonRecord[];
      const digests = rows.map((row) => String(row["digest"]));
      for (const digest of digests) {
        this.sql.exec(`DELETE FROM gad_blobs WHERE hash = ?`, digest);
        this.sql.exec(`DELETE FROM gad_gc_candidates WHERE digest = ?`, digest);
      }
      return { digests };
    });
  }

  // -------------------------------------------------------------------------
  // Projection replay (cache amnesia recovery — P3)
  // -------------------------------------------------------------------------

  async replayTrajectoryProjections(): Promise<{ replayed: number }> {
    this.ensureReady();
    return this.transaction(() => {
      this.clearProjections();
      let replayed = 0;
      const prefixCache = new Map<string, ProjectionKey | null>();
      const temporaryKeys: ProjectionKey[] = [];
      const heads = this.sql
        .exec(`SELECT * FROM log_heads ORDER BY created_at ASC, log_id ASC, head ASC`)
        .toArray() as JsonRecord[];

      const materializePrefix = (
        logId: string,
        head: string,
        throughSeq: number
      ): ProjectionKey | null => {
        if (throughSeq <= 0) return null;
        const cacheKey = `${logId}\u0000${head}\u0000${throughSeq}`;
        if (prefixCache.has(cacheKey)) return prefixCache.get(cacheKey) ?? null;
        const headRow = this.logHeadRow(logId, head);
        if (!headRow) throw new Error(`projection replay source missing: ${logId}:${head}`);
        const logKind = String(headRow["log_kind"]);
        const key: ProjectionKey = {
          logId,
          head: `__projection_prefix:${sha256HexSyncText(cacheKey).slice(0, 32)}`,
        };
        temporaryKeys.push(key);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          // Cap the parent at min(forkSeq, throughSeq): when the requested
          // prefix ends BELOW this node's own fork point (a descendant forked
          // inside the inherited region), seeding the full parent-through-fork
          // prefix would over-project the parent events in (throughSeq, forkSeq].
          const parentPrefix = materializePrefix(
            parentLogId,
            parentHead,
            Math.min(forkSeq, throughSeq)
          );
          if (parentPrefix) this.copyProjectionKey(parentPrefix, key);
        }
        // Own events live above forkSeq; when throughSeq < forkSeq this range
        // is empty (the requested prefix is entirely within the inherited part).
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({ logId, head, afterSeq, throughSeq })) {
          this.applyProjections(logKind, { ...envelope, logId: key.logId, head: key.head });
          replayed += 1;
        }
        prefixCache.set(cacheKey, key);
        return key;
      };

      for (const headRow of heads) {
        const logId = String(headRow["log_id"]);
        const head = String(headRow["head"]);
        const logKind = String(headRow["log_kind"]);
        const parentLogId = asString(headRow["parent_log_id"]);
        const parentHead = asString(headRow["parent_head"]);
        const forkSeq = headRow["fork_seq"] == null ? 0 : asNumber(headRow["fork_seq"]);
        if (parentLogId && parentHead && forkSeq > 0) {
          const parentPrefix = materializePrefix(parentLogId, parentHead, forkSeq);
          if (parentPrefix) this.copyProjectionKey(parentPrefix, { logId, head });
        }
        const pointer = this.headPointer(logId, head, headRow);
        const afterSeq = parentLogId && parentHead ? forkSeq : 0;
        for (const envelope of this.readOwnLogRange({
          logId,
          head,
          afterSeq,
          throughSeq: pointer.seq,
        })) {
          this.applyProjections(logKind, envelope);
          replayed += 1;
        }
      }
      for (const key of temporaryKeys) this.deleteProjectionKey(key);
      return { replayed };
    });
  }

  private readOwnLogRange(input: {
    logId: string;
    head: string;
    afterSeq: number;
    throughSeq: number;
  }): LogEnvelope[] {
    const clauses = ["log_id = ?", "head = ?", "seq > ?"];
    const bindings: SqlBinding[] = [input.logId, input.head, input.afterSeq];
    if (Number.isFinite(input.throughSeq)) {
      clauses.push("seq <= ?");
      bindings.push(input.throughSeq);
    }
    const rows = this.sql
      .exec(`SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC`, ...bindings)
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapLogEnvelope(row));
  }

  private copyProjectionKey(from: ProjectionKey, to: ProjectionKey): void {
    this.copyProjectionRows("trajectory_turns", "turn_id, opened_at, closed_at, summary", from, to);
    this.copyProjectionRows(
      "trajectory_messages",
      "message_id, turn_id, role, status, started_event_id, completed_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_message_blocks",
      "block_id, message_id, block_index, block_type, invocation_id",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_invocations",
      "invocation_id, turn_id, transport_call_id, kind, status, terminal_outcome, terminal_reason_code, request_ref_json, result_ref_json, started_event_id, completed_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_invocation_outputs",
      "invocation_id, seq, chunk_ref_json, created_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_approvals",
      "approval_id, invocation_id, status, requested_by_json, resolved_by_json, requested_event_id, resolved_event_id, updated_at",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_usage_rollups",
      "turn_id, input_tokens, output_tokens, total_tokens, cost_usd",
      from,
      to
    );
    this.copyProjectionRows(
      "trajectory_checkpoints",
      "anchor_event_hash, materialized_blob_json, materializer_version, created_at",
      from,
      to
    );
    this.sql.exec(
      `INSERT INTO gad_memory_fts (text, kind, log_id, head, event_id, path, content_hash, anchor_json)
       SELECT text, kind, ?, ?, event_id, path, content_hash, anchor_json
         FROM gad_memory_fts
        WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head
    );
    const worktreeRef = this.resolveRef({ refName: this.worktreeRefName(from.logId, from.head) });
    if (worktreeRef?.target) {
      this.updateRefInternal({
        refName: this.worktreeRefName(to.logId, to.head),
        kind: "worktree-branch",
        target: worktreeRef.target,
      });
    }
  }

  private copyProjectionRows(
    table: string,
    columns: string,
    from: ProjectionKey,
    to: ProjectionKey
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO ${table} (log_id, head, ${columns})
       SELECT ?, ?, ${columns} FROM ${table} WHERE log_id = ? AND head = ?`,
      to.logId,
      to.head,
      from.logId,
      from.head
    );
  }

  private deleteProjectionKey(key: ProjectionKey): void {
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "trajectory_checkpoints",
    ]) {
      this.sql.exec(`DELETE FROM ${table} WHERE log_id = ? AND head = ?`, key.logId, key.head);
    }
    this.sql.exec(`DELETE FROM gad_memory_fts WHERE log_id = ? AND head = ?`, key.logId, key.head);
    this.sql.exec(`DELETE FROM refs WHERE ref_name = ?`, this.worktreeRefName(key.logId, key.head));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  rebuildTrajectoryProjections(): Promise<{ replayed: number }> {
    return this.replayTrajectoryProjections();
  }

  private clearProjections(): void {
    // Memory rows are projections too (P3): event/claim rows refold from the
    // log; file rows re-index from the worktree on the next state advance.
    this.ensureMemoryIndex();
    this.sql.exec(`DELETE FROM gad_memory_fts`);
    this.sql.exec(`DELETE FROM state WHERE key LIKE 'memidx:%'`);
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "channel_roster",
      "gad_state_transitions",
      "gad_transition_parents",
      "gad_claims",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    // Worktree-branch refs are derived by the state projector: reset them so
    // replay re-derives each head's chain from the empty state. Values
    // (worktree states / manifests / file versions / blobs) are content-
    // addressed and never cleared.
    this.sql.exec(`DELETE FROM refs WHERE kind = 'worktree-branch'`);
    this.ensureEmptyState();
  }

  // -------------------------------------------------------------------------
  // Legacy adapter surface — thin over the unified core (deleted in Stage B)
  // -------------------------------------------------------------------------

  private trajectoryEventView(
    envelope: LogEnvelope,
    override?: { trajectoryId: string; branchId: string }
  ): TrajectoryEvent {
    const causality = agenticCausality(envelope.causality);
    const turnId = envelope.causality?.turnId;
    return {
      eventId: String(envelope.envelopeId),
      trajectoryId: override?.trajectoryId ?? envelope.logId,
      branchId: override?.branchId ?? envelope.head,
      seq: envelope.seq,
      prevEventHash: envelope.prevHash,
      eventHash: envelope.hash,
      kind: envelope.payloadKind,
      actor: envelope.actor,
      ...(turnId ? { turnId } : {}),
      ...(causality ? { causality } : {}),
      payload: envelope.payload,
      createdAt: envelope.appendedAt,
    } as unknown as TrajectoryEvent;
  }

  private channelEnvelopeView(envelope: LogEnvelope, channelId?: string): ChannelEnvelope {
    const annotations = envelope.annotations ?? {};
    const {
      metadata: _viewMetadata,
      attachments: _viewAttachments,
      ...policyAnnotations
    } = annotations;
    return {
      envelopeId: envelope.envelopeId,
      channelId: brandId<ChannelId>(channelId ?? envelope.logId),
      seq: envelope.seq,
      from: envelope.actor,
      ...(envelope.to !== undefined ? { to: envelope.to } : {}),
      payload: envelope.payload,
      ...(envelope.payloadKind !== "opaque" ? { payloadKind: envelope.payloadKind } : {}),
      ...(annotations["metadata"] !== undefined
        ? { metadata: annotations["metadata"] as Record<string, unknown> }
        : {}),
      ...(annotations["attachments"] !== undefined
        ? { attachments: annotations["attachments"] as unknown[] }
        : {}),
      ...(Object.keys(policyAnnotations).length > 0 ? { annotations: policyAnnotations } : {}),
      publishedAt: envelope.appendedAt,
    };
  }

  @rpc({ callers: ["do", "server"] })
  async appendTrajectoryBatch(
    input: AppendTrajectoryBatchInput
  ): Promise<AppendTrajectoryBatchResult> {
    this.ensureReady();
    if (!input.trajectoryId) throw new Error("appendTrajectoryBatch requires trajectoryId");
    if (!input.branchId) throw new Error("appendTrajectoryBatch requires branchId");
    if (input.events.length === 0)
      throw new Error("appendTrajectoryBatch requires at least one event");

    const events: LogAppendEventInput[] = input.events.map((item) => {
      const event = item.event as AgenticEvent & {
        turnId?: string;
        causality?: Record<string, unknown>;
      };
      const causality: Record<string, unknown> = {
        ...(event.causality ?? {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
      return {
        envelopeId: item.eventId ?? null,
        actor: event.actor as ParticipantRef,
        payloadKind: event.kind,
        payload: event.payload,
        ...(Object.keys(causality).length > 0 ? { causality: causality as LogEventCausality } : {}),
        appendedAt: event.createdAt,
        ...(item.publish
          ? {
              publish: {
                channels: item.publish.channelIds.map((channelId) => ({
                  channelId,
                  audience: item.publish?.audience,
                })),
              },
            }
          : {}),
      };
    });

    const result = await this.appendLogEvent({
      logId: input.trajectoryId,
      head: input.branchId,
      logKind: "trajectory",
      owner: input.owner,
      ...("expectedHeadEventHash" in input
        ? { expectedHeadHash: input.expectedHeadEventHash ?? null }
        : {}),
      events,
    });

    return {
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
      headEventId: this.headPointer(input.trajectoryId, input.branchId).envelopeId ?? null,
      headEventHash: result.headHash,
      headStateHash: this.latestStateHash(input.trajectoryId, input.branchId),
      events: result.envelopes.map((envelope) =>
        this.trajectoryEventView(envelope, {
          trajectoryId: input.trajectoryId,
          branchId: input.branchId,
        })
      ),
      published: result.published.map((publication) => ({
        eventId: publication.originEnvelopeId,
        channelId: publication.channelId,
        envelopeId: publication.envelopeId,
      })),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listTrajectoryEvents(input: {
    trajectoryId?: string | null;
    branchId: string;
    cursor?: number | null;
    limit?: number | null;
  }): TrajectoryEvent[] {
    this.ensureReady();
    const logId = input.trajectoryId ?? this.findLogIdForHead(input.branchId);
    if (!logId) return [];
    const limit = input.limit ?? 500;
    const envelopes = this.readLog({
      logId,
      head: input.branchId,
      afterSeq: input.cursor ?? 0,
      limit: limit <= 0 ? 0 : limit,
    });
    return envelopes.map((envelope) =>
      this.trajectoryEventView(envelope, {
        trajectoryId: logId,
        branchId: input.branchId,
      })
    );
  }

  private findLogIdForHead(head: string): string | null {
    const row = this.sql
      .exec(`SELECT log_id FROM log_heads WHERE head = ? LIMIT 1`, head)
      .toArray()[0] as JsonRecord | undefined;
    return row ? String(row["log_id"]) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getTrajectoryEvent(input: { eventId: string }): TrajectoryEvent | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`, input.eventId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.trajectoryEventView(this.mapLogEnvelope(row)) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getTrajectoryBranchHead(input: { trajectoryId: string; branchId: string }): JsonRecord | null {
    this.ensureReady();
    const row = this.logHeadRow(input.trajectoryId, input.branchId);
    if (!row) return null;
    const pointer = this.headPointer(input.trajectoryId, input.branchId, row);
    return {
      trajectory_id: input.trajectoryId,
      branch_id: input.branchId,
      owner_json: (row["owner_json"] ?? null) as JsonValue,
      head_event_id: pointer.envelopeId,
      head_event_hash: pointer.seq > 0 ? pointer.hash : null,
      head_state_hash: this.latestStateHash(input.trajectoryId, input.branchId),
      parent_branch_id: (row["parent_head"] ?? null) as JsonValue,
      fork_event_id: null,
      created_at: row["created_at"] as JsonValue,
      updated_at: row["created_at"] as JsonValue,
    };
  }

  @rpc({ callers: ["do", "server"] })
  async forkTrajectoryBranch(
    input: ForkTrajectoryBranchInput
  ): Promise<ForkTrajectoryBranchResult> {
    this.ensureReady();
    let atSeq: number | null = input.throughSeq ?? null;
    if (input.throughEventHash) {
      const row = this.sql
        .exec(`SELECT seq FROM log_events WHERE hash = ? LIMIT 1`, input.throughEventHash)
        .toArray()[0] as JsonRecord | undefined;
      if (!row) throw new Error("forkTrajectoryBranch throughEventHash not found");
      atSeq = asNumber(row["seq"]);
    }
    if (input.throughPublishedChannelId && input.throughPublishedChannelSeq != null) {
      const row = this.sql
        .exec(
          `SELECT MAX(o.seq) AS seq
           FROM log_events ch
           JOIN log_events o
             ON o.log_id = ch.origin_log_id
            AND o.head = ch.origin_head
            AND o.envelope_id = ch.origin_envelope_id
           WHERE ch.log_id = ?
             AND ch.seq <= ?
             AND ch.origin_log_id = ?
             AND ch.origin_head = ?`,
          input.throughPublishedChannelId,
          input.throughPublishedChannelSeq,
          input.fromTrajectoryId,
          input.fromBranchId
        )
        .toArray()[0] as JsonRecord | undefined;
      atSeq = row?.["seq"] == null ? 0 : asNumber(row["seq"]);
    }

    const fork = this.forkLog({
      fromLogId: input.fromTrajectoryId,
      fromHead: input.fromBranchId,
      toLogId: input.toTrajectoryId,
      toHead: input.toBranchId,
      atSeq,
      owner: input.owner ?? null,
    });
    const pointer = this.headPointer(input.toTrajectoryId, input.toBranchId);
    return {
      fromTrajectoryId: input.fromTrajectoryId,
      fromBranchId: input.fromBranchId,
      toTrajectoryId: input.toTrajectoryId,
      toBranchId: input.toBranchId,
      copied: fork.inherited,
      headEventId: pointer.envelopeId,
      headEventHash: pointer.seq > 0 ? pointer.hash : null,
      headStateHash: this.latestStateHash(input.toTrajectoryId, input.toBranchId),
      lineage: [],
    };
  }

  @rpc({ callers: ["do", "server"] })
  forkChannelLog(input: ForkChannelLogInput): ForkChannelLogResult {
    this.ensureReady();
    if (!input.fromChannelId) throw new Error("forkChannelLog requires fromChannelId");
    if (!input.toChannelId) throw new Error("forkChannelLog requires toChannelId");
    if (input.fromChannelId === input.toChannelId)
      throw new Error("forkChannelLog requires distinct channels");
    const fork = this.forkLog({
      fromLogId: input.fromChannelId,
      fromHead: CHANNEL_LOG_HEAD,
      toLogId: input.toChannelId,
      toHead: CHANNEL_LOG_HEAD,
      atSeq: input.throughSeq ?? null,
    });
    return {
      fromChannelId: input.fromChannelId,
      toChannelId: input.toChannelId,
      throughSeq: input.throughSeq ?? null,
      copied: fork.inherited,
      lineage: [],
    };
  }

  // --- Channel adapters ------------------------------------------------------

  @rpc({ callers: ["do", "server"] })
  async appendChannelEnvelope(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): Promise<ChannelEnvelope> {
    this.ensureReady();
    const result = await this.appendLogEvent({
      logId: String(input.channelId),
      head: CHANNEL_LOG_HEAD,
      logKind: "channel",
      events: [this.channelEnvelopeEventInput(input)],
    });
    const envelope = result.envelopes[result.envelopes.length - 1]!;
    return this.channelEnvelopeView(envelope, String(input.channelId));
  }

  private channelEnvelopeEventInput(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): LogAppendEventInput {
    const annotations: Record<string, unknown> = {};
    if (input.metadata !== undefined) annotations["metadata"] = input.metadata;
    if (input.attachments !== undefined) annotations["attachments"] = input.attachments;
    return {
      envelopeId: input.envelopeId ?? null,
      actor: input.from,
      ...(input.to !== undefined ? { to: input.to } : {}),
      payloadKind: input.payloadKind ?? "opaque",
      payload: input.payload,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      ...(input.publishedAt ? { appendedAt: input.publishedAt } : {}),
    };
  }

  @rpc({ callers: ["do", "server"] })
  async appendChannelEnvelopeWithRegistryMutation(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
      registryMutation: RegistryMutationInput;
    }
  ): Promise<ChannelEnvelope> {
    this.ensureReady();
    const { registryMutation, ...envelopeInput } = input;
    return this.transaction(() => {
      const channelId = String(envelopeInput.channelId);
      const before = this.headPointer(channelId, CHANNEL_LOG_HEAD);
      const result = this.appendLogEventInTxn({
        logId: channelId,
        head: CHANNEL_LOG_HEAD,
        logKind: "channel",
        events: [this.channelEnvelopeEventInput(envelopeInput)],
      });
      const envelope = result.envelopes[result.envelopes.length - 1]!;
      // Registry mutations ride only fresh appends: a replayed envelope already
      // carried its mutation the first time.
      if (result.headSeq > before.seq) {
        this.applyRegistryMutation(
          channelId,
          envelope.seq,
          sanitizeRegistryMutation(registryMutation)
        );
      }
      return this.channelEnvelopeView(envelope, channelId);
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getChannelEnvelope(input: {
    envelopeId: string;
    channelId?: string | null;
  }): ChannelEnvelope | null {
    this.ensureReady();
    if (input.channelId) {
      const envelope = this.getLogEvent({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        envelopeId: input.envelopeId,
      });
      return envelope ? this.channelEnvelopeView(envelope, input.channelId) : null;
    }
    const row = this.sql
      .exec(`SELECT * FROM log_events WHERE envelope_id = ? LIMIT 1`, input.envelopeId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.channelEnvelopeView(this.mapLogEnvelope(row)) : null;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getChannelReplayWindow(input: {
    channelId: string;
    mode: "initial" | "after" | "before";
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    limit?: number | null;
  }): ChannelReplayWindow {
    this.ensureReady();
    const rawLimit = input.limit ?? 50;
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 0), 500)
      : 50;
    const stats = this.lineageEventStats({ logId: input.channelId, head: CHANNEL_LOG_HEAD });
    let rows: LogEnvelope[];
    if (input.mode === "after") {
      const sinceSeq = input.sinceSeq ?? 0;
      rows = this.readLog({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        afterSeq: sinceSeq,
        limit,
      });
    } else if (input.mode === "before") {
      if (input.beforeSeq == null) throw new Error("beforeSeq required for before replay");
      rows = this.readLogTail({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        beforeSeq: input.beforeSeq,
        limit,
      });
    } else {
      rows = this.readLogTail({
        logId: input.channelId,
        head: CHANNEL_LOG_HEAD,
        limit,
      });
    }
    const replayFromId = rows.length > 0 ? rows[0]!.seq : undefined;
    const replayToId = rows.length > 0 ? rows[rows.length - 1]!.seq : undefined;
    let hasMoreBefore: boolean | undefined;
    if (input.mode === "initial") {
      hasMoreBefore = replayFromId !== undefined && stats.firstSeq !== undefined && stats.firstSeq < replayFromId;
    } else if (input.mode === "before") {
      const anchor = replayFromId ?? input.beforeSeq ?? 0;
      hasMoreBefore = anchor > 0 && stats.firstSeq !== undefined && stats.firstSeq < anchor;
    }
    return {
      envelopes: rows.map((envelope) => this.channelEnvelopeView(envelope, input.channelId)),
      totalCount: stats.count,
      firstEnvelopeSeq: stats.firstSeq,
      replayFromId,
      replayToId,
      ...(hasMoreBefore !== undefined ? { hasMoreBefore } : {}),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listChannelEnvelopesAfter(input: {
    channelId: string;
    seq?: number | null;
    limit?: number | null;
  }): ChannelEnvelope[] {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "after",
      sinceSeq: input.seq ?? 0,
      limit: input.limit,
    }).envelopes;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listChannelEnvelopesBefore(input: {
    channelId: string;
    seq: number;
    limit?: number | null;
  }): ChannelEnvelope[] {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "before",
      beforeSeq: input.seq,
      limit: input.limit,
    }).envelopes;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getInitialChannelWindow(input: {
    channelId: string;
    limit?: number | null;
  }): ChannelReplayWindow {
    return this.getChannelReplayWindow({
      channelId: input.channelId,
      mode: "initial",
      limit: input.limit,
    });
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listChannelEnvelopes(input: {
    channelId: string;
    cursor?: number | null;
    limit?: number | null;
    payloadKind?: string | null;
  }): ChannelEnvelope[] {
    this.ensureReady();
    const limit = input.limit ?? 500;
    if (limit <= 0) return [];
    return this.readLog({
      logId: input.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: input.cursor ?? 0,
      payloadKind: input.payloadKind ?? null,
      limit,
    }).map((envelope) => this.channelEnvelopeView(envelope, input.channelId));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectChannelEnvelopes(input: {
    channelId: string;
    cursor?: number | null;
    limit?: number | null;
    payloadKind?: string | null;
  }): { rows: ChannelEnvelopeInspection[] } {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const envelopes = this.readLog({
      logId: input.channelId,
      head: CHANNEL_LOG_HEAD,
      afterSeq: input.cursor ?? 0,
      payloadKind: input.payloadKind ?? null,
      limit,
    });
    return {
      rows: envelopes.map((envelope) => {
        const annotations = envelope.annotations ?? {};
        const refs = this.sql
          .exec(
            `SELECT field_path, digest, purpose, size, created_at
             FROM log_blob_refs WHERE envelope_id = ?
             ORDER BY field_path ASC`,
            String(envelope.envelopeId)
          )
          .toArray() as JsonRecord[];
        const payloadText = JSON.stringify(envelope.payload ?? null);
        return {
          envelopeId: String(envelope.envelopeId),
          channelId: input.channelId,
          seq: envelope.seq,
          payloadKind: envelope.payloadKind,
          from: summarizeJsonForInspection(envelope.actor) as JsonRecord,
          ...(annotations["metadata"] !== undefined
            ? { metadata: summarizeJsonForInspection(annotations["metadata"]) as JsonRecord }
            : {}),
          bytes: {
            from: utf8Bytes(JSON.stringify(envelope.actor)),
            to: utf8Bytes(envelope.to !== undefined ? JSON.stringify(envelope.to) : ""),
            payload: utf8Bytes(payloadText),
            metadata: utf8Bytes(
              annotations["metadata"] !== undefined ? JSON.stringify(annotations["metadata"]) : ""
            ),
            attachments: utf8Bytes(
              annotations["attachments"] !== undefined
                ? JSON.stringify(annotations["attachments"])
                : ""
            ),
          },
          payloadSummary: summarizeJsonForInspection(envelope.payload),
          storedRefs: refs,
          publishedAt: envelope.appendedAt,
        };
      }),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listMessageTypes(input: { channelId: string }): ChannelMessageTypeDefinition[] {
    this.ensureReady();
    const rows = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         ORDER BY type_id ASC`,
        input.channelId
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapMessageType(row));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getMessageType(input: {
    channelId: string;
    typeId: string;
  }): ChannelMessageTypeDefinition | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT * FROM channel_message_types
         WHERE channel_id = ? AND type_id = ?
           AND source_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         LIMIT 1`,
        input.channelId,
        input.typeId
      )
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapMessageType(row) : null;
  }

  /** WS2: registry mutations are a projection of published `messageType.*`
   *  events — validated and applied inside the same append txn. Malformed
   *  registrations REJECT the append (replacing the channel-side
   *  `Invalid registry payload` throw). Idempotent under fork-seed/replay via
   *  the monotone seq guards in applyRegistryMutation. */
  private projectMessageTypeEvent(envelope: LogEnvelope): void {
    const event = envelope.payload as Record<string, unknown> | null;
    if (!event || typeof event !== "object") return;
    const kind = asString(event["kind"]);
    if (kind !== "messageType.registered" && kind !== "messageType.cleared") return;
    const payload =
      event["payload"] && typeof event["payload"] === "object" && !Array.isArray(event["payload"])
        ? (event["payload"] as Record<string, unknown>)
        : {};
    const typeId = asString(payload["typeId"]);
    if (!typeId) {
      throw new Error(`${kind} payload invalid: typeId must be a non-empty string`);
    }
    if (kind === "messageType.cleared") {
      this.applyRegistryMutation(envelope.logId, envelope.seq, {
        kind: "clearMessageType",
        typeId,
      });
      return;
    }
    const displayMode = payload["displayMode"];
    if (displayMode !== "inline" && displayMode !== "row") {
      throw new Error(
        `messageType.registered payload invalid: displayMode must be "inline" or "row"`
      );
    }
    const source = payload["source"];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`messageType.registered payload invalid: source is required`);
    }
    for (const field of ["imports", "stateSchema", "updateSchema"] as const) {
      const value = payload[field];
      if (value !== undefined && (typeof value !== "object" || Array.isArray(value))) {
        throw new Error(`messageType.registered payload invalid: ${field} must be an object`);
      }
    }
    const registeredBy = payload["registeredBy"] ?? event["actor"];
    this.applyRegistryMutation(
      envelope.logId,
      envelope.seq,
      sanitizeRegistryMutation({
        kind: "upsertMessageType",
        typeId,
        row: {
          displayMode: displayMode as "inline" | "row",
          source: source as ChannelMessageTypeDefinition["source"],
          ...(payload["imports"] ? { imports: payload["imports"] as Record<string, string> } : {}),
          ...(payload["stateSchema"]
            ? { stateSchema: payload["stateSchema"] as Record<string, unknown> }
            : {}),
          ...(payload["updateSchema"]
            ? { updateSchema: payload["updateSchema"] as Record<string, unknown> }
            : {}),
          ...(registeredBy ? { registeredBy: registeredBy as Record<string, unknown> } : {}),
        },
      })
    );
  }

  private applyRegistryMutation(
    channelId: string,
    seq: number,
    mutation: RegistryMutationInput
  ): void {
    if (mutation.kind === "upsertMessageType") {
      this.sql.exec(
        `INSERT INTO channel_message_types (
           channel_id, type_id, display_mode, source_json, imports_json, schema_json,
           registered_by_json, updated_at_seq, cleared_at_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(channel_id, type_id) DO UPDATE SET
           display_mode = excluded.display_mode,
           source_json = excluded.source_json,
           imports_json = excluded.imports_json,
           schema_json = excluded.schema_json,
           registered_by_json = excluded.registered_by_json,
           updated_at_seq = excluded.updated_at_seq,
           cleared_at_seq = CASE
             WHEN channel_message_types.cleared_at_seq IS NOT NULL
              AND channel_message_types.cleared_at_seq > excluded.updated_at_seq
             THEN channel_message_types.cleared_at_seq
             ELSE NULL
           END
         WHERE excluded.updated_at_seq > channel_message_types.updated_at_seq
           AND excluded.updated_at_seq > COALESCE(channel_message_types.cleared_at_seq, -1)`,
        channelId,
        mutation.typeId,
        mutation.row.displayMode,
        JSON.stringify(mutation.row.source),
        mutation.row.imports ? JSON.stringify(mutation.row.imports) : null,
        // schema_json holds both JSON Schema documents for the type.
        mutation.row.stateSchema !== undefined || mutation.row.updateSchema !== undefined
          ? JSON.stringify({
              stateSchema: mutation.row.stateSchema,
              updateSchema: mutation.row.updateSchema,
            })
          : null,
        mutation.row.registeredBy ? JSON.stringify(mutation.row.registeredBy) : null,
        seq
      );
      return;
    }

    this.sql.exec(
      `INSERT INTO channel_message_types (
         channel_id, type_id, updated_at_seq, cleared_at_seq
       ) VALUES (?, ?, -1, ?)
       ON CONFLICT(channel_id, type_id) DO UPDATE SET
         cleared_at_seq = MAX(COALESCE(channel_message_types.cleared_at_seq, -1), excluded.cleared_at_seq)`,
      channelId,
      mutation.typeId,
      seq
    );
  }

  private mapMessageType(row: JsonRecord): ChannelMessageTypeDefinition {
    const result: ChannelMessageTypeDefinition = {
      typeId: String(row["type_id"]),
      displayMode: String(row["display_mode"]) === "inline" ? "inline" : "row",
      source: parseRecord(asString(row["source_json"])) as ChannelMessageTypeDefinition["source"],
      updatedAtSeq: asNumber(row["updated_at_seq"]),
    };
    if (row["imports_json"])
      result.imports = parseRecord(asString(row["imports_json"])) as Record<string, string>;
    if (row["schema_json"]) {
      const schemas = parseJson(asString(row["schema_json"])) as {
        stateSchema?: Record<string, unknown>;
        updateSchema?: Record<string, unknown>;
      } | null;
      if (schemas && typeof schemas === "object") {
        if (schemas.stateSchema) result.stateSchema = schemas.stateSchema;
        if (schemas.updateSchema) result.updateSchema = schemas.updateSchema;
      }
    }
    if (row["registered_by_json"])
      result.registeredBy = parseRecord(asString(row["registered_by_json"]));
    if (row["cleared_at_seq"] !== null && row["cleared_at_seq"] !== undefined) {
      result.clearedAtSeq = asNumber(row["cleared_at_seq"]);
    }
    return result;
  }

  // --- Lineage queries over causality edges ----------------------------------

  private originRowForChannelRow(channelRow: JsonRecord): JsonRecord | null {
    const originLogId = asString(channelRow["origin_log_id"]);
    const originHead = asString(channelRow["origin_head"]);
    const originEnvelopeId = asString(channelRow["origin_envelope_id"]);
    if (!originLogId || !originHead || !originEnvelopeId) return null;
    return this.lineageEventRow(originLogId, originHead, originEnvelopeId);
  }

  private lineageForChannelRow(channelRow: JsonRecord): EnvelopeLineage | null {
    const originRow = this.originRowForChannelRow(channelRow);
    if (!originRow) return null;
    const channelEnvelope = this.mapLogEnvelope(channelRow);
    const originEnvelope = this.mapLogEnvelope(originRow);
    return {
      publication: {
        eventId: String(originEnvelope.envelopeId),
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
        channelId: channelEnvelope.logId,
        channelSeq: channelEnvelope.seq,
        envelopeId: String(channelEnvelope.envelopeId),
        publishedAt: channelEnvelope.appendedAt,
      },
      envelope: this.channelEnvelopeView(channelEnvelope),
      trajectoryEvent: this.trajectoryEventView(originEnvelope, {
        trajectoryId: String(channelRow["origin_log_id"]),
        branchId: String(channelRow["origin_head"]),
      }),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getTrajectoryForEnvelope(input: { envelopeId: string }): EnvelopeLineage | null {
    this.ensureReady();
    const channelRow = this.sql
      .exec(
        `SELECT * FROM log_events WHERE envelope_id = ? AND origin_envelope_id IS NOT NULL LIMIT 1`,
        input.envelopeId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!channelRow) return null;
    return this.lineageForChannelRow(channelRow);
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listPublishedEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    this.ensureReady();
    const clauses: string[] = ["ch.origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("ch.origin_log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("ch.origin_head = ?");
      bindings.push(input.branchId);
    }
    if (input.eventId) {
      clauses.push("ch.origin_envelope_id = ?");
      bindings.push(input.eventId);
    }
    if (input.channelId) {
      clauses.push("ch.log_id = ?");
      bindings.push(input.channelId);
    }
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT ch.* FROM log_events ch
         WHERE ${clauses.join(" AND ")}
         ORDER BY ch.log_id ASC, ch.seq ASC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    const lineages: EnvelopeLineage[] = [];
    for (const row of rows) {
      const lineage = this.lineageForChannelRow(row);
      if (!lineage) continue;
      if (input.turnId && lineage.trajectoryEvent.turnId !== input.turnId) continue;
      lineages.push(lineage);
    }
    return lineages;
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    return this.listPublishedEnvelopesForTrajectory(input);
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getPublishedArtifactsForTurn(input: {
    branchId?: string | null;
    turnId: string;
    channelId?: string | null;
    limit?: number | null;
  }): PublishedArtifact[] {
    return this.listPublishedEnvelopesForTrajectory({
      branchId: input.branchId,
      turnId: input.turnId,
      channelId: input.channelId,
      limit: input.limit,
    }).map((lineage) => ({ lineage }));
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getPrivateLineageForPublishedEnvelope(input: {
    envelopeId: string;
  }): PrivateLineageForPublishedEnvelope | null {
    this.ensureReady();
    const lineage = this.getTrajectoryForEnvelope(input);
    if (!lineage) return null;
    const trajectoryId = lineage.publication.trajectoryId;
    const branchId = lineage.publication.branchId;
    const events = this.readLog({ logId: trajectoryId, head: branchId, limit: 0 }).filter(
      (envelope) => envelope.seq <= lineage.trajectoryEvent.seq
    );
    return {
      lineage,
      branchEvents: events.map((envelope) =>
        this.trajectoryEventView(envelope, { trajectoryId, branchId })
      ),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getDownstreamConsumers(input: { envelopeId: string; limit?: number | null }): TrajectoryEvent[] {
    this.ensureReady();
    const needle = input.envelopeId;
    const rows = this.sql
      .exec(
        `SELECT * FROM log_events
         WHERE (causality_json LIKE ? OR payload_ref_json LIKE ?)
           AND envelope_id != ?
           AND origin_envelope_id IS NULL
         ORDER BY appended_at ASC, log_id ASC, head ASC, seq ASC
         LIMIT ?`,
        `%${needle}%`,
        `%${needle}%`,
        needle,
        Math.min(Math.max(input.limit ?? 500, 1), 1000)
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.trajectoryEventView(this.mapLogEnvelope(row)));
  }

  // --- Inspection / maintenance ----------------------------------------------

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectPublicationIntegrity(
    input: { channelId?: string | null; branchId?: string | null; limit?: number | null } = {}
  ): PublicationIntegrityInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = ["origin_envelope_id IS NOT NULL"];
    const bindings: SqlBinding[] = [];
    if (input.channelId) {
      clauses.push("log_id = ?");
      bindings.push(input.channelId);
    }
    if (input.branchId) {
      clauses.push("origin_head = ?");
      bindings.push(input.branchId);
    }
    const publicationRows = this.sql
      .exec(
        `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY log_id, seq`,
        ...bindings
      )
      .toArray() as JsonRecord[];
    const rows: JsonRecord[] = [];
    let orphanMappings = 0;
    for (const row of publicationRows) {
      const origin = this.originRowForChannelRow(row);
      if (!origin) {
        orphanMappings += 1;
        if (rows.length < limit) {
          rows.push({
            type: "orphan-mapping",
            envelopeId: row["envelope_id"] as JsonValue,
            channelId: row["log_id"] as JsonValue,
            originLogId: row["origin_log_id"] as JsonValue,
            originEnvelopeId: row["origin_envelope_id"] as JsonValue,
          });
        }
      }
    }
    const channelOriginAgenticEnvelopes = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS count FROM log_events
           WHERE payload_kind = ? AND origin_envelope_id IS NULL
           ${input.channelId ? "AND log_id = ?" : ""}`,
          ...(input.channelId
            ? [AGENTIC_EVENT_PAYLOAD_KIND, input.channelId]
            : [AGENTIC_EVENT_PAYLOAD_KIND])
        )
        .one()["count"]
    );
    return {
      summary: {
        expectedMappings: publicationRows.length,
        missingMappings: 0,
        orphanMappings,
        missingPublicationEvents: orphanMappings,
        missingPublicationEnvelopes: 0,
        sequenceMismatches: 0,
        channelOriginAgenticEnvelopes,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectTurnState(
    input: {
      trajectoryId?: string | null;
      branchId?: string | null;
      channelId?: string | null;
      limit?: number | null;
    } = {}
  ): TurnStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("t.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("t.head = ?");
      bindings.push(input.branchId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT t.log_id AS log_id,
                t.head AS head,
                t.turn_id AS turn_id,
                t.opened_at AS opened_at,
                t.closed_at AS closed_at,
                COUNT(DISTINCT CASE WHEN m.status != 'completed' THEN m.message_id END) AS streaming_messages,
                COUNT(DISTINCT CASE WHEN i.status NOT IN ('completed', 'failed', 'cancelled', 'abandoned') THEN i.invocation_id END) AS nonterminal_invocations,
                COUNT(DISTINCT e.envelope_id) AS duplicate_open_events
         FROM trajectory_turns t
         LEFT JOIN trajectory_messages m
           ON m.log_id = t.log_id AND m.head = t.head AND m.turn_id = t.turn_id
         LEFT JOIN trajectory_invocations i
           ON i.log_id = t.log_id AND i.head = t.head AND i.turn_id = t.turn_id
         LEFT JOIN log_events e
           ON e.log_id = t.log_id AND e.head = t.head AND e.turn_id = t.turn_id
          AND e.payload_kind = 'turn.opened'
         ${where}
         GROUP BY t.log_id, t.head, t.turn_id, t.opened_at, t.closed_at
         ORDER BY t.opened_at DESC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    const scopedRows = input.channelId
      ? rows.filter((row) => String(row["head"]).includes(input.channelId!))
      : rows;
    return {
      summary: {
        branches: new Set(
          scopedRows.map((row) => `${String(row["log_id"])} ${String(row["head"])}`)
        ).size,
        openTurns: scopedRows.filter((row) => row["closed_at"] == null).length,
        streamingMessages: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["streaming_messages"]),
          0
        ),
        nonterminalInvocations: scopedRows.reduce(
          (sum, row) => sum + asNumber(row["nonterminal_invocations"]),
          0
        ),
        duplicateOpenedTurns: scopedRows.filter((row) => asNumber(row["duplicate_open_events"]) > 1)
          .length,
      },
      rows: scopedRows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectInvocationState(
    input: {
      trajectoryId?: string | null;
      branchId?: string | null;
      invocationId?: string | null;
      transportCallId?: string | null;
      limit?: number | null;
    } = {}
  ): InvocationStateInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("i.log_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("i.head = ?");
      bindings.push(input.branchId);
    }
    if (input.invocationId) {
      clauses.push("i.invocation_id = ?");
      bindings.push(input.invocationId);
    }
    if (input.transportCallId) {
      clauses.push("i.transport_call_id = ?");
      bindings.push(input.transportCallId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT i.log_id,
                i.head,
                i.invocation_id,
                i.transport_call_id,
                i.kind,
                i.status,
                i.terminal_outcome,
                i.terminal_reason_code,
                i.started_event_id,
                i.completed_event_id,
                i.updated_at,
                COUNT(CASE WHEN e.payload_kind = 'invocation.started' THEN 1 END) AS started_events,
                COUNT(CASE WHEN e.payload_kind IN ('invocation.completed', 'invocation.failed', 'invocation.cancelled', 'invocation.abandoned') THEN 1 END) AS terminal_events
         FROM trajectory_invocations i
         LEFT JOIN log_events e
           ON e.log_id = i.log_id
          AND e.head = i.head
          AND json_extract(e.causality_json, '$.invocationId') = i.invocation_id
         ${where}
         GROUP BY i.log_id, i.head, i.invocation_id, i.transport_call_id, i.kind, i.status,
                  i.terminal_outcome, i.terminal_reason_code, i.started_event_id,
                  i.completed_event_id, i.updated_at
         ORDER BY i.updated_at DESC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    return {
      summary: {
        projected: rows.length,
        startedEvents: rows.reduce((sum, row) => sum + asNumber(row["started_events"]), 0),
        terminalEvents: rows.reduce((sum, row) => sum + asNumber(row["terminal_events"]), 0),
        openProjectedInvocations: rows.filter(
          (row) =>
            !["completed", "failed", "cancelled", "abandoned"].includes(String(row["status"]))
        ).length,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectChannelRoster(input: {
    channelId: string;
    limit?: number | null;
  }): ChannelRosterInspection {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT channel_id,
                participant_id,
                joined_at,
                left_at,
                roles_json
           FROM channel_roster
          WHERE channel_id = ?
          ORDER BY joined_at DESC
          LIMIT ?`,
        input.channelId,
        limit
      )
      .toArray()
      .map((row) => ({
        channel_id: row["channel_id"] as JsonValue,
        participant_id: row["participant_id"] as JsonValue,
        joined_at: row["joined_at"] as JsonValue,
        left_at: row["left_at"] as JsonValue,
        roles: parseJson(row["roles_json"] as string | null | undefined) as JsonValue,
      })) as JsonRecord[];
    return {
      summary: {
        rows: rows.length,
        activeParticipants: rows.filter((row) => row["left_at"] == null).length,
        inactiveParticipants: rows.filter((row) => row["left_at"] != null).length,
      },
      rows,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  async inspectAgentHealth(input: {
    channelId: string;
    branchId?: string | null;
    limit?: number | null;
    envelopeLimit?: number | null;
    storageLimit?: number | null;
    rowByteLimit?: number | null;
  }): Promise<AgentHealthInspection> {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const branchId = input.branchId ?? `branch:channel:${input.channelId}`;
    const publicationIntegrity = this.inspectPublicationIntegrity({
      channelId: input.channelId,
      branchId,
      limit,
    });
    const turnState = this.inspectTurnState({ channelId: input.channelId, branchId, limit });
    const invocationState = this.inspectInvocationState({ branchId, limit });
    const roster = this.inspectChannelRoster({ channelId: input.channelId, limit });
    const envelopes = this.inspectChannelEnvelopes({
      channelId: input.channelId,
      limit: input.envelopeLimit ?? Math.min(limit, 25),
    });
    const storage = this.inspectStorageDiagnostics({
      branchId,
      channelId: input.channelId,
      rowByteLimit: input.rowByteLimit,
      limit: input.storageLimit ?? Math.min(limit, 25),
    });
    const publicationIssues =
      asNumber(publicationIntegrity.summary.missingMappings) +
      asNumber(publicationIntegrity.summary.orphanMappings) +
      asNumber(publicationIntegrity.summary.sequenceMismatches);
    const openTurns = asNumber(turnState.summary.openTurns);
    const streamingMessages = asNumber(turnState.summary.streamingMessages);
    const nonterminalInvocations = asNumber(turnState.summary.nonterminalInvocations);
    const storageIssues = storage.rows.length;
    return {
      channelId: input.channelId,
      branchId,
      generatedAt: nowIso(),
      summary: {
        ok:
          publicationIssues === 0 &&
          openTurns === 0 &&
          streamingMessages === 0 &&
          nonterminalInvocations === 0 &&
          storageIssues === 0,
        publicationIssues,
        openTurns,
        streamingMessages,
        nonterminalInvocations,
        activeParticipants: roster.summary.activeParticipants,
        storageIssues,
      },
      publicationIntegrity,
      turnState,
      invocationState,
      roster,
      envelopes,
      storage,
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  inspectStorageDiagnostics(
    input: {
      rowByteLimit?: number | null;
      limit?: number | null;
      branchId?: string | null;
      channelId?: string | null;
    } = {}
  ): { rows: JsonRecord[] } {
    this.ensureReady();
    const rowByteLimit = input.rowByteLimit ?? 512 * 1024;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows: JsonRecord[] = [];

    const eventClauses = ["length(payload_ref_json) > ?"];
    const eventBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      eventClauses.unshift("(head = ? OR log_id = ?)");
      eventBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      eventClauses.unshift("head = ?");
      eventBindings.push(input.branchId);
    } else if (input.channelId) {
      eventClauses.unshift("log_id = ?");
      eventBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'log_events' AS scope, envelope_id AS id, length(payload_ref_json) AS bytes
           FROM log_events
           WHERE ${eventClauses.join(" AND ")}
           ORDER BY bytes DESC LIMIT ?`,
          ...eventBindings,
          rowByteLimit,
          limit
        )
        .toArray() as JsonRecord[])
    );

    const invocationBindings: SqlBinding[] = [];
    const invocationWhere = input.branchId ? "AND head = ?" : "";
    if (input.branchId) invocationBindings.push(input.branchId);
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'trajectory_invocations' AS scope, invocation_id AS id,
                  MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) AS bytes
           FROM trajectory_invocations
           WHERE MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) > ?
           ${invocationWhere}
           ORDER BY bytes DESC LIMIT ?`,
          rowByteLimit,
          ...invocationBindings,
          limit
        )
        .toArray() as JsonRecord[])
    );

    const refClauses: string[] = [];
    const refBindings: SqlBinding[] = [];
    if (input.branchId && input.channelId) {
      refClauses.push("(r.head = ? OR r.log_id = ?)");
      refBindings.push(input.branchId, input.channelId);
    } else if (input.branchId) {
      refClauses.push("r.head = ?");
      refBindings.push(input.branchId);
    } else if (input.channelId) {
      refClauses.push("r.log_id = ?");
      refBindings.push(input.channelId);
    }
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'missing_gad_blob_index' AS scope, r.digest AS id, r.size AS bytes
           FROM log_blob_refs r
           LEFT JOIN gad_blobs b ON b.hash = r.digest
           WHERE b.hash IS NULL
           ${refClauses.length ? `AND ${refClauses.join(" AND ")}` : ""}
           LIMIT ?`,
          ...refBindings,
          limit
        )
        .toArray() as JsonRecord[])
    );

    return { rows: rows.slice(0, limit) };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  listStoredValueRefs(
    input: {
      eventId?: string | null;
      envelopeId?: string | null;
      digest?: string | null;
      limit?: number | null;
    } = {}
  ): { rows: JsonRecord[] } {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    const ownerId = input.eventId ?? input.envelopeId;
    if (ownerId) {
      clauses.push("r.envelope_id = ?");
      bindings.push(ownerId);
    }
    if (input.digest) {
      clauses.push("r.digest = ?");
      bindings.push(input.digest);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.sql
      .exec(
        `SELECT CASE WHEN lh.log_kind = 'channel' THEN 'channel' ELSE 'trajectory' END AS ref_scope,
                r.envelope_id AS owner_id,
                r.field_path, r.digest, r.purpose, r.size, r.created_at
         FROM log_blob_refs r
         LEFT JOIN log_heads lh ON lh.log_id = r.log_id AND lh.head = r.head
         ${where}
         ORDER BY r.created_at ASC LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    return { rows };
  }

  @rpc({ callers: ["server", "harness"] })
  collectGarbageBlobRefs(input: { dryRun?: boolean | null; limit?: number | null } = {}): {
    deleted: string[];
    kept: number;
    dryRun: boolean;
  } {
    this.ensureReady();
    const dryRun = input.dryRun !== false;
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 5000);
    const rows = this.sql
      .exec(
        `SELECT b.hash
       FROM gad_blobs b
       LEFT JOIN (
         SELECT digest FROM log_blob_refs
         UNION
         SELECT content_hash AS digest FROM gad_file_versions WHERE content_hash IS NOT NULL
       ) refs ON refs.digest = b.hash
       WHERE refs.digest IS NULL
       LIMIT ?`,
        limit
      )
      .toArray() as Array<{ hash: string }>;
    const deleted = rows.map((row) => String(row.hash));
    if (!dryRun) {
      for (const hash of deleted) this.sql.exec(`DELETE FROM gad_blobs WHERE hash = ?`, hash);
    }
    const kept =
      asNumber(this.sql.exec(`SELECT COUNT(*) AS cnt FROM gad_blobs`).one()["cnt"]) -
      (dryRun ? 0 : deleted.length);
    return { deleted, kept, dryRun };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  getStatus(): { metric: string; value: number }[] {
    const count = (sql: string, ...bindings: SqlBinding[]) =>
      asNumber(this.sql.exec(sql, ...bindings).one()["value"]);
    return [
      { metric: "Log events", value: count(`SELECT COUNT(*) AS value FROM log_events`) },
      { metric: "Log heads", value: count(`SELECT COUNT(*) AS value FROM log_heads`) },
      {
        metric: "Channel envelopes",
        value: count(
          `SELECT COUNT(*) AS value FROM log_events e
           JOIN log_heads h ON h.log_id = e.log_id AND h.head = e.head
           WHERE h.log_kind = 'channel'`
        ),
      },
      {
        metric: "Worktree states",
        value: count(`SELECT COUNT(*) AS value FROM gad_worktree_states`),
      },
      { metric: "Claims", value: count(`SELECT COUNT(*) AS value FROM gad_claims`) },
    ];
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  async validateGadHashes(): Promise<{ ok: boolean; errors: string[] }> {
    const integrity = await this.checkGadIntegrity();
    return {
      ok: integrity.ok,
      errors: integrity.errors.map(
        (error) => `${String(error["type"])}: ${String(error["message"])}`
      ),
    };
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  clearDirtyAfterValidation(): Promise<{ ok: boolean; errors: string[] }> {
    return this.validateGadHashes();
  }

  @rpc({ callers: ["panel", "do", "worker", "server", "harness"] })
  async checkGadIntegrity(): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    this.ensureReady();
    const errors: JsonRecord[] = [];
    const addError = (type: string, message: string, details: JsonRecord = {}) =>
      errors.push({ type, message, ...details });

    const logIntegrity = await this.checkLogIntegrity({});
    errors.push(...logIntegrity.errors);

    const manifestSeen = new Map<string, string | null>();
    for (const state of this.sql
      .exec(`SELECT state_hash, manifest_root_hash FROM gad_worktree_states`)
      .toArray() as JsonRecord[]) {
      const rootHash = asString(state["manifest_root_hash"]) ?? "";
      const recomputedRoot = this.recomputeManifestHashDeep(rootHash, errors, manifestSeen);
      if (recomputedRoot !== null && this.stateHashForRoot(rootHash) !== state["state_hash"]) {
        addError("worktree-state", "worktree state hash mismatch", {
          stateHash: state["state_hash"] as JsonValue,
          expectedStateHash: this.stateHashForRoot(rootHash),
        });
      }
    }

    for (const transition of this.sql
      .exec(`SELECT * FROM gad_state_transitions`)
      .toArray() as JsonRecord[]) {
      const eventId = String(transition["event_id"]);
      if (!this.stateExists(String(transition["input_state_hash"]))) {
        addError("state-transition", "transition input state is missing", { eventId });
      }
      if (!this.stateExists(String(transition["output_state_hash"]))) {
        addError("state-transition", "transition output state is missing", { eventId });
      }
      const eventExists =
        this.sql
          .exec(`SELECT 1 AS ok FROM log_events WHERE envelope_id = ? LIMIT 1`, eventId)
          .toArray().length > 0;
      if (!eventExists) {
        addError("state-transition", "transition event is missing", { eventId });
      }
    }

    for (const orphan of this.inspectPublicationIntegrity({}).rows) {
      addError("publication", "publication origin is missing", orphan);
    }

    for (const event of this.sql.exec(`SELECT * FROM log_events`).toArray() as JsonRecord[]) {
      for (const field of [
        "actor_json",
        "to_json",
        "payload_ref_json",
        "annotations_json",
      ] as const) {
        const path = findPrivateParticipantMetadataPath(parseJson(asString(event[field])));
        if (path) {
          addError("log-event-shape", "log event contains private participant metadata", {
            envelopeId: event["envelope_id"] as JsonValue,
            field,
            path,
          });
        }
      }
    }

    for (const row of this.inspectStorageDiagnostics({}).rows) {
      addError("storage-diagnostic", "oversized or missing indexed storage artifact", row);
    }

    return { ok: errors.length === 0, errors };
  }

  private stateExists(stateHash: string): boolean {
    return !!this.sql
      .exec(`SELECT 1 AS ok FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0];
  }

  private ensureEmptyState(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (manifest_hash, kind, created_at) VALUES (?, 'dir', ?)`,
      EMPTY_MANIFEST_HASH,
      nowIso()
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?)`,
      EMPTY_STATE_HASH,
      EMPTY_MANIFEST_HASH,
      JSON.stringify({ empty: true }),
      nowIso()
    );
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}

/** Whether a payload kind is a member of the agentic EventKind vocabulary. */
function isStoredEventKind(payloadKind: string): boolean {
  return STORED_EVENT_KINDS.has(payloadKind);
}

const STORED_EVENT_KINDS = new Set<string>([
  "message.started",
  "message.delta",
  "message.completed",
  "message.failed",
  "invocation.started",
  "invocation.progress",
  "invocation.output",
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
  "approval.requested",
  "approval.resolved",
  "ui.inline_rendered",
  "ui.action_bar.updated",
  "ui.feedback",
  "messageType.registered",
  "messageType.cleared",
  "custom.started",
  "custom.updated",
  "state.file_observed",
  "state.file_mutation_intended",
  "state.file_mutation_applied",
  "state.transition_recorded",
  "state.snapshot_ingested",
  "state.merge_applied",
  "external.envelope_published",
  "external.envelope_observed",
  "external.participant_observed",
  "branch.created",
  "branch.forked",
  "branch.head_changed",
  "turn.opened",
  "turn.waiting",
  "turn.closed",
  "system.event",
  "system.compaction_recorded",
  "memory.recalled",
  "build.completed",
  "knowledge.claim_recorded",
  "knowledge.claim_updated",
  "knowledge.claim_retracted",
]);
