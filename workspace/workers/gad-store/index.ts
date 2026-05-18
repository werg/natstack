import { DurableObjectBase } from "@workspace/runtime/worker";

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;

const EMPTY_MANIFEST_HASH =
  "manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526";
const EMPTY_STATE_HASH = "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7";

export type PiEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom"
  | "custom_message"
  | "label"
  | "session_info";

export type GadEventKind =
  | "file_observation_recorded"
  | "file_mutation_planned"
  | "file_mutation_observed"
  | "dispatch_pending"
  | "dispatch_resolved"
  | "dispatch_abandoned"
  | "approval_requested"
  | "approval_resolved"
  | "credential_interruption"
  | "branch_event"
  | "system_event"
  | "claim_recorded"
  | "theory_updated"
  | "contradiction_recorded";

export interface PiEntrySpec {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  payload: JsonRecord;
  preStateHash?: string | null;
  postStateHash?: string | null;
  actor?: string | null;
  metadata?: JsonRecord | null;
}

export interface GadEventSpec {
  eventId: string;
  kind: GadEventKind;
  anchorKind?: string | null;
  anchorId?: string | null;
  payload: JsonRecord;
  metadata?: JsonRecord | null;
}

export interface EnsurePiBranchInput {
  branchId: string;
  channelId?: string | null;
  metadata?: JsonRecord | null;
}

export interface PiBranchHead {
  branchId: string;
  headEntryId: string | null;
  headEntryHash: string | null;
  headStateHash: string;
}

export interface AppendPiEntryBatchInput {
  branchId: string;
  expectedHeadEntryHash?: string | null;
  expectedStateHash?: string | null;
  items: PiEntrySpec[];
}

export interface AppendPiEntryBatchResult extends PiBranchHead {
  items: Array<{ entryId: string; entryHash: string; parentEntryId: string | null }>;
}

export interface PiEntryRow {
  entryId: string;
  parentEntryId: string | null;
  entryType: PiEntryType;
  actor: string | null;
  entryHash: string;
  parentEntryHash: string | null;
  preStateHash: string;
  postStateHash: string;
  payload: JsonRecord;
  metadata: JsonRecord | null;
  createdAt: string;
}

interface PiDbRow {
  entry_id: string;
  parent_entry_id: string | null;
  entry_type: PiEntryType;
  actor: string | null;
  entry_hash: string;
  parent_entry_hash: string | null;
  pre_state_hash: string;
  post_state_hash: string;
  raw_entry_json: string;
  metadata_json: string | null;
  introduced_at: string;
}

interface FileEntry {
  path: string;
  fileVersionId?: number;
  contentHash: string;
  mode: number;
}

interface ManifestEntryPlan {
  parentHash: string;
  name: string;
  entryKind: "dir" | "file";
  childManifestHash?: string | null;
  file?: FileEntry | null;
}

interface WorktreeStatePlan {
  stateHash: string;
  manifestRootHash: string;
  manifestNodes: string[];
  manifestEntries: ManifestEntryPlan[];
  files: FileEntry[];
}

interface MutationObservedPlan {
  inputStateHash: string;
  outputStateHash: string;
  path: string;
  operation: string;
  contentHash: string | null;
  status: string;
  beforeFileVersionId: number | null;
  statePlan: WorktreeStatePlan | null;
}

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

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortJson(v);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

async function sha256(domain: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${domain}:${hex}`;
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

function readOnlySql(sql: string): boolean {
  const verb = sql
    .trimStart()
    .match(/^[A-Za-z]+/u)?.[0]
    ?.toUpperCase();
  return verb === "SELECT" || verb === "EXPLAIN" || verb === "PRAGMA";
}

function contentBlocks(message: JsonRecord): JsonRecord[] {
  const content = message["content"];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block && typeof block === "object" && !Array.isArray(block) ? [block as JsonRecord] : []
  );
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 10;

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.dropAllPersistenceTables();
    this.createFreshSchema();
  }

  private dropAllPersistenceTables(): void {
    const rows = this.sql
      .exec(
        `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND (name LIKE 'pi_%' OR name LIKE 'gad_%' OR name LIKE 'semantic_%'
              OR name IN ('branches', 'sessions', 'conversation_turns', 'tool_calls',
                          'file_versions', 'tracked_files', 'blobs'))`
      )
      .toArray() as Array<{ name: string }>;
    for (const row of rows) {
      this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(String(row.name))}`);
      this.sql.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(String(row.name))}`);
    }
  }

  private createFreshSchema(): void {
    this.sql.exec(`
      CREATE TABLE pi_branches (
        branch_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel_id TEXT,
        head_entry_id TEXT,
        head_entry_hash TEXT,
        head_state_hash TEXT NOT NULL,
        forked_from_branch_id TEXT,
        forked_from_entry_id TEXT,
        forked_from_state_hash TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX idx_pi_branches_channel ON pi_branches(channel_id)`);
    this.sql.exec(`
      CREATE TABLE pi_session_entries (
        entry_id TEXT PRIMARY KEY,
        parent_entry_id TEXT,
        entry_type TEXT NOT NULL,
        actor TEXT,
        entry_hash TEXT NOT NULL UNIQUE,
        parent_entry_hash TEXT,
        pre_state_hash TEXT NOT NULL,
        post_state_hash TEXT NOT NULL,
        role TEXT,
        timestamp_ms INTEGER,
        api TEXT,
        provider TEXT,
        model TEXT,
        response_model TEXT,
        response_id TEXT,
        stop_reason TEXT,
        error_message TEXT,
        usage_input INTEGER,
        usage_output INTEGER,
        usage_cache_read INTEGER,
        usage_cache_write INTEGER,
        usage_total_tokens INTEGER,
        usage_cost_input REAL,
        usage_cost_output REAL,
        usage_cost_cache_read REAL,
        usage_cost_cache_write REAL,
        usage_cost_total REAL,
        tool_call_id TEXT,
        tool_name TEXT,
        is_error INTEGER,
        tool_result_summary TEXT,
        tool_result_details_hash TEXT,
        model_change_provider TEXT,
        model_change_model_id TEXT,
        thinking_level TEXT,
        compaction_first_kept_entry_id TEXT,
        compaction_tokens_before INTEGER,
        raw_entry_json TEXT NOT NULL,
        metadata_json TEXT,
        introduced_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX idx_pi_entries_parent ON pi_session_entries(parent_entry_id)`);
    this.sql.exec(`CREATE INDEX idx_pi_entries_type ON pi_session_entries(entry_type)`);
    this.sql.exec(
      `CREATE INDEX idx_pi_entries_tool_result ON pi_session_entries(tool_call_id) WHERE role = 'toolResult'`
    );
    this.sql.exec(`CREATE INDEX idx_pi_entries_state ON pi_session_entries(post_state_hash)`);
    this.sql.exec(`
      CREATE TABLE pi_message_blocks (
        block_id TEXT PRIMARY KEY,
        message_entry_id TEXT NOT NULL,
        block_index INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        text TEXT,
        text_signature TEXT,
        thinking TEXT,
        thinking_signature TEXT,
        thinking_redacted INTEGER,
        image_blob_hash TEXT,
        image_mime_type TEXT,
        image_byte_size INTEGER,
        tool_call_id TEXT,
        tool_name TEXT,
        tool_arguments_json TEXT,
        tool_arguments_hash TEXT,
        thought_signature TEXT,
        UNIQUE (message_entry_id, block_index)
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_pi_blocks_message ON pi_message_blocks(message_entry_id, block_index)`
    );
    this.sql.exec(
      `CREATE INDEX idx_pi_blocks_tool_call ON pi_message_blocks(tool_call_id) WHERE tool_call_id IS NOT NULL`
    );
    this.sql.exec(`
      CREATE TABLE pi_tool_calls (
        tool_call_id TEXT PRIMARY KEY,
        assistant_entry_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX idx_pi_tool_calls_assistant ON pi_tool_calls(assistant_entry_id)`);
    this.sql.exec(`
      CREATE TABLE gad_events (
        event_id TEXT NOT NULL UNIQUE,
        event_seq INTEGER PRIMARY KEY,
        event_hash TEXT NOT NULL UNIQUE,
        prev_event_hash TEXT,
        kind TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        payload_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_gad_events_anchor ON gad_events(anchor_kind, anchor_id, event_seq)`
    );
    this.sql.exec(`CREATE INDEX idx_gad_events_kind ON gad_events(kind, event_seq)`);
    this.sql.exec(`
      CREATE TABLE gad_blobs (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_worktree_states (
        state_hash TEXT PRIMARY KEY,
        manifest_root_hash TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_file_versions (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mode INTEGER NOT NULL DEFAULT 33188,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (path, content_hash, mode)
      )
    `);
    this.sql.exec(`CREATE INDEX idx_gad_file_versions_path ON gad_file_versions(path)`);
    this.sql.exec(`
      CREATE TABLE gad_manifest_nodes (
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    this.sql.exec(
      `CREATE INDEX idx_gad_manifest_entries_file ON gad_manifest_entries(file_version_id)`
    );
    this.sql.exec(`
      CREATE TABLE gad_state_transitions (
        event_id TEXT PRIMARY KEY,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        produced_by_tool_call_id TEXT,
        produced_by_mutation_id TEXT,
        summary TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_gad_state_transitions_output ON gad_state_transitions(output_state_hash)`
    );
    this.sql.exec(`
      CREATE TABLE gad_file_mutations (
        mutation_id TEXT PRIMARY KEY,
        created_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        anchor_kind TEXT NOT NULL,
        anchor_id TEXT NOT NULL,
        tool_call_id TEXT,
        path TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        planned_tool TEXT,
        planned_params_json TEXT,
        before_hash TEXT,
        before_size INTEGER,
        after_hash TEXT,
        after_size INTEGER,
        input_state_hash TEXT,
        output_state_hash TEXT,
        state_transition_event_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX idx_gad_mutations_tool ON gad_file_mutations(tool_call_id)`);
    this.sql.exec(`CREATE INDEX idx_gad_mutations_path ON gad_file_mutations(path, created_at)`);
    this.sql.exec(`
      CREATE TABLE gad_file_observations (
        observation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        anchor_kind TEXT NOT NULL,
        anchor_id TEXT NOT NULL,
        tool_call_id TEXT,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(
      `CREATE INDEX idx_gad_observations_path ON gad_file_observations(path, created_at)`
    );
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
    this.sql.exec(`CREATE INDEX idx_gad_hunks_path ON gad_file_change_hunks(path, id)`);
    this.sql.exec(`
      CREATE TABLE gad_dispatches (
        dispatch_call_id TEXT PRIMARY KEY,
        created_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_participant_id TEXT,
        provider_handle TEXT,
        method_name TEXT,
        params_json TEXT,
        result_entry_id TEXT,
        resolved_event_id TEXT,
        abandoned_reason TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_approvals (
        approval_id TEXT PRIMARY KEY,
        requested_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        requested_by_entry_id TEXT NOT NULL,
        approval_level INTEGER,
        request_json TEXT,
        decision TEXT,
        resolved_event_id TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_system_events (
        system_event_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_credential_interruptions (
        interruption_id TEXT PRIMARY KEY,
        created_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        provider_id TEXT NOT NULL,
        model_base_url TEXT,
        resume_entry_id TEXT,
        resolved_event_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_branch_events (
        branch_event_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source_branch_id TEXT,
        source_entry_id TEXT,
        source_state_hash TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_claims (
        id INTEGER PRIMARY KEY,
        claim_hash TEXT NOT NULL UNIQUE,
        created_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        text TEXT NOT NULL,
        normalized_text TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_claim_edges (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        source_claim_id INTEGER NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_theories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        current_version_id INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_theory_versions (
        id INTEGER PRIMARY KEY,
        theory_id INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        parent_version_id INTEGER,
        summary TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_contradictions (
        id INTEGER PRIMARY KEY,
        created_event_id TEXT NOT NULL,
        latest_event_id TEXT NOT NULL,
        anchor_kind TEXT,
        anchor_id TEXT,
        left_claim_id INTEGER,
        right_claim_id INTEGER,
        resolved_event_id TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE gad_index_jobs (
        id INTEGER PRIMARY KEY,
        source_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        locked_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (source_hash, job_kind)
      )
    `);
    this.ensureEmptyState();
  }

  rawSql(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    if (!readOnlySql(sql))
      throw new Error("rawSql writes are disabled for the clean GAD architecture");
    return { rows: this.sql.exec(sql, ...bindings).toArray() as JsonRecord[] };
  }

  query(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    return this.rawSql(sql, bindings);
  }

  ensureBlob(hash: string, size = 0, mimeType?: string | null): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_blobs (hash, size, mime_type) VALUES (?, ?, ?)`,
      hash,
      size,
      mimeType ?? null
    );
  }

  ensurePiBranch(input: EnsurePiBranchInput): PiBranchHead {
    this.ensureReady();
    if (!input.branchId) throw new Error("ensurePiBranch requires branchId");
    this.sql.exec(
      `INSERT INTO pi_branches (branch_id, name, channel_id, head_state_hash, forked_from_state_hash, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id) DO UPDATE SET
         channel_id = COALESCE(excluded.channel_id, pi_branches.channel_id),
         metadata_json = COALESCE(excluded.metadata_json, pi_branches.metadata_json),
         updated_at = excluded.updated_at`,
      input.branchId,
      input.branchId,
      input.channelId ?? null,
      EMPTY_STATE_HASH,
      EMPTY_STATE_HASH,
      json(input.metadata),
      nowIso()
    );
    return this.getPiBranchHead({ branchId: input.branchId });
  }

  getPiBranchHead(input: { branchId: string }): PiBranchHead {
    this.ensureReady();
    const row = this.sql
      .exec(
        `SELECT branch_id, head_entry_id, head_entry_hash, head_state_hash FROM pi_branches WHERE branch_id = ?`,
        input.branchId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!row) throw new Error(`Unknown Pi branch: ${input.branchId}`);
    return {
      branchId: input.branchId,
      headEntryId: asString(row["head_entry_id"]),
      headEntryHash: asString(row["head_entry_hash"]),
      headStateHash: asString(row["head_state_hash"]) ?? EMPTY_STATE_HASH,
    };
  }

  async appendPiEntryBatch(input: AppendPiEntryBatchInput): Promise<AppendPiEntryBatchResult> {
    this.ensureReady();
    const branch = this.getPiBranchHead({ branchId: input.branchId });
    if (
      "expectedHeadEntryHash" in input &&
      (input.expectedHeadEntryHash ?? null) !== branch.headEntryHash
    ) {
      throw new Error("pi head conflict");
    }
    if (
      "expectedStateHash" in input &&
      (input.expectedStateHash ?? null) !== branch.headStateHash
    ) {
      throw new Error("pi state conflict");
    }
    let parentEntryId = branch.headEntryId;
    let parentEntryHash = branch.headEntryHash;
    let stateHash = branch.headStateHash;
    const prepared: Array<
      PiEntrySpec & {
        entryHash: string;
        parentEntryHash: string | null;
        parentEntryId: string | null;
        preStateHash: string;
        postStateHash: string;
      }
    > = [];
    for (const spec of input.items) {
      const preStateHash = spec.preStateHash ?? stateHash;
      const postStateHash = spec.postStateHash ?? preStateHash;
      this.requireState(preStateHash);
      this.requireState(postStateHash);
      const rawEntry = {
        entryId: spec.entryId,
        parentEntryId,
        entryType: spec.entryType,
        actor: spec.actor ?? null,
        payload: spec.payload,
        metadata: spec.metadata ?? null,
      };
      const entryHash = await sha256("pi-entry-v1", {
        entryId: spec.entryId,
        parentEntryHash,
        entryType: spec.entryType,
        preStateHash,
        postStateHash,
        rawEntryJsonCanonical: rawEntry,
      });
      prepared.push({
        ...spec,
        entryHash,
        parentEntryHash,
        parentEntryId,
        preStateHash,
        postStateHash,
      });
      parentEntryId = spec.entryId;
      parentEntryHash = entryHash;
      stateHash = postStateHash;
    }
    this.transaction(() => {
      const current = this.getPiBranchHead({ branchId: input.branchId });
      if (current.headEntryHash !== branch.headEntryHash) throw new Error("pi head conflict");
      if (current.headStateHash !== branch.headStateHash) throw new Error("pi state conflict");
      for (const item of prepared) this.insertPiEntry(item);
      const last = prepared[prepared.length - 1];
      if (last) {
        this.sql.exec(
          `UPDATE pi_branches
           SET head_entry_id = ?, head_entry_hash = ?, head_state_hash = ?, updated_at = ?
           WHERE branch_id = ?`,
          last.entryId,
          last.entryHash,
          stateHash,
          nowIso(),
          input.branchId
        );
      }
    });
    const final = prepared[prepared.length - 1];
    return {
      branchId: input.branchId,
      headEntryId: final?.entryId ?? branch.headEntryId,
      headEntryHash: final?.entryHash ?? branch.headEntryHash,
      headStateHash: stateHash,
      items: prepared.map((item) => ({
        entryId: item.entryId,
        entryHash: item.entryHash,
        parentEntryId: item.parentEntryId,
      })),
    };
  }

  setBranchHead(input: {
    branchId: string;
    entryId: string | null;
    expectedHeadEntryHash?: string | null;
  }): PiBranchHead {
    this.ensureReady();
    const branch = this.getPiBranchHead({ branchId: input.branchId });
    if (
      "expectedHeadEntryHash" in input &&
      input.expectedHeadEntryHash !== undefined &&
      (input.expectedHeadEntryHash ?? null) !== branch.headEntryHash
    ) {
      throw new Error("pi head conflict");
    }
    if (input.entryId == null) {
      this.sql.exec(
        `UPDATE pi_branches SET head_entry_id = NULL, head_entry_hash = NULL, head_state_hash = ?, updated_at = ? WHERE branch_id = ?`,
        EMPTY_STATE_HASH,
        nowIso(),
        input.branchId
      );
      return this.getPiBranchHead({ branchId: input.branchId });
    }
    const target = this.sql
      .exec(
        `SELECT entry_hash, post_state_hash FROM pi_session_entries WHERE entry_id = ?`,
        input.entryId
      )
      .toArray()[0] as JsonRecord | undefined;
    if (!target) throw new Error(`Unknown Pi entry: ${input.entryId}`);
    const chain = this.piBranchRows(input.branchId, null, true);
    if (!chain.some((row) => row.entry_id === input.entryId)) {
      throw new Error(`entryId ${input.entryId} is not on branch ${input.branchId}`);
    }
    this.sql.exec(
      `UPDATE pi_branches
       SET head_entry_id = ?, head_entry_hash = ?, head_state_hash = ?, updated_at = ?
       WHERE branch_id = ?`,
      input.entryId,
      asString(target["entry_hash"]),
      asString(target["post_state_hash"]) ?? EMPTY_STATE_HASH,
      nowIso(),
      input.branchId
    );
    return this.getPiBranchHead({ branchId: input.branchId });
  }

  getEntryById(input: { entryId: string }): PiEntryRow | null {
    this.ensureReady();
    const row = this.sql
      .exec(`SELECT * FROM pi_session_entries WHERE entry_id = ?`, input.entryId)
      .toArray()[0] as unknown as PiDbRow | undefined;
    return row ? this.mapPiRow(row) : null;
  }

  getBranchPath(input: {
    branchId: string;
    throughEntryId?: string | null;
    raw?: boolean | null;
  }): PiEntryRow[] {
    this.ensureReady();
    return this.piBranchRows(input.branchId, input.throughEntryId ?? null, input.raw === true).map(
      (row) => this.mapPiRow(row)
    );
  }

  findEntries(input: {
    branchId: string;
    entryType: PiEntryType;
    offset?: number | null;
    limit?: number | null;
    raw?: boolean | null;
  }): PiEntryRow[] {
    const rows = this.piBranchRows(input.branchId, null, input.raw === true).filter(
      (row) => row.entry_type === input.entryType
    );
    const offset = input.offset ?? 0;
    return (
      input.limit == null ? rows.slice(offset) : rows.slice(offset, offset + input.limit)
    ).map((row) => this.mapPiRow(row));
  }

  materializePiMessages(input: { branchId: string }): { messages: JsonRecord[] } {
    const rows = this.piBranchRows(input.branchId, null, false);
    const messages: JsonRecord[] = [];
    for (const row of rows) {
      if (row.entry_type !== "message") continue;
      const payload = parseRecord(row.raw_entry_json)["payload"];
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const message = (payload as JsonRecord)["message"];
        if (message && typeof message === "object" && !Array.isArray(message))
          messages.push(message as JsonRecord);
      }
    }
    return { messages };
  }

  forkPiBranch(input: {
    sourceBranchId: string;
    newBranchId?: string | null;
    entryId?: string | null;
    stateHash?: string | null;
    channelId?: string | null;
  }): PiBranchHead {
    const source = this.getPiBranchHead({ branchId: input.sourceBranchId });
    let headEntryId = source.headEntryId;
    let headEntryHash = source.headEntryHash;
    let headStateHash = source.headStateHash;
    if (input.entryId != null) {
      const row = this.sql
        .exec(
          `SELECT entry_hash, post_state_hash FROM pi_session_entries WHERE entry_id = ?`,
          input.entryId
        )
        .toArray()[0] as JsonRecord | undefined;
      if (!row) throw new Error(`Unknown fork entryId: ${input.entryId}`);
      headEntryId = input.entryId;
      headEntryHash = asString(row["entry_hash"]);
      headStateHash = asString(row["post_state_hash"]) ?? EMPTY_STATE_HASH;
    } else if (input.stateHash != null) {
      this.requireState(input.stateHash);
      headEntryId = null;
      headEntryHash = null;
      headStateHash = input.stateHash;
    }
    const branchId = input.newBranchId ?? `${input.sourceBranchId}:fork:${Date.now()}`;
    this.sql.exec(
      `INSERT INTO pi_branches (
         branch_id, name, channel_id, head_entry_id, head_entry_hash, head_state_hash,
         forked_from_branch_id, forked_from_entry_id, forked_from_state_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      branchId,
      branchId,
      input.channelId ?? null,
      headEntryId,
      headEntryHash,
      headStateHash,
      input.sourceBranchId,
      headEntryId,
      headStateHash,
      nowIso()
    );
    return this.getPiBranchHead({ branchId });
  }

  listPiBranches(): JsonRecord[] {
    return this.sql
      .exec(`SELECT * FROM pi_branches ORDER BY updated_at DESC`)
      .toArray() as JsonRecord[];
  }

  async appendGadEvents(input: { events: GadEventSpec[] }): Promise<{ eventIds: string[] }> {
    this.ensureReady();
    const toAppend: Array<{
      event: GadEventSpec;
      eventHash: string;
      prevEventHash: string | null;
      projection: MutationObservedPlan | null;
    }> = [];
    let prevEventHash = asString(
      this.sql
        .exec(`SELECT event_hash FROM gad_events ORDER BY event_seq DESC LIMIT 1`)
        .toArray()[0]?.["event_hash"]
    );
    for (const event of input.events) {
      const existing = this.sql
        .exec(
          `SELECT event_hash, kind, anchor_kind, anchor_id, payload_json, metadata_json FROM gad_events WHERE event_id = ?`,
          event.eventId
        )
        .toArray()[0] as JsonRecord | undefined;
      if (existing) {
        this.assertExistingEventMatches(event, existing);
        const existingHash = asString(existing["event_hash"]);
        if (existingHash === prevEventHash) prevEventHash = existingHash;
        continue;
      }
      const eventHash = await this.hashGadEvent(event, prevEventHash);
      const projection = await this.prepareGadProjection(event);
      toAppend.push({ event, eventHash, prevEventHash, projection });
      prevEventHash = eventHash;
    }
    if (toAppend.length > 0) {
      this.transaction(() => {
        for (const item of toAppend)
          this.insertGadEvent(item.event, item.eventHash, item.prevEventHash, item.projection);
      });
    }
    return { eventIds: input.events.map((event) => event.eventId) };
  }

  listGadEvents(
    input: {
      anchorKind?: string | null;
      anchorId?: string | null;
      kind?: string | null;
      limit?: number | null;
    } = {}
  ): JsonRecord[] {
    const limit = input.limit ?? 200;
    if (input.anchorKind && input.anchorId) {
      return this.sql
        .exec(
          `SELECT * FROM gad_events WHERE anchor_kind = ? AND anchor_id = ? ORDER BY event_seq ASC LIMIT ?`,
          input.anchorKind,
          input.anchorId,
          limit
        )
        .toArray() as JsonRecord[];
    }
    if (input.kind) {
      return this.sql
        .exec(
          `SELECT * FROM gad_events WHERE kind = ? ORDER BY event_seq ASC LIMIT ?`,
          input.kind,
          limit
        )
        .toArray() as JsonRecord[];
    }
    return this.sql
      .exec(`SELECT * FROM gad_events ORDER BY event_seq ASC LIMIT ?`, limit)
      .toArray() as JsonRecord[];
  }

  listGadBranchToolCalls(input: { branchId: string; limit?: number | null }): JsonRecord[] {
    const entryIds = new Set(
      this.piBranchRows(input.branchId, null, true).map((row) => row.entry_id)
    );
    const rows = this.sql
      .exec(`SELECT * FROM pi_tool_calls ORDER BY created_at DESC`)
      .toArray() as JsonRecord[];
    const filtered = rows.filter((row) => entryIds.has(String(row["assistant_entry_id"])));
    return input.limit == null ? filtered : filtered.slice(0, input.limit);
  }

  getGadToolProvenance(input: { toolCallId: string }): JsonRecord | null {
    const mutations = this.sql
      .exec(
        `SELECT * FROM gad_file_mutations WHERE tool_call_id = ? ORDER BY created_at`,
        input.toolCallId
      )
      .toArray() as JsonRecord[];
    const observations = this.sql
      .exec(
        `SELECT * FROM gad_file_observations WHERE tool_call_id = ? ORDER BY created_at`,
        input.toolCallId
      )
      .toArray() as JsonRecord[];
    const dispatch = this.sql
      .exec(
        `SELECT * FROM gad_dispatches WHERE tool_call_id = ? ORDER BY created_at DESC LIMIT 1`,
        input.toolCallId
      )
      .toArray()[0] as JsonRecord | undefined;
    return mutations.length || observations.length || dispatch
      ? { toolCallId: input.toolCallId, mutations, observations, dispatch: dispatch ?? null }
      : null;
  }

  listGadBranchFiles(input: { branchId: string }): JsonRecord[] {
    const branch = this.getPiBranchHead({ branchId: input.branchId });
    return this.filesForState(branch.headStateHash);
  }

  diffGadStates(input: { leftStateHash: string; rightStateHash: string }): {
    added: JsonRecord[];
    removed: JsonRecord[];
    changed: JsonRecord[];
  } {
    const left = new Map(
      this.filesForState(input.leftStateHash).map((row) => [String(row["path"]), row])
    );
    const right = new Map(
      this.filesForState(input.rightStateHash).map((row) => [String(row["path"]), row])
    );
    const added: JsonRecord[] = [];
    const removed: JsonRecord[] = [];
    const changed: JsonRecord[] = [];
    for (const [path, row] of right) {
      const before = left.get(path);
      if (!before) added.push(row);
      else if (before["content_hash"] !== row["content_hash"] || before["mode"] !== row["mode"]) {
        changed.push({
          path,
          before: before["content_hash"] ?? null,
          after: row["content_hash"] ?? null,
        });
      }
    }
    for (const [path, row] of left) {
      if (!right.has(path)) removed.push(row);
    }
    return { added, removed, changed };
  }

  readGadFileAtState(input: { stateHash: string; path: string }): JsonRecord | null {
    const path = normalizePath(input.path);
    return this.filesForState(input.stateHash).find((row) => row["path"] === path) ?? null;
  }

  getGadStateProducer(input: { stateHash: string }): JsonRecord | null {
    return (
      (this.sql
        .exec(
          `SELECT st.*, e.kind, e.anchor_kind, e.anchor_id, e.payload_json
       FROM gad_state_transitions st
       JOIN gad_events e ON e.event_id = st.event_id
       WHERE st.output_state_hash = ?
       ORDER BY e.event_seq DESC LIMIT 1`,
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
    let fileVersionId = input.fileVersionId ?? null;
    if (fileVersionId == null && input.stateHash) {
      const file = this.readGadFileAtState({ stateHash: input.stateHash, path });
      fileVersionId =
        typeof file?.["file_version_id"] === "number" ? file["file_version_id"] : null;
    }
    if (fileVersionId == null) return [];
    return this.sql
      .exec(
        `SELECT h.*, m.tool_call_id, m.anchor_kind, m.anchor_id, st.input_state_hash, st.output_state_hash
       FROM gad_file_change_hunks h
       JOIN gad_file_mutations m ON m.mutation_id = h.mutation_id
       LEFT JOIN gad_state_transitions st ON st.event_id = m.state_transition_event_id
       WHERE h.path = ? AND h.after_file_version_id = ?
       ORDER BY h.id DESC LIMIT 1`,
        path,
        fileVersionId
      )
      .toArray() as JsonRecord[];
  }

  enqueueGadIndexJob(input: { sourceHash: string; sourceKind: string; jobKind: string }): {
    id: number;
  } {
    this.sql.exec(
      `INSERT INTO gad_index_jobs (source_hash, source_kind, job_kind)
       VALUES (?, ?, ?)
       ON CONFLICT(source_hash, job_kind) DO UPDATE SET
         status = CASE WHEN gad_index_jobs.status = 'failed' THEN 'queued' ELSE gad_index_jobs.status END,
         error = CASE WHEN gad_index_jobs.status = 'failed' THEN NULL ELSE gad_index_jobs.error END,
         updated_at = excluded.updated_at`,
      input.sourceHash,
      input.sourceKind,
      input.jobKind
    );
    const row = this.sql
      .exec(
        `SELECT id FROM gad_index_jobs WHERE source_hash = ? AND job_kind = ?`,
        input.sourceHash,
        input.jobKind
      )
      .one();
    return { id: asNumber(row["id"]) };
  }

  claimGadIndexJobs(input: { limit?: number | null } = {}): JsonRecord[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gad_index_jobs
       WHERE status IN ('queued', 'retry')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
        input.limit ?? 100
      )
      .toArray() as JsonRecord[];
    const lockedAt = nowIso();
    for (const row of rows) {
      this.sql.exec(
        `UPDATE gad_index_jobs
         SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'retry')`,
        lockedAt,
        lockedAt,
        row["id"] as SqlBinding
      );
    }
    return rows.map((row) => ({
      ...row,
      status: "running",
      attempts: asNumber(row["attempts"]) + 1,
      locked_at: lockedAt,
      updated_at: lockedAt,
    }));
  }

  completeGadIndexJob(input: { id: number }): JsonRecord {
    const completedAt = nowIso();
    this.sql.exec(
      `UPDATE gad_index_jobs
       SET status = 'complete', error = NULL, locked_at = NULL, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      completedAt,
      completedAt,
      input.id
    );
    const row = this.sql
      .exec(`SELECT * FROM gad_index_jobs WHERE id = ?`, input.id)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) throw new Error(`Unknown GAD index job: ${input.id}`);
    if (row["status"] !== "complete")
      throw new Error(
        `Cannot complete GAD index job ${input.id} from status ${String(row["status"])}`
      );
    return row;
  }

  failGadIndexJob(input: { id: number; error: string; retry?: boolean | null }): JsonRecord {
    const failedAt = nowIso();
    this.sql.exec(
      `UPDATE gad_index_jobs
       SET status = ?, error = ?, locked_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'running'`,
      input.retry === true ? "retry" : "failed",
      input.error,
      failedAt,
      input.id
    );
    const row = this.sql
      .exec(`SELECT * FROM gad_index_jobs WHERE id = ?`, input.id)
      .toArray()[0] as JsonRecord | undefined;
    if (!row) throw new Error(`Unknown GAD index job: ${input.id}`);
    if (row["status"] !== "retry" && row["status"] !== "failed")
      throw new Error(`Cannot fail GAD index job ${input.id} from status ${String(row["status"])}`);
    return row;
  }

  listGadIndexJobs(input: { status?: string | null; limit?: number | null } = {}): JsonRecord[] {
    if (input.status) {
      return this.sql
        .exec(
          `SELECT * FROM gad_index_jobs WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
          input.status,
          input.limit ?? 100
        )
        .toArray() as JsonRecord[];
    }
    return this.sql
      .exec(
        `SELECT * FROM gad_index_jobs ORDER BY updated_at DESC, id DESC LIMIT ?`,
        input.limit ?? 100
      )
      .toArray() as JsonRecord[];
  }

  processGadIndexJobs(input: { limit?: number | null } = {}): { processed: number } {
    const rows = this.claimGadIndexJobs(input);
    for (const row of rows) this.completeGadIndexJob({ id: asNumber(row["id"]) });
    return { processed: rows.length };
  }

  async validateGadHashes(): Promise<{ ok: boolean; errors: string[] }> {
    const integrity = await this.checkGadIntegrity();
    return {
      ok: integrity.ok,
      errors: integrity.errors.map(
        (error) =>
          `${String(error["type"] ?? "integrity")}: ${String(error["message"] ?? JSON.stringify(error))}`
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

    for (const row of this.sql
      .exec(`SELECT * FROM pi_session_entries ORDER BY introduced_at, entry_id`)
      .toArray() as unknown as PiDbRow[]) {
      if (row.parent_entry_id == null && row.parent_entry_hash != null) {
        addError("pi-entry", "root Pi entry has a parent hash", { entryId: row.entry_id });
      }
      if (row.parent_entry_id != null) {
        const parent = this.sql
          .exec(`SELECT entry_hash FROM pi_session_entries WHERE entry_id = ?`, row.parent_entry_id)
          .toArray()[0] as JsonRecord | undefined;
        if (!parent) {
          addError("pi-entry", "Pi entry parent is missing", {
            entryId: row.entry_id,
            parentEntryId: row.parent_entry_id,
          });
        } else if (asString(parent["entry_hash"]) !== row.parent_entry_hash) {
          addError("pi-entry", "Pi entry parent hash does not match parent entry", {
            entryId: row.entry_id,
            parentEntryId: row.parent_entry_id,
          });
        }
      }
      if (!this.stateExists(row.pre_state_hash))
        addError("pi-entry", "Pi entry pre-state is missing", {
          entryId: row.entry_id,
          stateHash: row.pre_state_hash,
        });
      if (!this.stateExists(row.post_state_hash))
        addError("pi-entry", "Pi entry post-state is missing", {
          entryId: row.entry_id,
          stateHash: row.post_state_hash,
        });
      const rawEntry = parseRecord(row.raw_entry_json);
      const expectedHash = await sha256("pi-entry-v1", {
        entryId: row.entry_id,
        parentEntryHash: row.parent_entry_hash,
        entryType: row.entry_type,
        preStateHash: row.pre_state_hash,
        postStateHash: row.post_state_hash,
        rawEntryJsonCanonical: rawEntry,
      });
      if (expectedHash !== row.entry_hash)
        addError("pi-entry", "Pi entry hash mismatch", {
          entryId: row.entry_id,
          expectedHash,
          actualHash: row.entry_hash,
        });
    }

    for (const row of this.sql
      .exec(`SELECT * FROM pi_branches ORDER BY branch_id`)
      .toArray() as JsonRecord[]) {
      const branchId = asString(row["branch_id"]) ?? "";
      const headEntryId = asString(row["head_entry_id"]);
      const headEntryHash = asString(row["head_entry_hash"]);
      const headStateHash = asString(row["head_state_hash"]) ?? "";
      if (!this.stateExists(headStateHash))
        addError("pi-branch", "Pi branch head state is missing", {
          branchId,
          stateHash: headStateHash,
        });
      if (headEntryId == null && headEntryHash != null)
        addError("pi-branch", "Pi branch has head hash without head entry", { branchId });
      if (headEntryId != null) {
        const entry = this.sql
          .exec(
            `SELECT entry_hash, post_state_hash FROM pi_session_entries WHERE entry_id = ?`,
            headEntryId
          )
          .toArray()[0] as JsonRecord | undefined;
        if (!entry) {
          addError("pi-branch", "Pi branch head entry is missing", { branchId, headEntryId });
        } else {
          if (asString(entry["entry_hash"]) !== headEntryHash)
            addError("pi-branch", "Pi branch head hash mismatch", { branchId, headEntryId });
          if (asString(entry["post_state_hash"]) !== headStateHash)
            addError("pi-branch", "Pi branch head state does not match head entry", {
              branchId,
              headEntryId,
            });
        }
      }
    }

    let previousEventHash: string | null = null;
    for (const row of this.sql
      .exec(`SELECT * FROM gad_events ORDER BY event_seq ASC`)
      .toArray() as JsonRecord[]) {
      const payload = parseRecord(asString(row["payload_json"]));
      const metadata =
        row["metadata_json"] == null ? null : parseRecord(asString(row["metadata_json"]));
      const expectedPrev = previousEventHash;
      if ((asString(row["prev_event_hash"]) ?? null) !== expectedPrev) {
        addError("gad-event", "GAD event previous hash mismatch", {
          eventId: row["event_id"] as JsonValue,
          expectedPrev,
          actualPrev: asString(row["prev_event_hash"]),
        });
      }
      const expectedHash = await sha256("gad-event-v1", {
        prevEventHash: expectedPrev,
        eventId: row["event_id"],
        kind: row["kind"],
        anchorKind: row["anchor_kind"],
        anchorId: row["anchor_id"],
        payloadCanonical: payload,
        metadataCanonical: metadata,
      });
      if (expectedHash !== row["event_hash"])
        addError("gad-event", "GAD event hash mismatch", {
          eventId: row["event_id"] as JsonValue,
          expectedHash,
          actualHash: row["event_hash"] as JsonValue,
        });
      previousEventHash = asString(row["event_hash"]);
    }

    for (const state of this.sql
      .exec(`SELECT state_hash, manifest_root_hash FROM gad_worktree_states`)
      .toArray() as JsonRecord[]) {
      const rootHash = asString(state["manifest_root_hash"]) ?? "";
      const expectedStateHash = await sha256("state", { manifestRootHash: rootHash });
      if (expectedStateHash !== state["state_hash"]) {
        addError("worktree-state", "worktree state hash mismatch", {
          stateHash: state["state_hash"] as JsonValue,
          expectedStateHash,
        });
      }
      const expectedRootHash = await this.recomputeManifestHash(rootHash);
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
      if (!this.stateExists(String(transition["input_state_hash"])))
        addError("state-transition", "transition input state is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
      if (!this.stateExists(String(transition["output_state_hash"])))
        addError("state-transition", "transition output state is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
      if (!this.eventExists(String(transition["event_id"])))
        addError("state-transition", "transition event is missing", {
          eventId: transition["event_id"] as JsonValue,
        });
    }
    for (const mutation of this.sql
      .exec(`SELECT * FROM gad_file_mutations WHERE state_transition_event_id IS NOT NULL`)
      .toArray() as JsonRecord[]) {
      const transition = this.sql
        .exec(
          `SELECT 1 AS ok FROM gad_state_transitions WHERE event_id = ?`,
          mutation["state_transition_event_id"] as SqlBinding
        )
        .toArray()[0];
      if (!transition)
        addError("file-mutation", "mutation references a missing state transition", {
          mutationId: mutation["mutation_id"] as JsonValue,
        });
    }
    return { ok: errors.length === 0, errors };
  }

  async replayGadEvents(): Promise<{ replayed: number }> {
    const rows = this.sql
      .exec(`SELECT * FROM gad_events ORDER BY event_seq ASC`)
      .toArray() as JsonRecord[];
    this.clearGadProjections();
    this.ensureEmptyState();
    let replayed = 0;
    for (const row of rows) {
      const event: GadEventSpec = {
        eventId: String(row["event_id"]),
        kind: String(row["kind"]) as GadEventKind,
        anchorKind: asString(row["anchor_kind"]),
        anchorId: asString(row["anchor_id"]),
        payload: parseRecord(asString(row["payload_json"])),
        metadata: row["metadata_json"] == null ? null : parseRecord(asString(row["metadata_json"])),
      };
      const projection = await this.prepareGadProjection(event);
      this.applyGadProjection(event, projection);
      replayed += 1;
    }
    return { replayed };
  }

  getStatus(): { metric: string; value: number }[] {
    const count = (table: string) =>
      asNumber(this.sql.exec(`SELECT COUNT(*) AS value FROM ${table}`).one()["value"]);
    const countWhere = (table: string, where: string) =>
      asNumber(
        this.sql.exec(`SELECT COUNT(*) AS value FROM ${table} WHERE ${where}`).one()["value"]
      );
    return [
      { metric: "Pi branches", value: count("pi_branches") },
      { metric: "Pi entries", value: count("pi_session_entries") },
      { metric: "GAD events", value: count("gad_events") },
      { metric: "Worktree states", value: count("gad_worktree_states") },
      { metric: "State transitions", value: count("gad_state_transitions") },
      { metric: "File mutations", value: count("gad_file_mutations") },
      {
        metric: "Index jobs queued",
        value: countWhere("gad_index_jobs", "status IN ('queued', 'retry')"),
      },
      { metric: "Index jobs running", value: countWhere("gad_index_jobs", "status = 'running'") },
      { metric: "Index jobs failed", value: countWhere("gad_index_jobs", "status = 'failed'") },
    ];
  }

  private insertPiEntry(
    item: PiEntrySpec & {
      entryHash: string;
      parentEntryHash: string | null;
      parentEntryId: string | null;
      preStateHash: string;
      postStateHash: string;
    }
  ): void {
    const message =
      item.payload["message"] &&
      typeof item.payload["message"] === "object" &&
      !Array.isArray(item.payload["message"])
        ? (item.payload["message"] as JsonRecord)
        : null;
    const usage =
      message?.["usage"] && typeof message["usage"] === "object" && !Array.isArray(message["usage"])
        ? (message["usage"] as JsonRecord)
        : null;
    const rawEntry = {
      entryId: item.entryId,
      parentEntryId: item.parentEntryId,
      entryType: item.entryType,
      actor: item.actor ?? null,
      payload: item.payload,
      metadata: item.metadata ?? null,
    };
    this.sql.exec(
      `INSERT INTO pi_session_entries (
         entry_id, parent_entry_id, entry_type, actor, entry_hash, parent_entry_hash,
         pre_state_hash, post_state_hash, role, timestamp_ms, api, provider, model,
         response_model, response_id, stop_reason, error_message, usage_input,
         usage_output, usage_cache_read, usage_cache_write, usage_total_tokens,
         usage_cost_input, usage_cost_output, usage_cost_cache_read, usage_cost_cache_write,
         usage_cost_total, tool_call_id, tool_name, is_error, tool_result_summary,
         model_change_provider, model_change_model_id, thinking_level,
         compaction_first_kept_entry_id, compaction_tokens_before,
         raw_entry_json, metadata_json, introduced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.entryId,
      item.parentEntryId,
      item.entryType,
      item.actor ?? null,
      item.entryHash,
      item.parentEntryHash,
      item.preStateHash,
      item.postStateHash,
      message ? asString(message["role"]) : null,
      typeof message?.["timestamp"] === "number" ? message["timestamp"] : null,
      asString(message?.["api"]),
      asString(message?.["provider"]),
      asString(message?.["model"]),
      asString(message?.["responseModel"]),
      asString(message?.["responseId"]),
      asString(message?.["stopReason"]),
      asString(message?.["errorMessage"]),
      typeof usage?.["inputTokens"] === "number" ? usage["inputTokens"] : null,
      typeof usage?.["outputTokens"] === "number" ? usage["outputTokens"] : null,
      typeof usage?.["cacheReadTokens"] === "number" ? usage["cacheReadTokens"] : null,
      typeof usage?.["cacheWriteTokens"] === "number" ? usage["cacheWriteTokens"] : null,
      typeof usage?.["totalTokens"] === "number" ? usage["totalTokens"] : null,
      typeof usage?.["costInput"] === "number" ? usage["costInput"] : null,
      typeof usage?.["costOutput"] === "number" ? usage["costOutput"] : null,
      typeof usage?.["costCacheRead"] === "number" ? usage["costCacheRead"] : null,
      typeof usage?.["costCacheWrite"] === "number" ? usage["costCacheWrite"] : null,
      typeof usage?.["costTotal"] === "number" ? usage["costTotal"] : null,
      asString(message?.["toolCallId"]),
      asString(message?.["toolName"]),
      message?.["isError"] === true ? 1 : null,
      message && asString(message["role"]) === "toolResult"
        ? this.messageTextSummary(message)
        : null,
      item.entryType === "model_change" ? asString(item.payload["provider"]) : null,
      item.entryType === "model_change" ? asString(item.payload["modelId"]) : null,
      item.entryType === "thinking_level_change" ? asString(item.payload["thinkingLevel"]) : null,
      item.entryType === "compaction" ? asString(item.payload["firstKeptEntryId"]) : null,
      item.entryType === "compaction" && typeof item.payload["tokensBefore"] === "number"
        ? item.payload["tokensBefore"]
        : null,
      JSON.stringify(rawEntry),
      json(item.metadata),
      nowIso()
    );
    if (message) this.insertBlocks(item.entryId, message);
  }

  private insertBlocks(entryId: string, message: JsonRecord): void {
    contentBlocks(message).forEach((block, blockIndex) => {
      const blockType = asString(block["type"]) ?? "text";
      const toolCallId = asString(block["id"]) ?? asString(block["toolCallId"]);
      const toolName = asString(block["name"]) ?? asString(block["toolName"]);
      const blockId = toolCallId
        ? `block:${entryId}:${toolCallId}`
        : `block:${entryId}:${blockIndex}`;
      const args = block["input"] ?? block["arguments"] ?? block["args"];
      this.sql.exec(
        `INSERT INTO pi_message_blocks (
           block_id, message_entry_id, block_index, block_type, text, text_signature,
           thinking, thinking_signature, thinking_redacted, image_blob_hash,
           image_mime_type, image_byte_size, tool_call_id, tool_name,
           tool_arguments_json, tool_arguments_hash, thought_signature
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        blockId,
        entryId,
        blockIndex,
        blockType,
        asString(block["text"]),
        asString(block["signature"]),
        asString(block["thinking"]),
        asString(block["thinkingSignature"]),
        block["redacted"] === true ? 1 : 0,
        asString(block["imageBlobHash"]) ?? asString(block["blobHash"]),
        asString(block["mimeType"]),
        typeof block["byteSize"] === "number" ? block["byteSize"] : null,
        toolCallId,
        toolName,
        args == null ? null : JSON.stringify(args),
        null,
        asString(block["thoughtSignature"])
      );
      if (blockType === "toolCall" && toolCallId && toolName) {
        this.sql.exec(
          `INSERT INTO pi_tool_calls (tool_call_id, assistant_entry_id, block_id, tool_name) VALUES (?, ?, ?, ?)`,
          toolCallId,
          entryId,
          blockId,
          toolName
        );
      }
    });
  }

  private async appendGadEvent(event: GadEventSpec): Promise<void> {
    await this.appendGadEvents({ events: [event] });
  }

  private hashGadEvent(event: GadEventSpec, prevEventHash: string | null): Promise<string> {
    return sha256("gad-event-v1", {
      prevEventHash,
      eventId: event.eventId,
      kind: event.kind,
      anchorKind: event.anchorKind ?? null,
      anchorId: event.anchorId ?? null,
      payloadCanonical: event.payload,
      metadataCanonical: event.metadata ?? null,
    });
  }

  private insertGadEvent(
    event: GadEventSpec,
    eventHash: string,
    prevEventHash: string | null,
    projection: MutationObservedPlan | null
  ): void {
    this.sql.exec(
      `INSERT INTO gad_events (event_id, event_hash, prev_event_hash, kind, anchor_kind, anchor_id, payload_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      eventHash,
      prevEventHash,
      event.kind,
      event.anchorKind ?? null,
      event.anchorId ?? null,
      JSON.stringify(event.payload),
      json(event.metadata)
    );
    this.applyGadProjection(event, projection);
  }

  private assertExistingEventMatches(event: GadEventSpec, existing: JsonRecord): void {
    const metadata =
      existing["metadata_json"] == null ? null : parseRecord(asString(existing["metadata_json"]));
    const same =
      existing["kind"] === event.kind &&
      (asString(existing["anchor_kind"]) ?? null) === (event.anchorKind ?? null) &&
      (asString(existing["anchor_id"]) ?? null) === (event.anchorId ?? null) &&
      canonicalJson(parseRecord(asString(existing["payload_json"]))) ===
        canonicalJson(event.payload) &&
      canonicalJson(metadata) === canonicalJson(event.metadata ?? null);
    if (!same) throw new Error(`GAD event id collision with different content: ${event.eventId}`);
  }

  private async prepareGadProjection(event: GadEventSpec): Promise<MutationObservedPlan | null> {
    return event.kind === "file_mutation_observed" ? this.prepareMutationObserved(event) : null;
  }

  private applyGadProjection(
    event: GadEventSpec,
    projection: MutationObservedPlan | null = null
  ): void {
    switch (event.kind) {
      case "file_observation_recorded":
        this.recordObservation(event);
        break;
      case "file_mutation_planned":
        this.recordMutationPlanned(event);
        break;
      case "file_mutation_observed":
        if (!projection) throw new Error(`Missing projection plan for GAD event ${event.eventId}`);
        this.recordMutationObserved(event, projection);
        break;
      case "dispatch_pending":
      case "dispatch_resolved":
      case "dispatch_abandoned":
        this.recordDispatch(event);
        break;
      case "approval_requested":
      case "approval_resolved":
        this.recordApproval(event);
        break;
      case "credential_interruption":
        this.recordCredentialInterruption(event);
        break;
      case "branch_event":
        this.recordBranchEvent(event);
        break;
      case "system_event":
        this.sql.exec(
          `INSERT INTO gad_system_events (system_event_id, event_id, anchor_kind, anchor_id, kind, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
          event.eventId,
          event.eventId,
          event.anchorKind ?? null,
          event.anchorId ?? null,
          asString(event.payload["kind"]) ?? event.kind,
          JSON.stringify(event.payload)
        );
        break;
      case "claim_recorded":
        this.recordClaim(event);
        break;
      case "theory_updated":
        this.recordTheory(event);
        break;
      case "contradiction_recorded":
        this.recordContradiction(event);
        break;
      default:
        break;
    }
  }

  private recordObservation(event: GadEventSpec): void {
    const path = normalizePath(String(event.payload["path"] ?? ""));
    const stateHash = asString(event.payload["observedStateHash"]) ?? EMPTY_STATE_HASH;
    const file = this.readGadFileAtState({ stateHash, path });
    this.sql.exec(
      `INSERT INTO gad_file_observations (
         observation_id, event_id, anchor_kind, anchor_id, tool_call_id, path,
         observed_state_hash, file_version_id, content_hash, size, mime_type, summary, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.eventId,
      event.anchorKind ?? "system",
      event.anchorId ?? event.eventId,
      asString(event.payload["toolCallId"]),
      path,
      stateHash,
      typeof file?.["file_version_id"] === "number" ? file["file_version_id"] : null,
      asString(event.payload["contentHash"]) ?? asString(file?.["content_hash"]),
      typeof event.payload["size"] === "number" ? event.payload["size"] : null,
      asString(event.payload["mimeType"]),
      asString(event.payload["summary"]),
      asString(event.payload["errorMessage"])
    );
  }

  private recordMutationPlanned(event: GadEventSpec): void {
    const path = normalizePath(String(event.payload["path"] ?? ""));
    this.sql.exec(
      `INSERT INTO gad_file_mutations (
         mutation_id, created_event_id, latest_event_id, anchor_kind, anchor_id,
         tool_call_id, path, operation, status, planned_tool, planned_params_json,
         before_hash, before_size
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
      asString(event.payload["mutationId"]) ?? event.eventId,
      event.eventId,
      event.eventId,
      event.anchorKind ?? "tool_call",
      event.anchorId ?? asString(event.payload["toolCallId"]) ?? event.eventId,
      asString(event.payload["toolCallId"]),
      path,
      asString(event.payload["operation"]) ?? asString(event.payload["plannedTool"]) ?? "write",
      asString(event.payload["plannedTool"]),
      json(event.payload["plannedParams"]),
      asString(event.payload["beforeHash"]),
      typeof event.payload["beforeSize"] === "number" ? event.payload["beforeSize"] : null
    );
  }

  private async prepareMutationObserved(event: GadEventSpec): Promise<MutationObservedPlan> {
    const path = normalizePath(String(event.payload["path"] ?? ""));
    const operation = asString(event.payload["operation"]) ?? "write";
    const inputStateHash = asString(event.payload["inputStateHash"]) ?? this.latestStateHash();
    this.requireState(inputStateHash);
    const contentHash =
      asString(event.payload["afterHash"]) ?? asString(event.payload["contentHash"]);
    const status = asString(event.payload["outcome"]) === "error" ? "error" : "ok";
    const oldFile = this.readGadFileAtState({ stateHash: inputStateHash, path });
    const beforeFileVersionId =
      typeof oldFile?.["file_version_id"] === "number" ? oldFile["file_version_id"] : null;
    if (status !== "ok") {
      return {
        inputStateHash,
        outputStateHash: inputStateHash,
        path,
        operation,
        contentHash,
        status,
        beforeFileVersionId,
        statePlan: null,
      };
    }
    const statePlan = await this.buildWorktreeStatePlan(
      inputStateHash,
      path,
      operation,
      contentHash,
      typeof event.payload["mode"] === "number" ? event.payload["mode"] : 33188
    );
    return {
      inputStateHash,
      outputStateHash: statePlan.stateHash,
      path,
      operation,
      contentHash,
      status,
      beforeFileVersionId,
      statePlan,
    };
  }

  private recordMutationObserved(event: GadEventSpec, projection: MutationObservedPlan): void {
    const path = projection.path;
    const mutationId =
      asString(event.payload["mutationId"]) ??
      asString(event.payload["plannedEventId"]) ??
      event.eventId;
    const operation = projection.operation;
    const inputState = projection.inputStateHash;
    const afterHash = projection.contentHash;
    const status = projection.status;
    const outputState = projection.outputStateHash;
    let afterFileVersionId: number | null = null;
    if (status === "ok") {
      if (!projection.statePlan)
        throw new Error(`Missing worktree state plan for mutation ${mutationId}`);
      this.applyWorktreeStatePlan(projection.statePlan);
      const newFile = this.readGadFileAtState({ stateHash: outputState, path });
      afterFileVersionId =
        typeof newFile?.["file_version_id"] === "number" ? newFile["file_version_id"] : null;
      this.sql.exec(
        `INSERT INTO gad_state_transitions (
           event_id, input_state_hash, output_state_hash, produced_by_tool_call_id,
           produced_by_mutation_id, summary, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        event.eventId,
        inputState,
        outputState,
        asString(event.payload["toolCallId"]),
        mutationId,
        asString(event.payload["summary"]),
        json(event.metadata)
      );
      this.recordMutationHunks(
        event,
        mutationId,
        path,
        projection.beforeFileVersionId,
        afterFileVersionId,
        afterHash
      );
    }
    const existing = this.sql
      .exec(`SELECT mutation_id FROM gad_file_mutations WHERE mutation_id = ?`, mutationId)
      .toArray()[0];
    if (existing) {
      this.sql.exec(
        `UPDATE gad_file_mutations
         SET latest_event_id = ?, status = ?, after_hash = ?, after_size = ?,
             input_state_hash = ?, output_state_hash = ?, state_transition_event_id = ?,
             error_message = ?
         WHERE mutation_id = ?`,
        event.eventId,
        status,
        afterHash,
        typeof event.payload["afterSize"] === "number" ? event.payload["afterSize"] : null,
        inputState,
        outputState,
        status === "ok" ? event.eventId : null,
        asString(event.payload["errorMessage"]),
        mutationId
      );
    } else {
      this.sql.exec(
        `INSERT INTO gad_file_mutations (
           mutation_id, created_event_id, latest_event_id, anchor_kind, anchor_id,
           tool_call_id, path, operation, status, after_hash, after_size,
           input_state_hash, output_state_hash, state_transition_event_id, error_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mutationId,
        event.eventId,
        event.eventId,
        event.anchorKind ?? "tool_call",
        event.anchorId ?? asString(event.payload["toolCallId"]) ?? event.eventId,
        asString(event.payload["toolCallId"]),
        path,
        operation,
        status,
        afterHash,
        typeof event.payload["afterSize"] === "number" ? event.payload["afterSize"] : null,
        inputState,
        outputState,
        status === "ok" ? event.eventId : null,
        asString(event.payload["errorMessage"])
      );
    }
  }

  private recordMutationHunks(
    event: GadEventSpec,
    mutationId: string,
    path: string,
    beforeFileVersionId: number | null,
    afterFileVersionId: number | null,
    afterHash: string | null
  ): void {
    const payloadHunks = Array.isArray(event.payload["hunks"]) ? event.payload["hunks"] : [];
    const hunks = payloadHunks.flatMap((hunk) =>
      hunk && typeof hunk === "object" && !Array.isArray(hunk) ? [hunk as JsonRecord] : []
    );
    const rows: JsonRecord[] =
      hunks.length > 0
        ? hunks
        : [
            {
              oldStartLine: 1,
              oldLineCount: null,
              newStartLine: 1,
              newLineCount: null,
              oldTextHash: asString(event.payload["beforeHash"]),
              newTextHash: afterHash,
            },
          ];
    for (const hunk of rows) {
      this.sql.exec(
        `INSERT INTO gad_file_change_hunks (
           mutation_id, path, before_file_version_id, after_file_version_id,
           old_start_line, old_line_count, new_start_line, new_line_count,
           old_text_hash, new_text_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mutationId,
        asString(hunk["path"]) ? normalizePath(String(hunk["path"])) : path,
        beforeFileVersionId,
        afterFileVersionId,
        optionalInt(hunk["oldStartLine"]) ?? optionalInt(hunk["old_start_line"]) ?? 1,
        optionalInt(hunk["oldLineCount"]) ?? optionalInt(hunk["old_line_count"]),
        optionalInt(hunk["newStartLine"]) ?? optionalInt(hunk["new_start_line"]) ?? 1,
        optionalInt(hunk["newLineCount"]) ?? optionalInt(hunk["new_line_count"]),
        asString(hunk["oldTextHash"]) ??
          asString(hunk["old_text_hash"]) ??
          asString(event.payload["beforeHash"]),
        asString(hunk["newTextHash"]) ?? asString(hunk["new_text_hash"]) ?? afterHash
      );
    }
  }

  private recordDispatch(event: GadEventSpec): void {
    const id = asString(event.payload["dispatchCallId"]) ?? event.eventId;
    if (event.kind === "dispatch_pending") {
      this.sql.exec(
        `INSERT INTO gad_dispatches (
           dispatch_call_id, created_event_id, latest_event_id, tool_call_id,
           kind, status, provider_participant_id, provider_handle, method_name, params_json
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id,
        event.eventId,
        event.eventId,
        asString(event.payload["toolCallId"]) ?? "",
        asString(event.payload["dispatchKind"]) ?? "channel-tool",
        asString(event.payload["providerParticipantId"]),
        asString(event.payload["providerHandle"]),
        asString(event.payload["methodName"]),
        json(event.payload["params"])
      );
      return;
    }
    const existing = this.sql
      .exec(
        `SELECT status, result_entry_id, abandoned_reason, error_message
         FROM gad_dispatches WHERE dispatch_call_id = ?`,
        id
      )
      .toArray()[0] as JsonRecord | undefined;
    const action = event.kind === "dispatch_resolved" ? "resolve" : "abandon";
    const targetStatus = event.kind === "dispatch_resolved" ? "resolved" : "abandoned";
    if (!existing) throw new Error(`Cannot ${action} unknown dispatch: ${id}`);
    if (existing["status"] !== "pending") {
      if (existing["status"] === targetStatus && this.dispatchTerminalMatches(existing, event)) {
        return;
      }
      throw new Error(`Cannot ${action} dispatch ${id} from status ${String(existing["status"])}`);
    }
    this.sql.exec(
      `UPDATE gad_dispatches
       SET latest_event_id = ?, status = ?, result_entry_id = ?, resolved_event_id = ?,
           abandoned_reason = ?, error_message = ?, resolved_at = ?
       WHERE dispatch_call_id = ?`,
      event.eventId,
      targetStatus,
      asString(event.payload["resultEntryId"]),
      event.kind === "dispatch_resolved" ? event.eventId : null,
      asString(event.payload["abandonedReason"]),
      asString(event.payload["errorMessage"]),
      nowIso(),
      id
    );
  }

  private dispatchTerminalMatches(existing: JsonRecord, event: GadEventSpec): boolean {
    if (event.kind === "dispatch_resolved") {
      return (
        (asString(existing["result_entry_id"]) ?? null) ===
        (asString(event.payload["resultEntryId"]) ?? null)
      );
    }
    return (
      (asString(existing["abandoned_reason"]) ?? null) ===
        (asString(event.payload["abandonedReason"]) ?? null) &&
      (asString(existing["error_message"]) ?? null) ===
        (asString(event.payload["errorMessage"]) ?? null)
    );
  }

  private recordApproval(event: GadEventSpec): void {
    const approvalId = asString(event.payload["approvalId"]) ?? event.eventId;
    if (event.kind === "approval_requested") {
      this.sql.exec(
        `INSERT INTO gad_approvals (
           approval_id, requested_event_id, latest_event_id, tool_call_id,
           requested_by_entry_id, approval_level, request_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        approvalId,
        event.eventId,
        event.eventId,
        asString(event.payload["toolCallId"]) ?? "",
        asString(event.payload["requestedByEntryId"]) ?? "",
        typeof event.payload["approvalLevel"] === "number" ? event.payload["approvalLevel"] : null,
        json(event.payload["request"])
      );
      return;
    }
    const existing = this.sql
      .exec(`SELECT decision, resolved_by FROM gad_approvals WHERE approval_id = ?`, approvalId)
      .toArray()[0] as JsonRecord | undefined;
    if (!existing) throw new Error(`Cannot resolve unknown approval: ${approvalId}`);
    if (existing["decision"] != null) {
      if (
        asString(existing["decision"]) === asString(event.payload["decision"]) &&
        (asString(existing["resolved_by"]) ?? null) ===
          (asString(event.payload["resolvedBy"]) ?? null)
      ) {
        return;
      }
      throw new Error(`Cannot resolve approval ${approvalId} more than once`);
    }
    this.sql.exec(
      `UPDATE gad_approvals
       SET latest_event_id = ?, decision = ?, resolved_event_id = ?, resolved_by = ?, resolved_at = ?
       WHERE approval_id = ?`,
      event.eventId,
      asString(event.payload["decision"]),
      event.eventId,
      asString(event.payload["resolvedBy"]),
      nowIso(),
      approvalId
    );
  }

  private recordClaim(event: GadEventSpec): void {
    const text = asString(event.payload["text"]);
    if (!text) return;
    const claimHash = asString(event.payload["claimHash"]) ?? `claim:${event.eventId}`;
    this.sql.exec(
      `INSERT INTO gad_claims (
         claim_hash, created_event_id, latest_event_id, anchor_kind, anchor_id,
         text, normalized_text, status, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(claim_hash) DO UPDATE SET
         latest_event_id = excluded.latest_event_id,
         text = excluded.text,
         normalized_text = excluded.normalized_text,
         status = excluded.status,
         confidence = excluded.confidence`,
      claimHash,
      event.eventId,
      event.eventId,
      event.anchorKind ?? null,
      event.anchorId ?? null,
      text,
      asString(event.payload["normalizedText"]) ?? text.toLowerCase(),
      asString(event.payload["status"]) ?? "active",
      typeof event.payload["confidence"] === "number" ? event.payload["confidence"] : null
    );
    const claimId = asNumber(
      this.sql.exec(`SELECT id FROM gad_claims WHERE claim_hash = ?`, claimHash).one()["id"]
    );
    const edges = Array.isArray(event.payload["edges"]) ? event.payload["edges"] : [];
    for (const edge of edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) continue;
      const row = edge as JsonRecord;
      const targetKind = asString(row["targetKind"]) ?? asString(row["targetType"]);
      const targetId = asString(row["targetId"]);
      const relation = asString(row["relation"]);
      if (!targetKind || !targetId || !relation) continue;
      this.sql.exec(
        `INSERT INTO gad_claim_edges (event_id, source_claim_id, target_kind, target_id, relation)
         VALUES (?, ?, ?, ?, ?)`,
        event.eventId,
        claimId,
        targetKind,
        targetId,
        relation
      );
    }
  }

  private recordCredentialInterruption(event: GadEventSpec): void {
    this.sql.exec(
      `INSERT INTO gad_credential_interruptions (
         interruption_id, created_event_id, latest_event_id, anchor_kind, anchor_id,
         provider_id, model_base_url, resume_entry_id, resolved_event_id, status, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asString(event.payload["interruptionId"]) ?? event.eventId,
      event.eventId,
      event.eventId,
      event.anchorKind ?? null,
      event.anchorId ?? null,
      asString(event.payload["providerId"]) ?? "",
      asString(event.payload["modelBaseUrl"]),
      asString(event.payload["resumeEntryId"]),
      asString(event.payload["resolvedEventId"]),
      asString(event.payload["status"]) ?? "pending",
      asString(event.payload["resolvedAt"])
    );
  }

  private recordBranchEvent(event: GadEventSpec): void {
    this.sql.exec(
      `INSERT INTO gad_branch_events (
         branch_event_id, event_id, branch_id, event_type, source_branch_id,
         source_entry_id, source_state_hash, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      asString(event.payload["branchEventId"]) ?? event.eventId,
      event.eventId,
      asString(event.payload["branchId"]) ?? asString(event.anchorId) ?? "",
      asString(event.payload["eventType"]) ?? "created",
      asString(event.payload["sourceBranchId"]),
      asString(event.payload["sourceEntryId"]),
      asString(event.payload["sourceStateHash"]),
      JSON.stringify(event.payload)
    );
  }

  private recordTheory(event: GadEventSpec): void {
    const name = asString(event.payload["name"]);
    if (!name) return;
    this.sql.exec(`INSERT OR IGNORE INTO gad_theories (name) VALUES (?)`, name);
    const theoryId = asNumber(
      this.sql.exec(`SELECT id FROM gad_theories WHERE name = ?`, name).one()["id"]
    );
    this.sql.exec(
      `INSERT INTO gad_theory_versions (theory_id, event_id, anchor_kind, anchor_id, parent_version_id, summary, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      theoryId,
      event.eventId,
      event.anchorKind ?? null,
      event.anchorId ?? null,
      typeof event.payload["parentVersionId"] === "number"
        ? event.payload["parentVersionId"]
        : null,
      asString(event.payload["summary"]),
      asString(event.payload["status"]) ?? "active"
    );
    const versionId = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
    this.sql.exec(
      `UPDATE gad_theories SET current_version_id = ? WHERE id = ?`,
      versionId,
      theoryId
    );
  }

  private recordContradiction(event: GadEventSpec): void {
    this.sql.exec(
      `INSERT INTO gad_contradictions (
         created_event_id, latest_event_id, anchor_kind, anchor_id,
         left_claim_id, right_claim_id, status, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      event.eventId,
      event.anchorKind ?? null,
      event.anchorId ?? null,
      typeof event.payload["leftClaimId"] === "number" ? event.payload["leftClaimId"] : null,
      typeof event.payload["rightClaimId"] === "number" ? event.payload["rightClaimId"] : null,
      asString(event.payload["status"]) ?? "open",
      asString(event.payload["notes"])
    );
  }

  private piBranchRows(branchId: string, throughEntryId: string | null, raw: boolean): PiDbRow[] {
    const rows = this.sql
      .exec(
        `WITH RECURSIVE chain(entry_id, depth) AS (
         SELECT head_entry_id, 0 FROM pi_branches WHERE branch_id = ? AND head_entry_id IS NOT NULL
         UNION ALL
         SELECT e.parent_entry_id, chain.depth + 1
         FROM pi_session_entries e
         JOIN chain ON e.entry_id = chain.entry_id
         WHERE e.parent_entry_id IS NOT NULL
       )
       SELECT e.*
       FROM chain
       JOIN pi_session_entries e ON e.entry_id = chain.entry_id
       ORDER BY chain.depth DESC`,
        branchId
      )
      .toArray() as unknown as PiDbRow[];
    const scoped =
      throughEntryId == null
        ? rows
        : rows.slice(0, rows.findIndex((row) => row.entry_id === throughEntryId) + 1);
    return raw ? scoped : this.applyCompactionBoundary(scoped);
  }

  private applyCompactionBoundary(rows: PiDbRow[]): PiDbRow[] {
    let compactionIndex = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.entry_type === "compaction") {
        compactionIndex = i;
        break;
      }
    }
    if (compactionIndex < 0) return rows;
    const compaction = rows[compactionIndex]!;
    const raw = parseRecord(compaction.raw_entry_json);
    const payload =
      raw["payload"] && typeof raw["payload"] === "object" && !Array.isArray(raw["payload"])
        ? (raw["payload"] as JsonRecord)
        : {};
    const firstKept = asString(payload["firstKeptEntryId"]);
    const after = rows.slice(compactionIndex + 1);
    if (!firstKept) return [compaction, ...after];
    const keepIndex = rows.findIndex((row) => row.entry_id === firstKept);
    return [...(keepIndex < 0 ? [] : rows.slice(keepIndex, compactionIndex)), compaction, ...after];
  }

  private mapPiRow(row: PiDbRow): PiEntryRow {
    const raw = parseRecord(row.raw_entry_json);
    const payload =
      raw["payload"] && typeof raw["payload"] === "object" && !Array.isArray(raw["payload"])
        ? (raw["payload"] as JsonRecord)
        : {};
    return {
      entryId: row.entry_id,
      parentEntryId: row.parent_entry_id,
      entryType: row.entry_type,
      actor: row.actor,
      entryHash: row.entry_hash,
      parentEntryHash: row.parent_entry_hash,
      preStateHash: row.pre_state_hash,
      postStateHash: row.post_state_hash,
      payload,
      metadata: parseRecord(row.metadata_json),
      createdAt: row.introduced_at,
    };
  }

  private messageTextSummary(message: JsonRecord): string | null {
    const text = contentBlocks(message)
      .flatMap((block) => (typeof block["text"] === "string" ? [block["text"]] : []))
      .join("\n");
    return text ? text.slice(0, 500) : null;
  }

  private ensureEmptyState(): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (hash, kind) VALUES (?, 'dir')`,
      EMPTY_MANIFEST_HASH
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json)
       VALUES (?, ?, ?)`,
      EMPTY_STATE_HASH,
      EMPTY_MANIFEST_HASH,
      JSON.stringify({ empty: true })
    );
  }

  private requireState(stateHash: string): void {
    const row = this.sql
      .exec(`SELECT 1 AS ok FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0];
    if (!row) throw new Error(`Unknown worktree state: ${stateHash}`);
  }

  private stateExists(stateHash: string): boolean {
    return Boolean(
      this.sql
        .exec(`SELECT 1 AS ok FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
        .toArray()[0]
    );
  }

  private eventExists(eventId: string): boolean {
    return Boolean(
      this.sql.exec(`SELECT 1 AS ok FROM gad_events WHERE event_id = ?`, eventId).toArray()[0]
    );
  }

  private latestStateHash(): string {
    const row = this.sql
      .exec(`SELECT head_state_hash FROM pi_branches ORDER BY updated_at DESC LIMIT 1`)
      .toArray()[0] as JsonRecord | undefined;
    return asString(row?.["head_state_hash"]) ?? EMPTY_STATE_HASH;
  }

  private filesForState(stateHash: string): JsonRecord[] {
    const state = this.sql
      .exec(`SELECT manifest_root_hash FROM gad_worktree_states WHERE state_hash = ?`, stateHash)
      .toArray()[0] as JsonRecord | undefined;
    const root = asString(state?.["manifest_root_hash"]);
    if (!root) return [];
    return this.sql
      .exec(
        `WITH RECURSIVE tree(parent_hash, prefix) AS (
         SELECT ? AS parent_hash, '' AS prefix
         UNION ALL
         SELECT me.child_manifest_hash, tree.prefix || me.name || '/'
         FROM gad_manifest_entries me
         JOIN tree ON tree.parent_hash = me.parent_hash
         WHERE me.entry_kind = 'dir' AND me.child_manifest_hash IS NOT NULL
       )
       SELECT fv.id AS file_version_id, fv.path, fv.content_hash, fv.mode, fv.created_at
       FROM tree
       JOIN gad_manifest_entries me ON me.parent_hash = tree.parent_hash
       JOIN gad_file_versions fv ON fv.id = me.file_version_id
       WHERE me.entry_kind = 'file'
       ORDER BY fv.path`,
        root
      )
      .toArray() as JsonRecord[];
  }

  private async buildWorktreeStatePlan(
    inputStateHash: string,
    path: string,
    operation: string,
    contentHash: string | null,
    mode: number
  ): Promise<WorktreeStatePlan> {
    const files = new Map<string, FileEntry>(
      this.filesForState(inputStateHash).map((row) => [
        String(row["path"]),
        {
          path: String(row["path"]),
          fileVersionId: asNumber(row["file_version_id"]),
          contentHash: String(row["content_hash"]),
          mode: asNumber(row["mode"]),
        } satisfies FileEntry,
      ])
    );
    if (operation === "delete") {
      files.delete(path);
    } else {
      if (!contentHash) throw new Error("file mutation requires afterHash/contentHash");
      files.set(path, { path, contentHash, mode });
    }
    const entries = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const built = await this.buildManifestTree(entries);
    const stateHash = await sha256("state", { manifestRootHash: built.rootHash });
    return {
      stateHash,
      manifestRootHash: built.rootHash,
      manifestNodes: built.nodes,
      manifestEntries: built.manifestEntries,
      files: entries,
    };
  }

  private async buildManifestTree(
    files: FileEntry[]
  ): Promise<{ rootHash: string; nodes: string[]; manifestEntries: ManifestEntryPlan[] }> {
    type DirNode = { dirs: Map<string, DirNode>; files: Map<string, FileEntry> };
    const root: DirNode = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const parts = file.path.split("/");
      let cursor = root;
      for (const part of parts.slice(0, -1)) {
        const existing = cursor.dirs.get(part);
        if (existing) {
          cursor = existing;
        } else {
          const next: DirNode = { dirs: new Map(), files: new Map() };
          cursor.dirs.set(part, next);
          cursor = next;
        }
      }
      cursor.files.set(parts[parts.length - 1]!, file);
    }
    const nodes: string[] = [];
    const manifestEntries: ManifestEntryPlan[] = [];
    const visit = async (node: DirNode): Promise<string> => {
      const childDirs: Array<{ name: string; hash: string }> = [];
      for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        childDirs.push({ name, hash: await visit(child) });
      }
      const childFiles = [...node.files.entries()].sort(([a], [b]) => a.localeCompare(b));
      const hash = await sha256("manifest", {
        kind: "dir",
        entries: [
          ...childDirs.map((entry) => ({ name: entry.name, kind: "dir", hash: entry.hash })),
          ...childFiles.map(([name, file]) => ({
            name,
            kind: "file",
            contentHash: file.contentHash,
            mode: file.mode,
          })),
        ],
      });
      nodes.push(hash);
      for (const entry of childDirs) {
        manifestEntries.push({
          parentHash: hash,
          name: entry.name,
          entryKind: "dir",
          childManifestHash: entry.hash,
        });
      }
      for (const [name, file] of childFiles) {
        manifestEntries.push({ parentHash: hash, name, entryKind: "file", file });
      }
      return hash;
    };
    const rootHash = await visit(root);
    return { rootHash, nodes, manifestEntries };
  }

  private applyWorktreeStatePlan(plan: WorktreeStatePlan): void {
    for (const file of plan.files) {
      this.ensureBlob(file.contentHash, 0, null);
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_file_versions (path, content_hash, mode) VALUES (?, ?, ?)`,
        file.path,
        file.contentHash,
        file.mode
      );
    }
    for (const hash of plan.manifestNodes) {
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_manifest_nodes (hash, kind) VALUES (?, 'dir')`,
        hash
      );
    }
    for (const entry of plan.manifestEntries) {
      let fileVersionId: number | null = null;
      if (entry.file) {
        const version = this.sql
          .exec(
            `SELECT id FROM gad_file_versions WHERE path = ? AND content_hash = ? AND mode = ?`,
            entry.file.path,
            entry.file.contentHash,
            entry.file.mode
          )
          .one();
        fileVersionId = asNumber(version["id"]);
      }
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_manifest_entries (parent_hash, name, entry_kind, child_manifest_hash, file_version_id)
         VALUES (?, ?, ?, ?, ?)`,
        entry.parentHash,
        entry.name,
        entry.entryKind,
        entry.childManifestHash ?? null,
        fileVersionId
      );
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_worktree_states (state_hash, manifest_root_hash, metadata_json)
       VALUES (?, ?, ?)`,
      plan.stateHash,
      plan.manifestRootHash,
      JSON.stringify({ generatedBy: "gad-event" })
    );
  }

  private async recomputeManifestHash(
    manifestHash: string,
    stack = new Set<string>()
  ): Promise<string | null> {
    const node = this.sql
      .exec(`SELECT kind FROM gad_manifest_nodes WHERE hash = ?`, manifestHash)
      .toArray()[0] as JsonRecord | undefined;
    if (!node) return null;
    if (stack.has(manifestHash)) return null;
    stack.add(manifestHash);
    const rows = this.sql
      .exec(
        `SELECT me.name, me.entry_kind, me.child_manifest_hash, fv.content_hash, fv.mode
       FROM gad_manifest_entries me
       LEFT JOIN gad_file_versions fv ON fv.id = me.file_version_id
       WHERE me.parent_hash = ?
       ORDER BY me.name`,
        manifestHash
      )
      .toArray() as JsonRecord[];
    const entries: JsonRecord[] = [];
    for (const row of rows) {
      const name = asString(row["name"]);
      const kind = asString(row["entry_kind"]);
      if (!name || !kind) return null;
      if (kind === "dir") {
        const childHash = asString(row["child_manifest_hash"]);
        if (!childHash) return null;
        const expectedChildHash = await this.recomputeManifestHash(childHash, new Set(stack));
        if (expectedChildHash !== childHash) return null;
        entries.push({ name, kind: "dir", hash: childHash });
      } else if (kind === "file") {
        const contentHash = asString(row["content_hash"]);
        if (!contentHash || typeof row["mode"] !== "number") return null;
        entries.push({ name, kind: "file", contentHash, mode: row["mode"] });
      } else {
        return null;
      }
    }
    return sha256("manifest", { kind: "dir", entries });
  }

  private clearGadProjections(): void {
    const tables = [
      "gad_index_jobs",
      "gad_contradictions",
      "gad_theory_versions",
      "gad_theories",
      "gad_claim_edges",
      "gad_claims",
      "gad_branch_events",
      "gad_credential_interruptions",
      "gad_system_events",
      "gad_approvals",
      "gad_dispatches",
      "gad_file_change_hunks",
      "gad_file_observations",
      "gad_file_mutations",
      "gad_state_transitions",
      "gad_manifest_entries",
      "gad_manifest_nodes",
      "gad_file_versions",
      "gad_worktree_states",
    ];
    this.transaction(() => {
      for (const table of tables) this.sql.exec(`DELETE FROM ${table}`);
    });
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}

export default {
  async fetch(_request: Request) {
    return new Response("gad workspace durable-object service", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
