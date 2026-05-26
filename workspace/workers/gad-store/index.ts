import { DurableObjectBase } from "@workspace/runtime/worker";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  GENESIS_EVENT_HASH,
  agenticEventSchema,
  assertAgenticEventStoredValuesEncoded,
  brandId,
  channelEnvelopeSchema,
  checkTrajectoryIntegrity,
  collectStoredValueRefs,
  computeEventHash,
  trajectoryEventSchema,
  type AgenticEvent,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type EventId,
  type TrajectoryEvent,
} from "@workspace/agentic-protocol";

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;

const EMPTY_MANIFEST_HASH =
  "manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526";
const EMPTY_STATE_HASH = "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7";

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
  schemaSourceOrPath?: unknown;
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
  const verb = sql
    .trimStart()
    .match(/^[A-Za-z]+/u)?.[0]
    ?.toUpperCase();
  return verb === "SELECT" || verb === "EXPLAIN" || verb === "PRAGMA";
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortJson(child);
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function semanticAgenticEvent(value: AgenticEvent | TrajectoryEvent): Record<string, unknown> {
  return {
    kind: value.kind,
    actor: value.actor,
    ...(value.turnId ? { turnId: value.turnId } : {}),
    ...((value as { causality?: unknown }).causality
      ? { causality: (value as { causality?: unknown }).causality }
      : {}),
    payload: value.payload,
    createdAt: value.createdAt,
  };
}

function sameAgenticEvent(left: AgenticEvent | TrajectoryEvent, right: AgenticEvent): boolean {
  return stableJson(semanticAgenticEvent(left)) === stableJson(semanticAgenticEvent(right));
}

function semanticChannelEnvelope(value: ChannelEnvelope): Record<string, unknown> {
  return {
    channelId: value.channelId,
    from: value.from,
    ...(value.to !== undefined ? { to: value.to } : {}),
    payload: value.payload,
    ...(value.payloadKind !== undefined ? { payloadKind: value.payloadKind } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    ...(value.attachments !== undefined ? { attachments: value.attachments } : {}),
    publishedAt: value.publishedAt,
  };
}

function sameChannelEnvelope(left: ChannelEnvelope, right: ChannelEnvelope): boolean {
  return stableJson(semanticChannelEnvelope(left)) === stableJson(semanticChannelEnvelope(right));
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 13;

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
    void this.setOwnTitle("GAD store");
  }

  protected createTables(): void {
    this.dropPersistenceTables();
    this.createFreshSchema();
  }

  private dropPersistenceTables(): void {
    const rows = this.sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type IN ('table', 'view')
	           AND (
	             name LIKE 'trajectory_%' OR name LIKE 'channel_%' OR name LIKE 'gad_%'
	             OR name IN ('branches', 'sessions', 'conversation_turns', 'tool_calls',
	                         'file_versions', 'tracked_files', 'blobs')
	           )`
      )
      .toArray() as Array<{ name: string }>;
    for (const row of rows) {
      this.sql.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(row.name)}`);
      this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(row.name)}`);
    }
  }

  private createFreshSchema(): void {
    this.sql.exec(`
      CREATE TABLE trajectory_branches (
        trajectory_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        owner_json TEXT NOT NULL,
        head_event_id TEXT,
        head_event_hash TEXT,
        head_state_hash TEXT,
        parent_branch_id TEXT,
        fork_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (trajectory_id, branch_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_trajectory_branches_head ON trajectory_branches(head_event_hash)`
    );
    this.sql.exec(`
      CREATE TABLE trajectory_events (
        event_id TEXT NOT NULL UNIQUE,
        branch_id TEXT NOT NULL,
        trajectory_id TEXT NOT NULL,
        turn_id TEXT,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        causality_json TEXT,
        payload_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        prev_event_hash TEXT NOT NULL,
        PRIMARY KEY (branch_id, seq)
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_trajectory_events_kind ON trajectory_events(kind, branch_id, seq)`
    );
    this.sql.exec(`CREATE INDEX idx_trajectory_events_turn ON trajectory_events(turn_id, seq)`);
    this.sql.exec(`CREATE INDEX idx_trajectory_events_hash ON trajectory_events(event_hash)`);
    this.sql.exec(`
      CREATE TABLE trajectory_blob_refs (
        event_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        preview_json TEXT,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_id, field_path)
      )
    `);
    this.sql.exec(`CREATE INDEX idx_trajectory_blob_refs_digest ON trajectory_blob_refs(digest)`);
    this.sql.exec(`
      CREATE TABLE trajectory_turns (
        turn_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        opened_at TEXT,
        closed_at TEXT,
        summary TEXT,
        PRIMARY KEY (branch_id, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_messages (
        message_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        role TEXT NOT NULL,
        body_assembled TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, message_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_message_blocks (
        block_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        body_ref_json TEXT,
        invocation_id TEXT,
        PRIMARY KEY (branch_id, block_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_invocations (
        invocation_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        transport_call_id TEXT,
        kind TEXT,
        status TEXT NOT NULL,
        request_ref_json TEXT,
        result_ref_json TEXT,
        started_event_id TEXT,
        completed_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, invocation_id)
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_trajectory_invocations_transport ON trajectory_invocations(transport_call_id)`
    );
    this.sql.exec(`
      CREATE TABLE trajectory_invocation_outputs (
        invocation_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk_ref_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, invocation_id, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_approvals (
        approval_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        invocation_id TEXT,
        status TEXT NOT NULL,
        requested_by_json TEXT,
        resolved_by_json TEXT,
        requested_event_id TEXT,
        resolved_event_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, approval_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_usage_rollups (
        branch_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (branch_id, turn_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_checkpoints (
        branch_id TEXT NOT NULL,
        anchor_event_hash TEXT NOT NULL,
        materialized_blob_json TEXT NOT NULL,
        materializer_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (branch_id, anchor_event_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE channel_envelopes (
        envelope_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        from_json TEXT NOT NULL,
        to_json TEXT,
        payload_ref_json TEXT NOT NULL,
        payload_kind TEXT,
        metadata_json TEXT,
        attachments_json TEXT,
        published_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, seq)
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_channel_envelopes_kind ON channel_envelopes(payload_kind, channel_id, seq)`
    );
    this.sql.exec(`
      CREATE TABLE channel_blob_refs (
        envelope_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        purpose TEXT NOT NULL,
        preview_json TEXT,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (envelope_id, field_path)
      )
    `);
    this.sql.exec(`CREATE INDEX idx_channel_blob_refs_digest ON channel_blob_refs(digest)`);
    this.sql.exec(`
      CREATE TABLE channel_message_types (
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
      CREATE TABLE trajectory_channel_publications (
        event_id TEXT NOT NULL,
        trajectory_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_seq INTEGER NOT NULL,
        envelope_id TEXT NOT NULL,
        published_at TEXT NOT NULL,
        PRIMARY KEY (event_id, envelope_id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX idx_trajectory_channel_publications_envelope
        ON trajectory_channel_publications(envelope_id)
    `);
    this.sql.exec(`
      CREATE INDEX idx_trajectory_channel_publications_branch
        ON trajectory_channel_publications(branch_id, event_id)
    `);
    this.sql.exec(`
      CREATE INDEX idx_trajectory_channel_publications_channel
        ON trajectory_channel_publications(channel_id, channel_seq)
    `);
    this.sql.exec(`
      CREATE TABLE channel_envelope_forks (
        from_channel_id TEXT NOT NULL,
        to_channel_id TEXT NOT NULL,
        source_envelope_id TEXT NOT NULL,
        fork_envelope_id TEXT NOT NULL UNIQUE,
        source_seq INTEGER NOT NULL,
        fork_seq INTEGER NOT NULL,
        forked_at TEXT NOT NULL,
        PRIMARY KEY (to_channel_id, fork_seq)
      )
    `);
    this.sql.exec(`
      CREATE INDEX idx_channel_envelope_forks_source
        ON channel_envelope_forks(from_channel_id, source_seq)
    `);
    this.sql.exec(`
      CREATE TABLE trajectory_event_forks (
        from_trajectory_id TEXT NOT NULL,
        from_branch_id TEXT NOT NULL,
        to_trajectory_id TEXT NOT NULL,
        to_branch_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        fork_event_id TEXT NOT NULL UNIQUE,
        source_seq INTEGER NOT NULL,
        fork_seq INTEGER NOT NULL,
        source_event_hash TEXT NOT NULL,
        fork_event_hash TEXT NOT NULL,
        forked_at TEXT NOT NULL,
        PRIMARY KEY (to_trajectory_id, to_branch_id, fork_seq)
      )
    `);
    this.sql.exec(`
      CREATE INDEX idx_trajectory_event_forks_source
        ON trajectory_event_forks(from_trajectory_id, from_branch_id, source_seq)
    `);
    this.sql.exec(`
      CREATE TABLE channel_roster (
        channel_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        left_at TEXT,
        roles_json TEXT,
        PRIMARY KEY (channel_id, participant_id, joined_at)
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_worktree_states (
        state_hash TEXT PRIMARY KEY,
        manifest_root_hash TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_file_versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mode INTEGER NOT NULL DEFAULT 33188,
        created_at TEXT NOT NULL,
        UNIQUE (path, content_hash, mode)
      )
    `);
    this.sql.exec(`CREATE INDEX idx_gad_file_versions_path ON gad_file_versions(path)`);
    this.sql.exec(`
      CREATE TABLE gad_manifest_nodes (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_manifest_entries (
        parent_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        child_manifest_hash TEXT,
        file_version_id INTEGER,
        PRIMARY KEY (parent_hash, name)
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_state_transitions (
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
      `CREATE INDEX idx_gad_state_transitions_output ON gad_state_transitions(output_state_hash)`
    );
    this.sql.exec(`
      CREATE TABLE gad_file_observations (
        observation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        invocation_id TEXT,
        path TEXT NOT NULL,
        observed_state_hash TEXT NOT NULL,
        file_version_id INTEGER,
        content_hash TEXT,
        size INTEGER,
        mime_type TEXT,
        range_start_line INTEGER,
        range_end_line INTEGER,
        summary TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_gad_observations_path ON gad_file_observations(path, created_at)`
    );
    this.sql.exec(`
      CREATE TABLE gad_file_mutations (
        mutation_id TEXT PRIMARY KEY,
        intended_event_id TEXT,
        applied_event_id TEXT,
        invocation_id TEXT,
        path TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        planned_params_json TEXT,
        before_hash TEXT,
        after_hash TEXT,
        input_state_hash TEXT,
        output_state_hash TEXT,
        state_transition_event_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX idx_gad_mutations_invocation ON gad_file_mutations(invocation_id)`);
    this.sql.exec(`
      CREATE TABLE gad_file_change_hunks (
        id INTEGER PRIMARY KEY,
        mutation_id TEXT NOT NULL,
        path TEXT NOT NULL,
        before_file_version_id INTEGER,
        after_file_version_id INTEGER,
        old_start_line INTEGER,
        old_line_count INTEGER,
        new_start_line INTEGER,
        new_line_count INTEGER,
        old_text_hash TEXT,
        new_text_hash TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_claims (
        claim_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        body_ref_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_claim_edges (
        edge_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        source_claim_id TEXT,
        target_id TEXT,
        relation TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_theories (
        theory_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        body_ref_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_theory_versions (
        version_id TEXT PRIMARY KEY,
        theory_id TEXT NOT NULL,
        trajectory_event_id TEXT NOT NULL,
        body_ref_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_contradictions (
        contradiction_id TEXT PRIMARY KEY,
        trajectory_event_id TEXT NOT NULL,
        invocation_id TEXT,
        body_ref_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ensureEmptyState();
  }

  rawSql(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    if (!readOnlySql(sql)) throw new Error("rawSql writes are disabled");
    return { rows: this.sql.exec(sql, ...bindings).toArray() as JsonRecord[] };
  }

  query(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    return this.rawSql(sql, bindings);
  }

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

  getTrajectoryBranchHead(input: { trajectoryId: string; branchId: string }): JsonRecord | null {
    this.ensureReady();
    return (
      (this.sql
        .exec(
          `SELECT * FROM trajectory_branches WHERE trajectory_id = ? AND branch_id = ?`,
          input.trajectoryId,
          input.branchId
        )
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  async appendTrajectoryBatch(
    input: AppendTrajectoryBatchInput
  ): Promise<AppendTrajectoryBatchResult> {
    this.ensureReady();
    if (!input.trajectoryId) throw new Error("appendTrajectoryBatch requires trajectoryId");
    if (!input.branchId) throw new Error("appendTrajectoryBatch requires branchId");
    if (input.events.length === 0)
      throw new Error("appendTrajectoryBatch requires at least one event");

    const replay = this.planTrajectoryAppendReplay(input);
    if (replay?.remaining.length === 0) return replay.result;

    const existingHead = this.getTrajectoryBranchHead({
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
    });
    const currentHeadHash = asString(existingHead?.["head_event_hash"]);
    if (
      !replay &&
      "expectedHeadEventHash" in input &&
      (input.expectedHeadEventHash ?? null) !== currentHeadHash
    ) {
      throw new Error("trajectory head conflict");
    }

    let prevEventHash = replay?.headEventHash ?? currentHeadHash ?? GENESIS_EVENT_HASH;
    let seq = this.nextTrajectorySeq(input.branchId);
    const prepared: Array<{ event: TrajectoryEvent; publish?: TrajectoryAppendItem["publish"] }> =
      [];
    const envelopes: Array<{
      eventId: string;
      channelId: string;
      envelopeId: string;
      envelope: ChannelEnvelope;
    }> = [];
    const now = nowIso();

    const prepareEvent = async (item: TrajectoryAppendItem): Promise<TrajectoryEvent> => {
      const parsed = agenticEventSchema.parse(item.event) as AgenticEvent;
      assertAgenticEventStoredValuesEncoded(parsed);
      const eventId = item.eventId ?? crypto.randomUUID();
      const eventHash = await computeEventHash({
        prevEventHash,
        branchId: input.branchId,
        seq,
        event: parsed,
      });
      const event = {
        ...parsed,
        eventId,
        trajectoryId: input.trajectoryId,
        branchId: input.branchId,
        seq,
        prevEventHash,
        eventHash,
      } as unknown as TrajectoryEvent;
      trajectoryEventSchema.parse(event);
      prepared.push({ event, publish: item.publish ?? null });
      prevEventHash = eventHash;
      seq += 1;
      return event;
    };

    for (const item of replay?.remaining ?? input.events) {
      const event = await prepareEvent(item);
      for (const channelId of item.publish?.channelIds ?? []) {
        const envelopeId = crypto.randomUUID();
        envelopes.push({
          eventId: event.eventId,
          channelId,
          envelopeId,
          envelope: {
            envelopeId: brandId<EnvelopeId>(envelopeId),
            channelId: brandId<ChannelId>(channelId),
            seq: -1,
            from: event.actor,
            to: item.publish?.audience as ChannelEnvelope["to"],
            payload: item.event,
            payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
            publishedAt: now,
          },
        });
      }
    }

    if (envelopes.length > 0) {
      await prepareEvent({
        event: {
          kind: "external.envelope_published",
          actor: input.owner,
          payload: {
            protocol: "agentic.trajectory.v1",
            publications: envelopes.map((publication) => ({
              channelId: brandId<ChannelId>(publication.channelId),
              envelopeId: brandId<EnvelopeId>(publication.envelopeId),
              payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
              eventId: brandId<EventId>(publication.eventId),
            })),
          },
          createdAt: nowIso(),
        },
      });
    }

    this.transaction(() => {
      const current = this.getTrajectoryBranchHead({
        trajectoryId: input.trajectoryId,
        branchId: input.branchId,
      });
      if (asString(current?.["head_event_hash"]) !== currentHeadHash) {
        throw new Error("trajectory head conflict");
      }

      this.sql.exec(
        `INSERT INTO trajectory_branches (
           trajectory_id, branch_id, owner_json, head_state_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(trajectory_id, branch_id) DO UPDATE SET
           owner_json = excluded.owner_json,
           updated_at = excluded.updated_at`,
        input.trajectoryId,
        input.branchId,
        JSON.stringify(input.owner),
        asString(existingHead?.["head_state_hash"]) ?? EMPTY_STATE_HASH,
        now,
        now
      );

      for (const item of prepared) {
        this.insertTrajectoryEvent(item.event);
        this.applyTrajectoryProjection(item.event);
      }

      for (const publication of envelopes) {
        const envelope = {
          ...publication.envelope,
          seq: this.nextChannelSeq(publication.channelId),
        };
        channelEnvelopeSchema.parse(envelope);
        this.insertChannelEnvelope(envelope);
        publication.envelope = envelope;
        this.insertChannelPublication({
          eventId: publication.eventId,
          trajectoryId: input.trajectoryId,
          branchId: input.branchId,
          channelId: publication.channelId,
          channelSeq: envelope.seq,
          envelopeId: publication.envelopeId,
          publishedAt: envelope.publishedAt,
        });
      }

      const last = prepared[prepared.length - 1]?.event;
      if (last) {
        this.sql.exec(
          `UPDATE trajectory_branches
           SET head_event_id = ?, head_event_hash = ?, updated_at = ?
           WHERE trajectory_id = ? AND branch_id = ?`,
          last.eventId,
          last.eventHash,
          now,
          input.trajectoryId,
          input.branchId
        );
      }
    });

    const finalHead = this.sql
      .exec(
        "SELECT head_state_hash FROM trajectory_branches WHERE trajectory_id = ? AND branch_id = ?",
        input.trajectoryId,
        input.branchId
      )
      .one() as Record<string, unknown> | null;

    return {
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
      headEventId:
        prepared[prepared.length - 1]?.event.eventId ??
        replay?.headEventId ??
        asString(existingHead?.["head_event_id"]),
      headEventHash:
        prepared[prepared.length - 1]?.event.eventHash ?? replay?.headEventHash ?? currentHeadHash,
      headStateHash:
        asString(finalHead?.["head_state_hash"]) ??
        asString(existingHead?.["head_state_hash"]) ??
        EMPTY_STATE_HASH,
      events: [...(replay?.events ?? []), ...prepared.map((item) => item.event)],
      published: [
        ...(replay?.published ?? []),
        ...envelopes.map((publication) => ({
          eventId: publication.eventId,
          channelId: publication.channelId,
          envelopeId: publication.envelopeId,
        })),
      ],
    };
  }

  listTrajectoryEvents(input: {
    trajectoryId?: string | null;
    branchId: string;
    cursor?: number | null;
    limit?: number | null;
  }): TrajectoryEvent[] {
    this.ensureReady();
    const cursor = input.cursor ?? -1;
    const limit = input.limit ?? 500;
    if (limit <= 0) {
      const rows = input.trajectoryId
        ? this.sql
            .exec(
              `SELECT * FROM trajectory_events
               WHERE trajectory_id = ? AND branch_id = ? AND seq > ?
               ORDER BY seq ASC`,
              input.trajectoryId,
              input.branchId,
              cursor
            )
            .toArray()
        : this.sql
            .exec(
              `SELECT * FROM trajectory_events WHERE branch_id = ? AND seq > ? ORDER BY seq ASC`,
              input.branchId,
              cursor
            )
            .toArray();
      return rows.map((row) => this.mapTrajectoryEvent(row as JsonRecord));
    }
    const rows = input.trajectoryId
      ? this.sql
          .exec(
            `SELECT * FROM trajectory_events
             WHERE trajectory_id = ? AND branch_id = ? AND seq > ?
             ORDER BY seq ASC LIMIT ?`,
            input.trajectoryId,
            input.branchId,
            cursor,
            limit
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT * FROM trajectory_events WHERE branch_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
            input.branchId,
            cursor,
            limit
          )
          .toArray();
    return rows.map((row) => this.mapTrajectoryEvent(row as JsonRecord));
  }

  getTrajectoryEvent(input: { eventId: string }): TrajectoryEvent | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM trajectory_events WHERE event_id = ? LIMIT 1`, input.eventId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapTrajectoryEvent(row) : null;
  }

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
    const rows: JsonRecord[] = [];
    if (input.eventId || input.digest || !input.envelopeId) {
      const clauses: string[] = [];
      const bindings: SqlBinding[] = [];
      if (input.eventId) {
        clauses.push("event_id = ?");
        bindings.push(input.eventId);
      }
      if (input.digest) {
        clauses.push("digest = ?");
        bindings.push(input.digest);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      rows.push(
        ...(this.sql
          .exec(
            `SELECT 'trajectory' AS ref_scope, event_id AS owner_id, field_path, digest, purpose, preview_json, size, created_at
         FROM trajectory_blob_refs ${where}
         ORDER BY created_at ASC LIMIT ?`,
            ...bindings,
            limit
          )
          .toArray() as JsonRecord[])
      );
    }
    if (input.envelopeId || input.digest || !input.eventId) {
      const clauses: string[] = [];
      const bindings: SqlBinding[] = [];
      if (input.envelopeId) {
        clauses.push("envelope_id = ?");
        bindings.push(input.envelopeId);
      }
      if (input.digest) {
        clauses.push("digest = ?");
        bindings.push(input.digest);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      rows.push(
        ...(this.sql
          .exec(
            `SELECT 'channel' AS ref_scope, envelope_id AS owner_id, field_path, digest, purpose, preview_json, size, created_at
         FROM channel_blob_refs ${where}
         ORDER BY created_at ASC LIMIT ?`,
            ...bindings,
            limit
          )
          .toArray() as JsonRecord[])
      );
    }
    return { rows: rows.slice(0, limit) };
  }

  inspectStorageDiagnostics(input: { rowByteLimit?: number | null; limit?: number | null } = {}): {
    rows: JsonRecord[];
  } {
    this.ensureReady();
    const rowByteLimit = input.rowByteLimit ?? 512 * 1024;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
    const rows: JsonRecord[] = [];
    const collect = (scope: string, sql: string): void => {
      rows.push(
        ...(this.sql
          .exec(sql, rowByteLimit, limit)
          .toArray()
          .map((row) => ({
            scope,
            ...(row as JsonRecord),
          })) as JsonRecord[])
      );
    };
    collect(
      "trajectory_events",
      `SELECT event_id AS id, length(payload_ref_json) AS bytes FROM trajectory_events WHERE length(payload_ref_json) > ? ORDER BY bytes DESC LIMIT ?`
    );
    collect(
      "channel_envelopes",
      `SELECT envelope_id AS id, length(payload_ref_json) AS bytes FROM channel_envelopes WHERE length(payload_ref_json) > ? ORDER BY bytes DESC LIMIT ?`
    );
    collect(
      "trajectory_invocations",
      `SELECT invocation_id AS id, MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) AS bytes FROM trajectory_invocations WHERE MAX(COALESCE(length(request_ref_json), 0), COALESCE(length(result_ref_json), 0)) > ? ORDER BY bytes DESC LIMIT ?`
    );
    rows.push(
      ...(this.sql
        .exec(
          `SELECT 'missing_gad_blob_index' AS scope, refs.digest AS id, refs.size AS bytes
       FROM (
         SELECT digest, size FROM trajectory_blob_refs
         UNION
         SELECT digest, size FROM channel_blob_refs
       ) refs
       LEFT JOIN gad_blobs b ON b.hash = refs.digest
       WHERE b.hash IS NULL
       LIMIT ?`,
          limit
        )
        .toArray() as JsonRecord[])
    );
    return { rows: rows.slice(0, limit) };
  }

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
         SELECT digest FROM trajectory_blob_refs
         UNION
         SELECT digest FROM channel_blob_refs
         UNION
         SELECT content_hash AS digest FROM gad_file_observations WHERE content_hash IS NOT NULL
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

  appendChannelEnvelope(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): ChannelEnvelope {
    this.ensureReady();
    const existing = this.tryIdempotentChannelEnvelope(input);
    if (existing) return existing;
    const envelope = {
      ...input,
      envelopeId: brandId<EnvelopeId>(input.envelopeId ?? crypto.randomUUID()),
      seq: this.nextChannelSeq(String(input.channelId)),
      publishedAt: input.publishedAt ?? nowIso(),
    } as ChannelEnvelope;
    channelEnvelopeSchema.parse(envelope);
    if (envelope.payloadKind === AGENTIC_EVENT_PAYLOAD_KIND) {
      assertAgenticEventStoredValuesEncoded(envelope.payload as AgenticEvent);
    }
    this.insertChannelEnvelope(envelope);
    return envelope;
  }

  appendChannelEnvelopeWithRegistryMutation(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
      registryMutation: RegistryMutationInput;
    }
  ): ChannelEnvelope {
    this.ensureReady();
    this.ensureMessageTypesTable();
    const existing = this.tryIdempotentChannelEnvelope(input);
    if (existing) return existing;
    return this.transaction(() => {
      const { registryMutation, ...envelopeInput } = input;
      const envelope = {
        ...envelopeInput,
        envelopeId: brandId<EnvelopeId>(envelopeInput.envelopeId ?? crypto.randomUUID()),
        seq: this.nextChannelSeq(String(envelopeInput.channelId)),
        publishedAt: envelopeInput.publishedAt ?? nowIso(),
      } as ChannelEnvelope;
      channelEnvelopeSchema.parse(envelope);
      this.insertChannelEnvelope(envelope);
      this.applyRegistryMutation(String(envelopeInput.channelId), envelope.seq, registryMutation);
      return envelope;
    });
  }

  listMessageTypes(input: { channelId: string }): ChannelMessageTypeDefinition[] {
    this.ensureReady();
    this.ensureMessageTypesTable();
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

  getMessageType(input: {
    channelId: string;
    typeId: string;
  }): ChannelMessageTypeDefinition | null {
    this.ensureReady();
    this.ensureMessageTypesTable();
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

  forkChannelLog(input: ForkChannelLogInput): ForkChannelLogResult {
    this.ensureReady();
    if (!input.fromChannelId) throw new Error("forkChannelLog requires fromChannelId");
    if (!input.toChannelId) throw new Error("forkChannelLog requires toChannelId");
    if (input.fromChannelId === input.toChannelId)
      throw new Error("forkChannelLog requires distinct channels");

    const targetCount = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS cnt FROM channel_envelopes WHERE channel_id = ?`,
          input.toChannelId
        )
        .one()["cnt"]
    );
    if (targetCount > 0) return this.existingForkChannelLog(input);

    const sourceRows = this.channelForkSourceRows(input);
    const forkedAt = nowIso();
    const prepared = sourceRows.map((row) => {
      const source = this.mapChannelEnvelope(row);
      const fork = {
        ...source,
        envelopeId: brandId<EnvelopeId>(crypto.randomUUID()),
        channelId: brandId<ChannelId>(input.toChannelId),
      } as ChannelEnvelope;
      channelEnvelopeSchema.parse(fork);
      return { source, fork };
    });

    this.transaction(() => {
      for (const item of prepared) {
        this.insertChannelEnvelope(item.fork);
        this.sql.exec(
          `INSERT INTO channel_envelope_forks (
             from_channel_id, to_channel_id, source_envelope_id, fork_envelope_id,
             source_seq, fork_seq, forked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          input.fromChannelId,
          input.toChannelId,
          item.source.envelopeId,
          item.fork.envelopeId,
          item.source.seq,
          item.fork.seq,
          forkedAt
        );
      }
    });

    return {
      fromChannelId: input.fromChannelId,
      toChannelId: input.toChannelId,
      throughSeq: input.throughSeq ?? null,
      copied: prepared.length,
      firstSeq: prepared[0]?.fork.seq,
      lastSeq: prepared[prepared.length - 1]?.fork.seq,
      lineage: prepared.map((item) => ({
        sourceEnvelopeId: String(item.source.envelopeId),
        forkEnvelopeId: String(item.fork.envelopeId),
        sourceSeq: item.source.seq,
        forkSeq: item.fork.seq,
      })),
    };
  }

  async forkTrajectoryBranch(
    input: ForkTrajectoryBranchInput
  ): Promise<ForkTrajectoryBranchResult> {
    this.ensureReady();
    if (!input.fromTrajectoryId) throw new Error("forkTrajectoryBranch requires fromTrajectoryId");
    if (!input.fromBranchId) throw new Error("forkTrajectoryBranch requires fromBranchId");
    if (!input.toTrajectoryId) throw new Error("forkTrajectoryBranch requires toTrajectoryId");
    if (!input.toBranchId) throw new Error("forkTrajectoryBranch requires toBranchId");
    if (
      input.fromTrajectoryId === input.toTrajectoryId &&
      input.fromBranchId === input.toBranchId
    ) {
      throw new Error("forkTrajectoryBranch requires distinct source and target");
    }

    const targetCount = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS cnt FROM trajectory_events WHERE trajectory_id = ? AND branch_id = ?`,
          input.toTrajectoryId,
          input.toBranchId
        )
        .one()["cnt"]
    );
    if (targetCount > 0) return this.existingForkTrajectoryBranch(input);

    const { sourceRows } = this.trajectoryForkSourceRows(input);

    const sourceHead = this.getTrajectoryBranchHead({
      trajectoryId: input.fromTrajectoryId,
      branchId: input.fromBranchId,
    });
    const owner = input.owner ??
      (parseJson(asString(sourceHead?.["owner_json"])) as { kind: "agent"; id: string } | null) ?? {
        kind: "agent" as const,
        id: "unknown",
      };
    let prevEventHash = GENESIS_EVENT_HASH;
    const forkedAt = nowIso();
    const prepared: Array<{ source: TrajectoryEvent; fork: TrajectoryEvent }> = [];
    for (const row of sourceRows) {
      const source = this.mapTrajectoryEvent(row);
      const eventForHash = agenticEventSchema.parse({
        kind: source.kind,
        actor: source.actor,
        turnId: source.turnId,
        causality: source.causality,
        payload: source.payload,
        createdAt: source.createdAt,
      }) as AgenticEvent;
      const eventHash = await computeEventHash({
        prevEventHash,
        branchId: input.toBranchId,
        seq: source.seq,
        event: eventForHash,
      });
      const fork = {
        ...eventForHash,
        eventId: crypto.randomUUID(),
        trajectoryId: input.toTrajectoryId,
        branchId: input.toBranchId,
        seq: source.seq,
        prevEventHash,
        eventHash,
      } as unknown as TrajectoryEvent;
      trajectoryEventSchema.parse(fork);
      prepared.push({ source, fork });
      prevEventHash = eventHash;
    }

    this.transaction(() => {
      this.sql.exec(
        `INSERT INTO trajectory_branches (
           trajectory_id, branch_id, owner_json, head_state_hash, parent_branch_id,
           fork_event_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.toTrajectoryId,
        input.toBranchId,
        JSON.stringify(owner),
        EMPTY_STATE_HASH,
        input.fromBranchId,
        prepared[prepared.length - 1]?.source.eventId ?? null,
        forkedAt,
        forkedAt
      );

      for (const item of prepared) {
        this.insertTrajectoryEvent(item.fork);
        this.applyTrajectoryProjection(item.fork);
        this.sql.exec(
          `INSERT INTO trajectory_event_forks (
             from_trajectory_id, from_branch_id, to_trajectory_id, to_branch_id,
             source_event_id, fork_event_id, source_seq, fork_seq,
             source_event_hash, fork_event_hash, forked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.fromTrajectoryId,
          input.fromBranchId,
          input.toTrajectoryId,
          input.toBranchId,
          item.source.eventId,
          item.fork.eventId,
          item.source.seq,
          item.fork.seq,
          item.source.eventHash,
          item.fork.eventHash,
          forkedAt
        );
        if (input.throughPublishedChannelId && input.toPublishedChannelId) {
          const publicationRows = this.sql
            .exec(
              `SELECT
                 f.to_channel_id AS to_channel_id,
                 f.fork_envelope_id AS fork_envelope_id,
                 f.fork_seq AS fork_seq,
                 e.published_at AS fork_published_at
               FROM trajectory_channel_publications p
               JOIN channel_envelope_forks f
                 ON f.from_channel_id = p.channel_id
                AND f.source_envelope_id = p.envelope_id
                AND f.to_channel_id = ?
               JOIN channel_envelopes e ON e.envelope_id = f.fork_envelope_id
               WHERE p.event_id = ? AND p.channel_id = ?`,
              input.toPublishedChannelId,
              item.source.eventId,
              input.throughPublishedChannelId
            )
            .toArray() as JsonRecord[];
          for (const row of publicationRows) {
            const forkEnvelopeId = asString(row["fork_envelope_id"]);
            if (!forkEnvelopeId)
              throw new Error("forked channel envelope missing for trajectory publication");
            this.insertChannelPublication({
              eventId: item.fork.eventId,
              trajectoryId: input.toTrajectoryId,
              branchId: input.toBranchId,
              channelId: asString(row["to_channel_id"]) ?? input.toPublishedChannelId,
              channelSeq: asNumber(row["fork_seq"]),
              envelopeId: forkEnvelopeId,
              publishedAt: asString(row["fork_published_at"]) ?? forkedAt,
            });
          }
        }
      }

      const last = prepared[prepared.length - 1]?.fork;
      this.sql.exec(
        `UPDATE trajectory_branches
         SET head_event_id = ?, head_event_hash = ?, head_state_hash = ?, updated_at = ?
         WHERE trajectory_id = ? AND branch_id = ?`,
        last?.eventId ?? null,
        last?.eventHash ?? null,
        this.latestStateHash(input.toBranchId),
        forkedAt,
        input.toTrajectoryId,
        input.toBranchId
      );
    });

    const head = this.getTrajectoryBranchHead({
      trajectoryId: input.toTrajectoryId,
      branchId: input.toBranchId,
    });
    return {
      fromTrajectoryId: input.fromTrajectoryId,
      fromBranchId: input.fromBranchId,
      toTrajectoryId: input.toTrajectoryId,
      toBranchId: input.toBranchId,
      copied: prepared.length,
      headEventId: asString(head?.["head_event_id"]),
      headEventHash: asString(head?.["head_event_hash"]),
      headStateHash: asString(head?.["head_state_hash"]) ?? EMPTY_STATE_HASH,
      lineage: prepared.map((item) => ({
        sourceEventId: String(item.source.eventId),
        forkEventId: String(item.fork.eventId),
        sourceSeq: item.source.seq,
        forkSeq: item.fork.seq,
        sourceEventHash: item.source.eventHash,
        forkEventHash: item.fork.eventHash,
      })),
    };
  }

  getChannelEnvelope(input: { envelopeId: string }): ChannelEnvelope | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM channel_envelopes WHERE envelope_id = ? LIMIT 1`, input.envelopeId)
      .toArray()[0] as JsonRecord | undefined;
    return row ? this.mapChannelEnvelope(row) : null;
  }

  getChannelReplayWindow(input: {
    channelId: string;
    mode: "initial" | "after" | "before";
    sinceSeq?: number | null;
    beforeSeq?: number | null;
    limit?: number | null;
  }): ChannelReplayWindow {
    this.ensureReady();
    const limit = Math.min(Math.max(input.limit ?? 50, 0), 500);
    let rows: JsonRecord[];
    if (input.mode === "after") {
      rows = this.sql
        .exec(
          `SELECT * FROM channel_envelopes WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
          input.channelId,
          input.sinceSeq ?? 0,
          limit
        )
        .toArray() as JsonRecord[];
    } else if (input.mode === "before") {
      if (input.beforeSeq == null) throw new Error("beforeSeq required for before replay");
      rows = this.sql
        .exec(
          `SELECT * FROM channel_envelopes
           WHERE channel_id = ? AND seq < ?
           ORDER BY seq DESC LIMIT ?`,
          input.channelId,
          input.beforeSeq,
          limit
        )
        .toArray()
        .reverse() as JsonRecord[];
    } else {
      rows = this.sql
        .exec(
          `SELECT * FROM channel_envelopes
           WHERE channel_id = ?
           ORDER BY seq DESC LIMIT ?`,
          input.channelId,
          limit
        )
        .toArray()
        .reverse() as JsonRecord[];
    }
    const totalCount = asNumber(
      this.sql
        .exec(`SELECT COUNT(*) AS cnt FROM channel_envelopes WHERE channel_id = ?`, input.channelId)
        .one()["cnt"]
    );
    const firstEnvelopeSeq = this.sql
      .exec(
        `SELECT MIN(seq) AS min_seq FROM channel_envelopes WHERE channel_id = ?`,
        input.channelId
      )
      .toArray()[0]?.["min_seq"];
    const replayFromId = rows.length > 0 ? asNumber(rows[0]?.["seq"]) : undefined;
    const replayToId = rows.length > 0 ? asNumber(rows[rows.length - 1]?.["seq"]) : undefined;
    let hasMoreBefore: boolean | undefined;
    if (input.mode === "initial") {
      hasMoreBefore =
        replayFromId !== undefined &&
        this.sql
          .exec(
            `SELECT seq FROM channel_envelopes WHERE channel_id = ? AND seq < ? LIMIT 1`,
            input.channelId,
            replayFromId
          )
          .toArray().length > 0;
    } else if (input.mode === "before") {
      const anchor = replayFromId ?? input.beforeSeq ?? 0;
      hasMoreBefore =
        anchor > 0 &&
        this.sql
          .exec(
            `SELECT seq FROM channel_envelopes WHERE channel_id = ? AND seq < ? LIMIT 1`,
            input.channelId,
            anchor
          )
          .toArray().length > 0;
    }
    return {
      envelopes: rows.map((row) => this.mapChannelEnvelope(row)),
      totalCount,
      firstEnvelopeSeq: typeof firstEnvelopeSeq === "number" ? firstEnvelopeSeq : undefined,
      replayFromId,
      replayToId,
      ...(hasMoreBefore !== undefined ? { hasMoreBefore } : {}),
    };
  }

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

  getTrajectoryForEnvelope(input: { envelopeId: string }): EnvelopeLineage | null {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT
           p.event_id AS p_event_id,
           p.trajectory_id AS p_trajectory_id,
           p.branch_id AS p_branch_id,
           p.channel_id AS p_channel_id,
           p.channel_seq AS p_channel_seq,
           p.envelope_id AS p_envelope_id,
           p.published_at AS p_published_at,
           e.*,
           te.event_id AS te_event_id,
           te.branch_id AS te_branch_id,
           te.trajectory_id AS te_trajectory_id,
           te.turn_id AS te_turn_id,
           te.seq AS te_seq,
           te.kind AS te_kind,
           te.actor_json AS te_actor_json,
           te.causality_json AS te_causality_json,
           te.payload_ref_json AS te_payload_ref_json,
           te.created_at AS te_created_at,
           te.event_hash AS te_event_hash,
           te.prev_event_hash AS te_prev_event_hash
         FROM trajectory_channel_publications p
         JOIN channel_envelopes e ON e.envelope_id = p.envelope_id
         JOIN trajectory_events te ON te.event_id = p.event_id
         WHERE p.envelope_id = ?
         LIMIT 1`,
        input.envelopeId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return {
      publication: this.mapLineagePublication(row),
      envelope: this.mapChannelEnvelope(row),
      trajectoryEvent: this.mapLineageTrajectoryEvent(row),
    };
  }

  listPublishedEnvelopesForTrajectory(input: {
    trajectoryId?: string | null;
    branchId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    channelId?: string | null;
    limit?: number | null;
  }): EnvelopeLineage[] {
    this.ensureReady();
    const clauses: string[] = [];
    const bindings: SqlBinding[] = [];
    if (input.trajectoryId) {
      clauses.push("p.trajectory_id = ?");
      bindings.push(input.trajectoryId);
    }
    if (input.branchId) {
      clauses.push("p.branch_id = ?");
      bindings.push(input.branchId);
    }
    if (input.eventId) {
      clauses.push("p.event_id = ?");
      bindings.push(input.eventId);
    }
    if (input.turnId) {
      clauses.push("te.turn_id = ?");
      bindings.push(input.turnId);
    }
    if (input.channelId) {
      clauses.push("p.channel_id = ?");
      bindings.push(input.channelId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT
           p.event_id AS p_event_id,
           p.trajectory_id AS p_trajectory_id,
           p.branch_id AS p_branch_id,
           p.channel_id AS p_channel_id,
           p.channel_seq AS p_channel_seq,
           p.envelope_id AS p_envelope_id,
           p.published_at AS p_published_at,
           e.*,
           te.event_id AS te_event_id,
           te.branch_id AS te_branch_id,
           te.trajectory_id AS te_trajectory_id,
           te.turn_id AS te_turn_id,
           te.seq AS te_seq,
           te.kind AS te_kind,
           te.actor_json AS te_actor_json,
           te.causality_json AS te_causality_json,
           te.payload_ref_json AS te_payload_ref_json,
           te.created_at AS te_created_at,
           te.event_hash AS te_event_hash,
           te.prev_event_hash AS te_prev_event_hash
         FROM trajectory_channel_publications p
         JOIN channel_envelopes e ON e.envelope_id = p.envelope_id
         JOIN trajectory_events te ON te.event_id = p.event_id
         ${where}
         ORDER BY p.channel_id ASC, p.channel_seq ASC
         LIMIT ?`,
        ...bindings,
        limit
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => ({
      publication: this.mapLineagePublication(row),
      envelope: this.mapChannelEnvelope(row),
      trajectoryEvent: this.mapLineageTrajectoryEvent(row),
    }));
  }

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

  getPrivateLineageForPublishedEnvelope(input: {
    envelopeId: string;
  }): PrivateLineageForPublishedEnvelope | null {
    const lineage = this.getTrajectoryForEnvelope(input);
    if (!lineage) return null;
    const rows = this.sql
      .exec(
        `SELECT * FROM trajectory_events
         WHERE branch_id = ? AND seq <= ?
         ORDER BY seq ASC`,
        lineage.trajectoryEvent.branchId,
        lineage.trajectoryEvent.seq
      )
      .toArray() as JsonRecord[];
    return {
      lineage,
      branchEvents: rows.map((row) => this.mapTrajectoryEvent(row)),
    };
  }

  getDownstreamConsumers(input: { envelopeId: string; limit?: number | null }): TrajectoryEvent[] {
    this.ensureReady();
    const needle = input.envelopeId;
    const rows = this.sql
      .exec(
        `SELECT * FROM trajectory_events
         WHERE kind != 'external.envelope_published'
           AND (causality_json LIKE ? OR payload_ref_json LIKE ?)
         ORDER BY created_at ASC, branch_id ASC, seq ASC
         LIMIT ?`,
        `%${needle}%`,
        `%${needle}%`,
        Math.min(Math.max(input.limit ?? 500, 1), 1000)
      )
      .toArray() as JsonRecord[];
    return rows.map((row) => this.mapTrajectoryEvent(row));
  }

  listChannelEnvelopes(input: {
    channelId: string;
    cursor?: number | null;
    limit?: number | null;
    payloadKind?: string | null;
  }): ChannelEnvelope[] {
    this.ensureReady();
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 500;
    const rows = input.payloadKind
      ? this.sql
          .exec(
            `SELECT * FROM channel_envelopes
             WHERE channel_id = ? AND seq > ? AND payload_kind = ?
             ORDER BY seq ASC LIMIT ?`,
            input.channelId,
            cursor,
            input.payloadKind,
            limit
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT * FROM channel_envelopes WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
            input.channelId,
            cursor,
            limit
          )
          .toArray();
    return rows.map((row) => this.mapChannelEnvelope(row as JsonRecord));
  }

  listGadBranchFiles(input: { branchId: string }): JsonRecord[] {
    const head = this.sql
      .exec(
        `SELECT head_state_hash FROM trajectory_branches WHERE branch_id = ? ORDER BY updated_at DESC LIMIT 1`,
        input.branchId
      )
      .toArray()[0] as JsonRecord | undefined;
    return this.filesForState(asString(head?.["head_state_hash"]) ?? EMPTY_STATE_HASH);
  }

  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): {
    added: JsonRecord[];
    removed: JsonRecord[];
    changed: JsonRecord[];
  } {
    const left = new Map(
      this.filesForState(input.leftStateHash).map((file) => [String(file["path"]), file])
    );
    const right = new Map(
      this.filesForState(input.rightStateHash).map((file) => [String(file["path"]), file])
    );
    const added: JsonRecord[] = [];
    const removed: JsonRecord[] = [];
    const changed: JsonRecord[] = [];
    for (const [path, file] of right) {
      const before = left.get(path);
      if (!before) added.push(file);
      else if (before["content_hash"] !== file["content_hash"] || before["mode"] !== file["mode"]) {
        changed.push({ path, before, after: file });
      }
    }
    for (const [path, file] of left) {
      if (!right.has(path)) removed.push(file);
    }
    return { added, removed, changed };
  }

  readGadFileAtState(input: { stateHash: string; path: string }): JsonRecord | null {
    const path = normalizePath(input.path);
    return this.filesForState(input.stateHash).find((file) => file["path"] === path) ?? null;
  }

  getGadStateProducer(input: { stateHash: string }): JsonRecord | null {
    return (
      (this.sql
        .exec(
          `SELECT * FROM gad_state_transitions WHERE output_state_hash = ? ORDER BY created_at DESC LIMIT 1`,
          input.stateHash
        )
        .toArray()[0] as JsonRecord | undefined) ?? null
    );
  }

  blameGadFileSnippet(input: {
    stateHash?: string | null;
    fileVersionId?: number | null;
    path: string;
  }): JsonRecord[] {
    const path = normalizePath(input.path);
    const fileVersionId =
      input.fileVersionId ??
      this.readGadFileAtState({
        stateHash: input.stateHash ?? EMPTY_STATE_HASH,
        path,
      })?.["file_version_id"];
    if (fileVersionId == null) return [];
    return this.sql
      .exec(
        `SELECT * FROM gad_file_change_hunks
         WHERE path = ? AND after_file_version_id = ?
         ORDER BY id ASC`,
        path,
        fileVersionId as SqlBinding
      )
      .toArray() as JsonRecord[];
  }

  getStatus(): { metric: string; value: number }[] {
    const count = (table: string) =>
      asNumber(this.sql.exec(`SELECT COUNT(*) AS value FROM ${table}`).one()["value"]);
    return [
      { metric: "Trajectory events", value: count("trajectory_events") },
      { metric: "Trajectory branches", value: count("trajectory_branches") },
      { metric: "Channel envelopes", value: count("channel_envelopes") },
      { metric: "Worktree states", value: count("gad_worktree_states") },
      { metric: "File mutations", value: count("gad_file_mutations") },
      { metric: "Claims", value: count("gad_claims") },
    ];
  }

  async validateGadHashes(): Promise<{ ok: boolean; errors: string[] }> {
    const integrity = await this.checkGadIntegrity();
    return {
      ok: integrity.ok,
      errors: integrity.errors.map(
        (error) => `${String(error["type"])}: ${String(error["message"])}`
      ),
    };
  }

  clearDirtyAfterValidation(): Promise<{ ok: boolean; errors: string[] }> {
    return this.validateGadHashes();
  }

  async checkGadIntegrity(): Promise<{ ok: boolean; errors: JsonRecord[] }> {
    const errors: JsonRecord[] = [];
    const addError = (type: string, message: string, details: JsonRecord = {}) =>
      errors.push({ type, message, ...details });

    const trajectoryEvents = this.listTrajectoryEvents({ branchId: "__all__", limit: 0 });
    const allTrajectoryRows = this.sql
      .exec(`SELECT * FROM trajectory_events ORDER BY branch_id, seq ASC`)
      .toArray() as JsonRecord[];
    const hashCheck = await checkTrajectoryIntegrity(
      allTrajectoryRows.map((row) => this.mapTrajectoryEvent(row))
    );
    for (const error of hashCheck.errors) addError("trajectory-event", error);
    void trajectoryEvents;

    for (const state of this.sql
      .exec(`SELECT state_hash, manifest_root_hash FROM gad_worktree_states`)
      .toArray() as JsonRecord[]) {
      const rootHash = asString(state["manifest_root_hash"]) ?? "";
      const expectedStateHash = this.stateHashForRoot(rootHash);
      if (expectedStateHash !== state["state_hash"]) {
        addError("worktree-state", "worktree state hash mismatch", {
          stateHash: state["state_hash"] as JsonValue,
          expectedStateHash,
        });
      }
      const expectedRootHash = this.recomputeManifestHash(rootHash);
      if (expectedRootHash == null) {
        addError("manifest", "worktree state references a missing manifest root", {
          stateHash: state["state_hash"] as JsonValue,
          manifestRootHash: rootHash,
        });
      } else if (expectedRootHash !== rootHash) {
        addError("manifest", "manifest hash mismatch", {
          manifestRootHash: rootHash,
          expectedRootHash,
        });
      }
    }

    for (const transition of this.sql
      .exec(`SELECT * FROM gad_state_transitions`)
      .toArray() as JsonRecord[]) {
      if (!this.stateExists(String(transition["input_state_hash"]))) {
        addError("state-transition", "transition input state is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
      }
      if (!this.stateExists(String(transition["output_state_hash"]))) {
        addError("state-transition", "transition output state is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
      }
      if (!this.trajectoryEventExists(String(transition["event_id"]))) {
        addError("state-transition", "transition event is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
      }
    }

    return { ok: errors.length === 0, errors };
  }

  async replayTrajectoryProjections(): Promise<{ replayed: number }> {
    const rows = this.sql
      .exec(`SELECT * FROM trajectory_events ORDER BY branch_id, seq ASC`)
      .toArray() as JsonRecord[];
    this.clearTrajectoryProjections();
    let replayed = 0;
    for (const row of rows) {
      this.applyTrajectoryProjection(this.mapTrajectoryEvent(row));
      replayed += 1;
    }
    return { replayed };
  }

  rebuildTrajectoryProjections(): Promise<{ replayed: number }> {
    return this.replayTrajectoryProjections();
  }

  private insertTrajectoryEvent(event: TrajectoryEvent): void {
    this.sql.exec(
      `INSERT INTO trajectory_events (
         event_id, branch_id, trajectory_id, turn_id, seq, kind, actor_json,
         causality_json, payload_ref_json, created_at, event_hash, prev_event_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.branchId,
      event.trajectoryId,
      event.turnId ?? null,
      event.seq,
      event.kind,
      JSON.stringify(event.actor),
      json(event.causality),
      JSON.stringify(event.payload),
      event.createdAt,
      event.eventHash,
      event.prevEventHash
    );
    this.insertTrajectoryBlobRefs(event.eventId, event.payload, "payload");
  }

  private insertTrajectoryBlobRefs(eventId: string, value: unknown, purpose: string): void {
    for (const { path, ref } of collectStoredValueRefs(value)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO trajectory_blob_refs (
           event_id, field_path, digest, purpose, preview_json, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        eventId,
        path,
        ref.digest,
        purpose,
        ref.preview !== undefined ? JSON.stringify(ref.preview) : null,
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

  private applyTrajectoryProjection(event: TrajectoryEvent): void {
    if (event.kind === "turn.opened" && event.turnId) {
      this.sql.exec(
        `INSERT INTO trajectory_turns (turn_id, branch_id, opened_at, summary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(branch_id, turn_id) DO UPDATE SET opened_at = excluded.opened_at`,
        event.turnId,
        event.branchId,
        event.createdAt,
        asString((event.payload as JsonRecord)["summary"])
      );
      return;
    }
    if (event.kind === "turn.closed" && event.turnId) {
      this.sql.exec(
        `INSERT INTO trajectory_turns (turn_id, branch_id, closed_at, summary)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(branch_id, turn_id) DO UPDATE SET
           closed_at = excluded.closed_at,
           summary = COALESCE(excluded.summary, trajectory_turns.summary)`,
        event.turnId,
        event.branchId,
        event.createdAt,
        asString((event.payload as JsonRecord)["summary"])
      );
      return;
    }
    if (event.kind.startsWith("message.")) {
      this.projectMessage(event);
      return;
    }
    if (event.kind.startsWith("invocation.")) {
      this.projectInvocation(event);
      return;
    }
    if (event.kind.startsWith("approval.")) {
      this.projectApproval(event);
      return;
    }
    if (event.kind === "state.file_observed") {
      this.projectFileObserved(event);
      return;
    }
    if (event.kind === "state.file_mutation_intended") {
      this.projectFileMutationIntended(event);
      return;
    }
    if (event.kind === "state.file_mutation_applied") {
      this.projectFileMutationApplied(event);
      return;
    }
    if (event.kind.startsWith("knowledge.")) {
      this.projectKnowledge(event);
    }
  }

  private projectMessage(event: TrajectoryEvent): void {
    const messageId = event.causality?.messageId;
    if (!messageId) return;
    const payload = event.payload as JsonRecord;
    const existing = this.sql
      .exec(
        `SELECT body_assembled, role FROM trajectory_messages WHERE branch_id = ? AND message_id = ?`,
        event.branchId,
        messageId
      )
      .toArray()[0] as JsonRecord | undefined;
    const existingBody = asString(existing?.["body_assembled"]) ?? "";
    const body =
      event.kind === "message.delta"
        ? existingBody + (asString(payload["delta"]) ?? "")
        : (asString(payload["content"]) ?? existingBody);
    const status =
      event.kind === "message.completed"
        ? "completed"
        : event.kind === "message.failed"
          ? "failed"
          : event.kind === "message.delta"
            ? "streaming"
            : "started";
    this.sql.exec(
      `INSERT INTO trajectory_messages (
         message_id, branch_id, role, body_assembled, status, started_event_id, completed_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, message_id) DO UPDATE SET
         role = COALESCE(excluded.role, trajectory_messages.role),
         body_assembled = excluded.body_assembled,
         status = excluded.status,
         started_event_id = COALESCE(trajectory_messages.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_messages.completed_event_id),
         updated_at = excluded.updated_at`,
      messageId,
      event.branchId,
      asString(payload["role"]) ?? asString(existing?.["role"]) ?? event.actor.kind,
      body,
      status,
      event.kind === "message.started" ? event.eventId : null,
      event.kind === "message.completed" || event.kind === "message.failed" ? event.eventId : null,
      nowIso()
    );

    const blocks = Array.isArray(payload["blocks"]) ? payload["blocks"] : [];
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return;
      const record = block as JsonRecord;
      const blockId = asString(record["blockId"]) ?? `${messageId}:block:${index}`;
      this.sql.exec(
        `INSERT OR REPLACE INTO trajectory_message_blocks (
           block_id, message_id, branch_id, block_index, block_type, body_ref_json, invocation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        blockId,
        messageId,
        event.branchId,
        index,
        asString(record["type"]) ?? "data",
        JSON.stringify(record),
        asString(record["invocationId"])
      );
    });
  }

  private projectInvocation(event: TrajectoryEvent): void {
    const invocationId = event.causality?.invocationId;
    if (!invocationId) return;
    const terminalKinds = new Set([
      "invocation.completed",
      "invocation.failed",
      "invocation.cancelled",
      "invocation.abandoned",
    ]);
    const existing = this.sql
      .exec(
        `SELECT status FROM trajectory_invocations WHERE branch_id = ? AND invocation_id = ?`,
        event.branchId,
        invocationId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (
      terminalKinds.has(event.kind) &&
      existing &&
      terminalKinds.has(`invocation.${String(existing["status"])}`)
    ) {
      throw new Error(`duplicate terminal invocation event for ${invocationId}`);
    }
    const payload = event.payload as JsonRecord;
    if (event.kind === "invocation.output" || event.kind === "invocation.progress") {
      this.sql.exec(
        `INSERT INTO trajectory_invocation_outputs (invocation_id, branch_id, seq, chunk_ref_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        invocationId,
        event.branchId,
        event.seq,
        JSON.stringify(payload),
        event.createdAt
      );
    }
    this.sql.exec(
      `INSERT INTO trajectory_invocations (
         invocation_id, branch_id, transport_call_id, kind, status, request_ref_json, result_ref_json,
         started_event_id, completed_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, invocation_id) DO UPDATE SET
         transport_call_id = COALESCE(excluded.transport_call_id, trajectory_invocations.transport_call_id),
         kind = COALESCE(excluded.kind, trajectory_invocations.kind),
         status = excluded.status,
         request_ref_json = COALESCE(excluded.request_ref_json, trajectory_invocations.request_ref_json),
         result_ref_json = COALESCE(excluded.result_ref_json, trajectory_invocations.result_ref_json),
         started_event_id = COALESCE(trajectory_invocations.started_event_id, excluded.started_event_id),
         completed_event_id = COALESCE(excluded.completed_event_id, trajectory_invocations.completed_event_id),
         updated_at = excluded.updated_at`,
      invocationId,
      event.branchId,
      event.causality?.transportCallId ?? null,
      asString(payload["name"]),
      event.kind.replace("invocation.", ""),
      event.kind === "invocation.started" ? json(payload["request"]) : null,
      event.kind === "invocation.completed" ? json(payload["result"]) : null,
      event.kind === "invocation.started" ? event.eventId : null,
      terminalKinds.has(event.kind) ? event.eventId : null,
      nowIso()
    );
  }

  private projectApproval(event: TrajectoryEvent): void {
    const approvalId = event.causality?.approvalId;
    if (!approvalId) return;
    const payload = event.payload as JsonRecord;
    const status =
      event.kind === "approval.resolved"
        ? payload["granted"] === true
          ? "granted"
          : "denied"
        : "requested";
    this.sql.exec(
      `INSERT INTO trajectory_approvals (
         approval_id, branch_id, invocation_id, status, requested_by_json, resolved_by_json,
         requested_event_id, resolved_event_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, approval_id) DO UPDATE SET
         status = excluded.status,
         resolved_by_json = COALESCE(excluded.resolved_by_json, trajectory_approvals.resolved_by_json),
         resolved_event_id = COALESCE(excluded.resolved_event_id, trajectory_approvals.resolved_event_id),
         updated_at = excluded.updated_at`,
      approvalId,
      event.branchId,
      event.causality?.invocationId ?? null,
      status,
      event.kind === "approval.requested" ? JSON.stringify(event.actor) : null,
      event.kind === "approval.resolved" ? json(payload["resolvedBy"]) : null,
      event.kind === "approval.requested" ? event.eventId : null,
      event.kind === "approval.resolved" ? event.eventId : null,
      nowIso()
    );
  }

  private projectFileObserved(event: TrajectoryEvent): void {
    const payload = event.payload as JsonRecord;
    const pathValue = asString(payload["path"]);
    if (!pathValue) return;
    const path = normalizePath(pathValue);
    const stateHash = asString(payload["stateHash"]) ?? this.latestStateHash(event.branchId);
    const contentHash = asString(payload["contentHash"]);
    const versionId = contentHash ? this.ensureFileVersion(path, contentHash, 33188) : null;
    this.sql.exec(
      `INSERT OR REPLACE INTO gad_file_observations (
         observation_id, event_id, invocation_id, path, observed_state_hash, file_version_id,
         content_hash, size, mime_type, summary, error_message, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asString(payload["observationId"]) ?? event.eventId,
      event.eventId,
      event.causality?.invocationId ?? asString(payload["invocationId"]),
      path,
      stateHash,
      versionId,
      contentHash,
      typeof payload["size"] === "number" ? payload["size"] : null,
      asString(payload["mimeType"]),
      asString(payload["summary"]),
      asString(payload["error"]),
      event.createdAt
    );
  }

  private projectFileMutationIntended(event: TrajectoryEvent): void {
    const payload = event.payload as JsonRecord;
    const pathValue =
      asString(payload["path"]) ??
      (Array.isArray(payload["paths"]) ? asString(payload["paths"][0]) : null);
    if (!pathValue) return;
    const mutationId = asString(payload["mutationId"]) ?? event.eventId;
    const now = nowIso();
    this.sql.exec(
      `INSERT INTO gad_file_mutations (
         mutation_id, intended_event_id, invocation_id, path, operation, status,
         planned_params_json, input_state_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mutation_id) DO UPDATE SET
         intended_event_id = excluded.intended_event_id,
         planned_params_json = excluded.planned_params_json,
         updated_at = excluded.updated_at`,
      mutationId,
      event.eventId,
      event.causality?.invocationId ?? asString(payload["invocationId"]),
      normalizePath(pathValue),
      asString(payload["operation"]) ?? "write",
      "intended",
      JSON.stringify(payload),
      asString(payload["inputStateHash"]) ?? this.latestStateHash(event.branchId),
      now,
      now
    );
  }

  private projectFileMutationApplied(event: TrajectoryEvent): void {
    const payload = event.payload as JsonRecord;
    const pathValue =
      asString(payload["path"]) ??
      (Array.isArray(payload["paths"]) ? asString(payload["paths"][0]) : null);
    if (!pathValue) return;
    const path = normalizePath(pathValue);
    const mutationId = asString(payload["mutationId"]) ?? event.eventId;
    const inputStateHash =
      asString(payload["inputStateHash"]) ?? this.latestStateHash(event.branchId);
    const afterHash = asString(payload["afterHash"]) ?? asString(payload["contentHash"]);
    if (!afterHash)
      throw new Error("state.file_mutation_applied requires payload.afterHash or contentHash");
    const beforeFile = this.readGadFileAtState({ stateHash: inputStateHash, path });
    const beforeFileVersionId =
      typeof beforeFile?.["file_version_id"] === "number" ? beforeFile["file_version_id"] : null;
    const afterFileVersionId = this.ensureFileVersion(path, afterHash, 33188);
    const files = this.filesForState(inputStateHash)
      .filter((file) => file["path"] !== path)
      .map((file) => ({
        path: String(file["path"]),
        fileVersionId: Number(file["file_version_id"]),
        contentHash: String(file["content_hash"]),
        mode: Number(file["mode"]),
      }));
    files.push({ path, fileVersionId: afterFileVersionId, contentHash: afterHash, mode: 33188 });
    const outputStateHash =
      asString(payload["outputStateHash"]) ??
      this.createWorktreeState(files, {
        eventId: event.eventId,
        invocationId: event.causality?.invocationId,
      });
    const now = nowIso();
    this.sql.exec(
      `INSERT INTO gad_state_transitions (
         event_id, invocation_id, input_state_hash, output_state_hash,
         produced_by_mutation_id, summary, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.causality?.invocationId ?? asString(payload["invocationId"]),
      inputStateHash,
      outputStateHash,
      mutationId,
      asString(payload["rationale"]),
      JSON.stringify(payload),
      event.createdAt
    );
    this.sql.exec(
      `INSERT INTO gad_file_mutations (
         mutation_id, applied_event_id, invocation_id, path, operation, status,
         before_hash, after_hash, input_state_hash, output_state_hash,
         state_transition_event_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mutation_id) DO UPDATE SET
         applied_event_id = excluded.applied_event_id,
         invocation_id = COALESCE(excluded.invocation_id, gad_file_mutations.invocation_id),
         status = excluded.status,
         before_hash = excluded.before_hash,
         after_hash = excluded.after_hash,
         input_state_hash = excluded.input_state_hash,
         output_state_hash = excluded.output_state_hash,
         state_transition_event_id = excluded.state_transition_event_id,
         updated_at = excluded.updated_at`,
      mutationId,
      event.eventId,
      event.causality?.invocationId ?? asString(payload["invocationId"]),
      path,
      asString(payload["operation"]) ?? "write",
      asString(payload["status"]) ?? "applied",
      asString(beforeFile?.["content_hash"]),
      afterHash,
      inputStateHash,
      outputStateHash,
      event.eventId,
      now,
      now
    );
    const hunks = Array.isArray(payload["hunks"]) ? payload["hunks"] : [];
    for (const hunk of hunks) {
      if (!hunk || typeof hunk !== "object" || Array.isArray(hunk)) continue;
      const record = hunk as JsonRecord;
      this.sql.exec(
        `INSERT INTO gad_file_change_hunks (
           mutation_id, path, before_file_version_id, after_file_version_id,
           old_start_line, old_line_count, new_start_line, new_line_count,
           old_text_hash, new_text_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mutationId,
        path,
        beforeFileVersionId,
        afterFileVersionId,
        typeof record["oldStartLine"] === "number" ? record["oldStartLine"] : null,
        typeof record["oldLineCount"] === "number" ? record["oldLineCount"] : null,
        typeof record["newStartLine"] === "number" ? record["newStartLine"] : null,
        typeof record["newLineCount"] === "number" ? record["newLineCount"] : null,
        asString(record["oldTextHash"]),
        asString(record["newTextHash"])
      );
    }
    this.sql.exec(
      `UPDATE trajectory_branches
       SET head_state_hash = ?, updated_at = ?
       WHERE trajectory_id = ? AND branch_id = ?`,
      outputStateHash,
      now,
      event.trajectoryId,
      event.branchId
    );
  }

  private projectKnowledge(event: TrajectoryEvent): void {
    const payload = event.payload as JsonRecord;
    if (event.kind.startsWith("knowledge.claim_")) {
      const claimId = asString(payload["claimId"]) ?? asString(payload["id"]) ?? event.eventId;
      if (event.kind === "knowledge.claim_retracted") {
        this.sql.exec(
          `UPDATE gad_claims SET status = 'retracted', trajectory_event_id = ?, updated_at = ? WHERE claim_id = ?`,
          event.eventId,
          event.createdAt,
          claimId
        );
        return;
      }
      this.sql.exec(
        `INSERT INTO gad_claims (
           claim_id, trajectory_event_id, invocation_id, subject, predicate, object,
           body_ref_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(claim_id) DO UPDATE SET
           trajectory_event_id = excluded.trajectory_event_id,
           subject = COALESCE(excluded.subject, gad_claims.subject),
           predicate = COALESCE(excluded.predicate, gad_claims.predicate),
           object = COALESCE(excluded.object, gad_claims.object),
           body_ref_json = excluded.body_ref_json,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        claimId,
        event.eventId,
        event.causality?.invocationId ?? null,
        asString(payload["subject"]),
        asString(payload["predicate"]),
        asString(payload["object"]),
        JSON.stringify(payload),
        asString(payload["status"]) ?? "active",
        event.createdAt,
        event.createdAt
      );
    }
  }

  private nextTrajectorySeq(branchId: string): number {
    return asNumber(
      this.sql
        .exec(
          `SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM trajectory_events WHERE branch_id = ?`,
          branchId
        )
        .one()["seq"]
    );
  }

  private nextChannelSeq(channelId: string): number {
    return asNumber(
      this.sql
        .exec(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM channel_envelopes WHERE channel_id = ?`,
          channelId
        )
        .one()["seq"]
    );
  }

  private insertChannelEnvelope(envelope: ChannelEnvelope): void {
    this.sql.exec(
      `INSERT INTO channel_envelopes (
         envelope_id, channel_id, seq, from_json, to_json, payload_ref_json, payload_kind,
         metadata_json, attachments_json, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      envelope.envelopeId,
      envelope.channelId,
      envelope.seq,
      JSON.stringify(envelope.from),
      envelope.to ? JSON.stringify(envelope.to) : null,
      JSON.stringify(envelope.payload),
      envelope.payloadKind ?? null,
      envelope.metadata ? JSON.stringify(envelope.metadata) : null,
      envelope.attachments ? JSON.stringify(envelope.attachments) : null,
      envelope.publishedAt
    );
    this.insertChannelBlobRefs(String(envelope.envelopeId), envelope.payload, "payload");
  }

  private insertChannelBlobRefs(envelopeId: string, value: unknown, purpose: string): void {
    for (const { path, ref } of collectStoredValueRefs(value)) {
      this.sql.exec(
        `INSERT OR REPLACE INTO channel_blob_refs (
           envelope_id, field_path, digest, purpose, preview_json, size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        envelopeId,
        path,
        ref.digest,
        purpose,
        ref.preview !== undefined ? JSON.stringify(ref.preview) : null,
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

  private applyRegistryMutation(
    channelId: string,
    seq: number,
    mutation: RegistryMutationInput
  ): void {
    this.ensureMessageTypesTable();
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
        mutation.row.schemaSourceOrPath !== undefined
          ? JSON.stringify(mutation.row.schemaSourceOrPath)
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
    if (row["schema_json"]) result.schemaSourceOrPath = parseJson(asString(row["schema_json"]));
    if (row["registered_by_json"])
      result.registeredBy = parseRecord(asString(row["registered_by_json"]));
    if (row["cleared_at_seq"] !== null && row["cleared_at_seq"] !== undefined) {
      result.clearedAtSeq = asNumber(row["cleared_at_seq"]);
    }
    return result;
  }

  private ensureMessageTypesTable(): void {
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
  }

  private insertChannelPublication(publication: ChannelPublication): void {
    this.sql.exec(
      `INSERT INTO trajectory_channel_publications (
         event_id, trajectory_id, branch_id, channel_id, channel_seq, envelope_id, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      publication.eventId,
      publication.trajectoryId,
      publication.branchId,
      publication.channelId,
      publication.channelSeq,
      publication.envelopeId,
      publication.publishedAt
    );
  }

  private mapChannelPublication(row: JsonRecord): ChannelPublication {
    return {
      eventId: String(row["event_id"]),
      trajectoryId: String(row["trajectory_id"]),
      branchId: String(row["branch_id"]),
      channelId: String(row["channel_id"]),
      channelSeq: asNumber(row["channel_seq"]),
      envelopeId: String(row["envelope_id"]),
      publishedAt: String(row["published_at"]),
    };
  }

  private mapLineagePublication(row: JsonRecord): ChannelPublication {
    return this.mapChannelPublication({
      event_id: row["p_event_id"] ?? null,
      trajectory_id: row["p_trajectory_id"] ?? null,
      branch_id: row["p_branch_id"] ?? null,
      channel_id: row["p_channel_id"] ?? null,
      channel_seq: row["p_channel_seq"] ?? null,
      envelope_id: row["p_envelope_id"] ?? null,
      published_at: row["p_published_at"] ?? null,
    });
  }

  private mapLineageTrajectoryEvent(row: JsonRecord): TrajectoryEvent {
    return this.mapTrajectoryEvent({
      event_id: row["te_event_id"] ?? null,
      branch_id: row["te_branch_id"] ?? null,
      trajectory_id: row["te_trajectory_id"] ?? null,
      turn_id: row["te_turn_id"] ?? null,
      seq: row["te_seq"] ?? null,
      kind: row["te_kind"] ?? null,
      actor_json: row["te_actor_json"] ?? null,
      causality_json: row["te_causality_json"] ?? null,
      payload_ref_json: row["te_payload_ref_json"] ?? null,
      created_at: row["te_created_at"] ?? null,
      event_hash: row["te_event_hash"] ?? null,
      prev_event_hash: row["te_prev_event_hash"] ?? null,
    });
  }

  private mapTrajectoryEvent(row: JsonRecord): TrajectoryEvent {
    return {
      eventId: String(row["event_id"]),
      trajectoryId: String(row["trajectory_id"]),
      branchId: String(row["branch_id"]),
      seq: asNumber(row["seq"]),
      prevEventHash: String(row["prev_event_hash"]),
      eventHash: String(row["event_hash"]),
      kind: String(row["kind"]),
      actor: parseRecord(asString(row["actor_json"])),
      ...(row["turn_id"] ? { turnId: String(row["turn_id"]) } : {}),
      ...(row["causality_json"] ? { causality: parseRecord(asString(row["causality_json"])) } : {}),
      payload: parseRecord(asString(row["payload_ref_json"])),
      createdAt: String(row["created_at"]),
    } as unknown as TrajectoryEvent;
  }

  private tryIdempotentChannelEnvelope(
    input: Omit<ChannelEnvelope, "seq" | "envelopeId" | "publishedAt"> & {
      envelopeId?: string | null;
      publishedAt?: string | null;
    }
  ): ChannelEnvelope | null {
    if (!input.envelopeId) return null;
    const row = this.sql
      .exec(`SELECT * FROM channel_envelopes WHERE envelope_id = ? LIMIT 1`, input.envelopeId)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    const existing = this.mapChannelEnvelope(row);
    const candidate = {
      ...input,
      envelopeId: existing.envelopeId,
      seq: existing.seq,
      publishedAt: input.publishedAt ?? existing.publishedAt,
    } as ChannelEnvelope;
    if (!sameChannelEnvelope(existing, candidate)) {
      throw new Error(
        `GAD channel envelope id collision with different content: ${input.envelopeId}`
      );
    }
    return existing;
  }

  private planTrajectoryAppendReplay(input: AppendTrajectoryBatchInput): {
    events: TrajectoryEvent[];
    published: Array<{ eventId: string; channelId: string; envelopeId: string }>;
    headEventId?: string;
    headEventHash?: string;
    remaining: TrajectoryAppendItem[];
    result: AppendTrajectoryBatchResult;
  } | null {
    const events: TrajectoryEvent[] = [];
    for (const [index, item] of input.events.entries()) {
      const eventId = item.eventId;
      if (!eventId) break;
      const row = this.sql
        .exec(`SELECT * FROM trajectory_events WHERE event_id = ? LIMIT 1`, eventId)
        .toArray()[0] as JsonRecord | undefined;
      if (!row) break;
      const event = this.mapTrajectoryEvent(row);
      if (
        event.trajectoryId !== input.trajectoryId ||
        event.branchId !== input.branchId ||
        !sameAgenticEvent(event, item.event)
      ) {
        throw new Error(`GAD event id collision with different content: ${eventId}`);
      }
      if (index > 0 && event.prevEventHash !== events[index - 1]?.eventHash) {
        throw new Error(`GAD replayed event is not contiguous with prior event: ${eventId}`);
      }
      events.push(event);
    }
    if (events.length === 0) return null;

    for (const item of input.events.slice(events.length)) {
      if (!item.eventId) continue;
      const row = this.sql
        .exec(`SELECT * FROM trajectory_events WHERE event_id = ? LIMIT 1`, item.eventId)
        .toArray()[0] as JsonRecord | undefined;
      if (row) {
        throw new Error("GAD append replay has already-applied events after a new suffix");
      }
    }

    const head = this.getTrajectoryBranchHead({
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
    });
    const replayHead = events[events.length - 1];
    let appendHeadEventId = replayHead?.eventId;
    let appendHeadEventHash = replayHead?.eventHash;
    if (
      input.events.length > events.length &&
      asString(head?.["head_event_hash"]) !== replayHead?.eventHash
    ) {
      if (
        !replayHead ||
        !this.replayPrefixHasOnlyInternalPublicationTail(input, replayHead, events)
      ) {
        throw new Error("GAD append replay prefix is not the current branch head");
      }
      appendHeadEventId = (asString(head?.["head_event_id"]) as EventId | null) ?? undefined;
      appendHeadEventHash = asString(head?.["head_event_hash"]) ?? undefined;
    }
    const published = this.sql
      .exec(
        `SELECT event_id, channel_id, envelope_id
           FROM trajectory_channel_publications
           WHERE event_id IN (${events.map(() => "?").join(", ")})
           ORDER BY channel_seq ASC`,
        ...events.map((event) => event.eventId)
      )
      .toArray()
      .map((row) => ({
        eventId: String(row["event_id"]),
        channelId: String(row["channel_id"]),
        envelopeId: String(row["envelope_id"]),
      }));
    const result = {
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
      headEventId: asString(head?.["head_event_id"]),
      headEventHash: asString(head?.["head_event_hash"]),
      headStateHash: asString(head?.["head_state_hash"]) ?? EMPTY_STATE_HASH,
      events,
      published,
    };
    return {
      events,
      published,
      headEventId: appendHeadEventId,
      headEventHash: appendHeadEventHash,
      remaining: input.events.slice(events.length),
      result,
    };
  }

  private replayPrefixHasOnlyInternalPublicationTail(
    input: AppendTrajectoryBatchInput,
    replayHead: TrajectoryEvent,
    prefixEvents: TrajectoryEvent[]
  ): boolean {
    const prefixEventIds = new Set(prefixEvents.map((event) => String(event.eventId)));
    const rows = this.sql
      .exec(
        `SELECT * FROM trajectory_events
         WHERE trajectory_id = ? AND branch_id = ? AND seq > ?
         ORDER BY seq ASC`,
        input.trajectoryId,
        input.branchId,
        replayHead.seq
      )
      .toArray() as JsonRecord[];
    if (rows.length === 0) return false;
    let prevEventHash = replayHead.eventHash;
    for (const row of rows) {
      const event = this.mapTrajectoryEvent(row);
      if (event.prevEventHash !== prevEventHash) return false;
      if (event.kind !== "external.envelope_published") return false;
      const payload = event.payload as JsonRecord;
      const publications = Array.isArray(payload["publications"]) ? payload["publications"] : [];
      if (
        publications.some((publication) => {
          if (!publication || typeof publication !== "object" || Array.isArray(publication))
            return true;
          return !prefixEventIds.has(String((publication as JsonRecord)["eventId"]));
        })
      ) {
        return false;
      }
      prevEventHash = event.eventHash;
    }
    const head = this.getTrajectoryBranchHead({
      trajectoryId: input.trajectoryId,
      branchId: input.branchId,
    });
    return prevEventHash === asString(head?.["head_event_hash"]);
  }

  private channelForkSourceRows(input: ForkChannelLogInput): JsonRecord[] {
    return this.sql
      .exec(
        `SELECT * FROM channel_envelopes
         WHERE channel_id = ? AND (payload_kind IS NULL OR payload_kind != 'presence') AND (? IS NULL OR seq <= ?)
         ORDER BY seq ASC`,
        input.fromChannelId,
        input.throughSeq ?? null,
        input.throughSeq ?? null
      )
      .toArray() as JsonRecord[];
  }

  private existingForkChannelLog(input: ForkChannelLogInput): ForkChannelLogResult {
    const sourceRows = this.channelForkSourceRows(input);
    const lineageRows = this.sql
      .exec(
        `SELECT * FROM channel_envelope_forks
         WHERE from_channel_id = ? AND to_channel_id = ?
         ORDER BY fork_seq ASC`,
        input.fromChannelId,
        input.toChannelId
      )
      .toArray() as JsonRecord[];
    const sourceIds = sourceRows.map((row) => String(row["envelope_id"]));
    const lineageSourceIds = lineageRows.map((row) => String(row["source_envelope_id"]));
    if (stableJson(sourceIds) !== stableJson(lineageSourceIds)) {
      throw new Error(
        `target channel log already exists with different fork lineage: ${input.toChannelId}`
      );
    }
    const targetEnvelopeCount = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS cnt
           FROM channel_envelopes
           WHERE channel_id = ? AND (payload_kind IS NULL OR payload_kind != 'presence')`,
          input.toChannelId
        )
        .one()["cnt"]
    );
    if (targetEnvelopeCount !== lineageRows.length) {
      throw new Error(
        `target channel log already exists outside fork lineage: ${input.toChannelId}`
      );
    }
    return {
      fromChannelId: input.fromChannelId,
      toChannelId: input.toChannelId,
      throughSeq: input.throughSeq ?? null,
      copied: lineageRows.length,
      firstSeq: lineageRows[0] ? asNumber(lineageRows[0]["fork_seq"]) : undefined,
      lastSeq: lineageRows[lineageRows.length - 1]
        ? asNumber(lineageRows[lineageRows.length - 1]?.["fork_seq"])
        : undefined,
      lineage: lineageRows.map((row) => ({
        sourceEnvelopeId: String(row["source_envelope_id"]),
        forkEnvelopeId: String(row["fork_envelope_id"]),
        sourceSeq: asNumber(row["source_seq"]),
        forkSeq: asNumber(row["fork_seq"]),
      })),
    };
  }

  private trajectoryForkSourceRows(input: ForkTrajectoryBranchInput): {
    throughSeq: number | null;
    sourceRows: JsonRecord[];
  } {
    let throughSeq = input.throughSeq ?? null;
    let copyNone = false;
    if (input.throughEventHash) {
      const row = this.sql
        .exec(
          `SELECT seq FROM trajectory_events
           WHERE trajectory_id = ? AND branch_id = ? AND event_hash = ?
           LIMIT 1`,
          input.fromTrajectoryId,
          input.fromBranchId,
          input.throughEventHash
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!row) throw new Error("forkTrajectoryBranch throughEventHash not found");
      throughSeq = asNumber(row["seq"]);
    }
    if (input.throughPublishedChannelId && input.throughPublishedChannelSeq != null) {
      const row = this.sql
        .exec(
          `SELECT MAX(e.seq) AS seq
           FROM trajectory_channel_publications p
           JOIN trajectory_events e ON e.event_id = p.event_id
           WHERE p.trajectory_id = ?
             AND p.branch_id = ?
             AND p.channel_id = ?
             AND p.channel_seq <= ?`,
          input.fromTrajectoryId,
          input.fromBranchId,
          input.throughPublishedChannelId,
          input.throughPublishedChannelSeq
        )
        .toArray()[0] as JsonRecord | undefined;
      if (row?.["seq"] == null) {
        copyNone = true;
      } else {
        throughSeq = asNumber(row["seq"]);
      }
    }
    return {
      throughSeq,
      sourceRows: copyNone
        ? []
        : (this.sql
            .exec(
              `SELECT * FROM trajectory_events
               WHERE trajectory_id = ? AND branch_id = ? AND (? IS NULL OR seq <= ?)
               ORDER BY seq ASC`,
              input.fromTrajectoryId,
              input.fromBranchId,
              throughSeq,
              throughSeq
            )
            .toArray() as JsonRecord[]),
    };
  }

  private existingForkTrajectoryBranch(
    input: ForkTrajectoryBranchInput
  ): ForkTrajectoryBranchResult {
    const { sourceRows } = this.trajectoryForkSourceRows(input);
    const lineageRows = this.sql
      .exec(
        `SELECT * FROM trajectory_event_forks
         WHERE from_trajectory_id = ? AND from_branch_id = ?
           AND to_trajectory_id = ? AND to_branch_id = ?
         ORDER BY fork_seq ASC`,
        input.fromTrajectoryId,
        input.fromBranchId,
        input.toTrajectoryId,
        input.toBranchId
      )
      .toArray() as JsonRecord[];
    const sourceIds = sourceRows.map((row) => String(row["event_id"]));
    const lineageSourceIds = lineageRows.map((row) => String(row["source_event_id"]));
    if (stableJson(sourceIds) !== stableJson(lineageSourceIds)) {
      throw new Error(
        `target trajectory branch already exists with different fork lineage: ${input.toBranchId}`
      );
    }
    const targetEventCount = asNumber(
      this.sql
        .exec(
          `SELECT COUNT(*) AS cnt FROM trajectory_events WHERE trajectory_id = ? AND branch_id = ?`,
          input.toTrajectoryId,
          input.toBranchId
        )
        .one()["cnt"]
    );
    if (targetEventCount !== lineageRows.length) {
      throw new Error(
        `target trajectory branch already exists outside fork lineage: ${input.toBranchId}`
      );
    }
    const head = this.getTrajectoryBranchHead({
      trajectoryId: input.toTrajectoryId,
      branchId: input.toBranchId,
    });
    return {
      fromTrajectoryId: input.fromTrajectoryId,
      fromBranchId: input.fromBranchId,
      toTrajectoryId: input.toTrajectoryId,
      toBranchId: input.toBranchId,
      copied: lineageRows.length,
      headEventId: asString(head?.["head_event_id"]),
      headEventHash: asString(head?.["head_event_hash"]),
      headStateHash: asString(head?.["head_state_hash"]) ?? EMPTY_STATE_HASH,
      lineage: lineageRows.map((row) => ({
        sourceEventId: String(row["source_event_id"]),
        forkEventId: String(row["fork_event_id"]),
        sourceSeq: asNumber(row["source_seq"]),
        forkSeq: asNumber(row["fork_seq"]),
        sourceEventHash: String(row["source_event_hash"]),
        forkEventHash: String(row["fork_event_hash"]),
      })),
    };
  }

  private mapChannelEnvelope(row: JsonRecord): ChannelEnvelope {
    return {
      envelopeId: brandId<EnvelopeId>(String(row["envelope_id"])),
      channelId: brandId<ChannelId>(String(row["channel_id"])),
      seq: asNumber(row["seq"]),
      from: parseRecord(asString(row["from_json"])) as unknown as ChannelEnvelope["from"],
      ...(row["to_json"]
        ? { to: parseJson(asString(row["to_json"])) as ChannelEnvelope["to"] }
        : {}),
      payload:
        row["payload_kind"] === AGENTIC_EVENT_PAYLOAD_KIND
          ? agenticEventSchema.parse(parseRecord(asString(row["payload_ref_json"])))
          : parseJson(asString(row["payload_ref_json"])),
      payloadKind: asString(row["payload_kind"]) ?? undefined,
      ...(row["metadata_json"] ? { metadata: parseRecord(asString(row["metadata_json"])) } : {}),
      ...(row["attachments_json"]
        ? { attachments: parseJson(asString(row["attachments_json"])) as unknown[] }
        : {}),
      publishedAt: String(row["published_at"]),
    };
  }

  private ensureEmptyState(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (hash, kind, created_at) VALUES (?, 'dir', ?)`,
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

  private stateExists(stateHash: string): boolean {
    return !!this.sql
      .exec(`SELECT 1 AS ok FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0];
  }

  private trajectoryEventExists(eventId: string): boolean {
    return !!this.sql
      .exec(`SELECT 1 AS ok FROM trajectory_events WHERE event_id = ?`, eventId)
      .toArray()[0];
  }

  private latestStateHash(branchId: string): string {
    const row = this.sql
      .exec(
        `SELECT head_state_hash FROM trajectory_branches WHERE branch_id = ? ORDER BY updated_at DESC LIMIT 1`,
        branchId
      )
      .toArray()[0] as JsonRecord | undefined;
    return asString(row?.["head_state_hash"]) ?? EMPTY_STATE_HASH;
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

  private createWorktreeState(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>,
    metadata: Record<string, unknown>
  ): string {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const rootHash = this.createManifestTree(sorted);
    const stateHash = this.stateHashForRoot(rootHash);
    this.sql.exec(
      `INSERT OR REPLACE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?)`,
      stateHash,
      rootHash,
      JSON.stringify(metadata),
      nowIso()
    );
    return stateHash;
  }

  private stateHashForRoot(rootHash: string): string {
    const value = JSON.stringify(sortJson({ manifestRootHash: rootHash }));
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `state:${(hash >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64)}`;
  }

  private createManifestTree(
    files: Array<{ path: string; fileVersionId: number; contentHash: string; mode: number }>
  ): string {
    if (files.length === 0) return EMPTY_MANIFEST_HASH;
    const rootHash = this.manifestHash(
      "dir",
      files.map((file) => ({
        path: file.path,
        fileVersionId: file.fileVersionId,
        contentHash: file.contentHash,
        mode: file.mode,
      }))
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (hash, kind, created_at) VALUES (?, 'dir', ?)`,
      rootHash,
      nowIso()
    );
    for (const file of files) {
      this.sql.exec(
        `INSERT OR REPLACE INTO gad_manifest_entries (
           parent_hash, name, entry_kind, child_manifest_hash, file_version_id
         ) VALUES (?, ?, 'file', NULL, ?)`,
        rootHash,
        file.path,
        file.fileVersionId
      );
    }
    return rootHash;
  }

  private manifestHash(kind: string, entries: unknown): string {
    const value = JSON.stringify(sortJson({ kind, entries }));
    let hash = 5381;
    for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    return `manifest:${(hash >>> 0).toString(16).padStart(8, "0").repeat(8).slice(0, 64)}`;
  }

  private filesForState(stateHash: string): JsonRecord[] {
    const state = this.sql
      .exec(`SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!state) throw new Error(`Unknown worktree state: ${stateHash}`);
    const root = asString(state["manifest_root_hash"]) ?? EMPTY_MANIFEST_HASH;
    return this.sql
      .exec(
        `SELECT e.name AS path, e.file_version_id, f.content_hash, f.mode
         FROM gad_manifest_entries e
         JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.parent_hash = ? AND e.entry_kind = 'file'
         ORDER BY e.name ASC`,
        root
      )
      .toArray() as JsonRecord[];
  }

  private recomputeManifestHash(rootHash: string): string | null {
    const node = this.sql
      .exec(`SELECT kind FROM gad_manifest_nodes WHERE hash = ?`, rootHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!node) return null;
    if (rootHash === EMPTY_MANIFEST_HASH) return EMPTY_MANIFEST_HASH;
    const entries = this.sql
      .exec(
        `SELECT e.name AS path, e.file_version_id, f.content_hash, f.mode
         FROM gad_manifest_entries e
         JOIN gad_file_versions f ON f.id = e.file_version_id
         WHERE e.parent_hash = ? AND e.entry_kind = 'file'
         ORDER BY e.name ASC`,
        rootHash
      )
      .toArray();
    return this.manifestHash(String(node["kind"]), entries);
  }

  private clearTrajectoryProjections(): void {
    for (const table of [
      "trajectory_turns",
      "trajectory_messages",
      "trajectory_message_blocks",
      "trajectory_invocations",
      "trajectory_invocation_outputs",
      "trajectory_approvals",
      "trajectory_usage_rollups",
      "gad_file_observations",
      "gad_file_mutations",
      "gad_file_change_hunks",
      "gad_state_transitions",
      "gad_claims",
      "gad_claim_edges",
      "gad_theories",
      "gad_theory_versions",
      "gad_contradictions",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.sql.exec(`DELETE FROM gad_worktree_states WHERE state_hash <> ?`, EMPTY_STATE_HASH);
    this.sql.exec(`DELETE FROM gad_manifest_entries`);
    this.sql.exec(`DELETE FROM gad_manifest_nodes WHERE hash <> ?`, EMPTY_MANIFEST_HASH);
    this.sql.exec(`DELETE FROM gad_file_versions`);
    this.ensureEmptyState();
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}
