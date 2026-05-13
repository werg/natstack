import { DurableObjectBase } from "@workspace/runtime/worker";

type JsonPrimitive = null | string | number | boolean;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;
type SqlBinding = null | string | number | boolean | Uint8Array;

const WORKSPACE_ID = "default";
const EMPTY_MANIFEST_HASH = "manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526";
const EMPTY_STATE_HASH = "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7";

const AUTHORITATIVE_TABLES = new Set([
  "gad_blobs",
  "gad_payloads",
  "gad_file_versions",
  "gad_manifest_nodes",
  "gad_manifest_entries",
  "gad_state_roots",
  "gad_trajectory_items",
  "gad_state_transitions",
  "gad_file_change_hunks",
  "gad_claims",
  "gad_claim_edges",
  "gad_theories",
  "gad_theory_versions",
  "gad_contradictions",
  "gad_branches",
]);

const MUTATING_TRAJECTORY_KINDS = new Set<GadTrajectoryKind>([
  "file_observed",
  "file_mutation",
  "workspace_observed",
]);

export type GadTrajectoryKind =
  | "message_created"
  | "message_block_added"
  | "message_finalized"
  | "tool_call_requested"
  | "tool_result_observed"
  | "file_observed"
  | "file_read"
  | "file_mutation"
  | "workspace_observed"
  | "approval_requested"
  | "approval_resolved"
  | "dispatch_abandoned"
  | "branch_created"
  | "snapshot_marked"
  | "claim_asserted"
  | "claim_revised"
  | "contradiction_detected"
  | "theory_updated"
  | "system_event";

export interface GadTrajectoryItemSpec {
  kind: GadTrajectoryKind;
  actor?: string | null;
  payload?: JsonRecord | string | null;
  messageId?: string | null;
  blockId?: string | null;
  toolCallId?: string | null;
  inputStateHash?: string | null;
  outputStateHash?: string | null;
  metadata?: JsonRecord | null;
}

export interface AppendGadTrajectoryBatchInput {
  workspaceId?: string | null;
  branchId: string;
  expectedTrajectoryHash?: string | null;
  expectedStateHash?: string | null;
  items: GadTrajectoryItemSpec[];
}

export interface EnsureGadBranchInput {
  workspaceId?: string | null;
  branchId: string;
  channelId?: string | null;
  contextId?: string | null;
  metadata?: JsonRecord | null;
}

export interface ForkGadBranchInput {
  workspaceId?: string | null;
  sourceBranchId: string;
  newBranchId?: string | null;
  trajectoryHash?: string | null;
  trajectoryId?: number | null;
  channelId?: string | null;
  contextId?: string | null;
}

export interface GadIntegrityError {
  code: string;
  message: string;
  trajectoryId?: number;
  trajectoryHash?: string;
  branchId?: string;
  stateHash?: string;
  path?: string;
  toolCallId?: string;
}

interface BranchTrajectoryOptions {
  order?: "ASC" | "DESC";
  limit?: number | null;
  throughTrajectoryId?: number | null;
  includePayload?: boolean;
}

interface ManifestFileEntry {
  path: string;
  fileVersionId: number | null;
  contentHash: string;
  mode: number | null;
}

interface ManifestEntryPlan {
  parentHash: string;
  name: string;
  entryKind: "dir" | "file";
  childManifestHash: string | null;
  fileVersionId: number | null;
  path: string | null;
}

interface ManifestNodePlan {
  hash: string;
  entries: ManifestEntryPlan[];
}

interface StateTransitionPlan {
  rootHash: string;
  stateHash: string;
  nodes: ManifestNodePlan[];
  files: ManifestFileEntry[];
  oldFile: ManifestFileEntry | null;
  newFile: { path: string; contentHash: string; mode: number | null } | null;
  newFileVersionId?: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function parseJsonRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
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

async function sha256(domain: string, value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${domain}:${hex}`;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Invalid workspace-relative path: ${path}`);
  }
  return normalized;
}

function sqlVerb(sql: string): string {
  const trimmed = sql.trimStart().replace(/^--.*(?:\n|$)/u, "").trimStart();
  return trimmed.match(/^[A-Za-z]+/u)?.[0]?.toUpperCase() ?? "UNKNOWN";
}

function isReadOnlySql(sql: string): boolean {
  const verb = sqlVerb(sql);
  return verb === "SELECT" || verb === "EXPLAIN";
}

function extractSqlTables(sql: string): string[] {
  const compact = sql.replace(/\s+/gu, " ");
  const names = new Set<string>();
  const patterns = [
    /\bUPDATE\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bINTO\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bFROM\s+["`[]?([A-Za-z_][\w]*)/giu,
    /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`[]?([A-Za-z_][\w]*)/giu,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(compact))) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].filter((name) => !name.startsWith("sqlite_"));
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function toolNameFromBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const item = block as Record<string, unknown>;
  return asString(item["name"]) ?? asString(item["toolName"]) ?? null;
}

function textLineCount(text: string | null): number | null {
  if (text == null) return null;
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

function lineForSubstring(haystack: string | null, needle: string | null): number | null {
  if (!haystack || !needle) return null;
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  return haystack.slice(0, index).split("\n").length;
}

function byteLength(text: string | null): number | null {
  return text == null ? null : new TextEncoder().encode(text).byteLength;
}

function lineRangeEnd(start: number | null, count: number | null): number | null {
  if (start == null || count == null) return null;
  return start + Math.max(count - 1, 0);
}

function hunkOverlapsLineRange(row: JsonRecord, startLine: number, endLine: number): boolean {
  const hunkStart = row["new_start_line"] == null ? null : asNumber(row["new_start_line"]);
  const hunkCount = row["new_line_count"] == null ? null : asNumber(row["new_line_count"]);
  const hunkEnd = lineRangeEnd(hunkStart, hunkCount);
  return hunkStart == null || hunkEnd == null || (hunkStart <= endLine && hunkEnd >= startLine);
}

function translateLineRangeBeforeHunk(row: JsonRecord, startLine: number, endLine: number): { startLine: number; endLine: number } | null {
  const oldCount = row["old_line_count"] == null ? null : asNumber(row["old_line_count"]);
  const newStart = row["new_start_line"] == null ? null : asNumber(row["new_start_line"]);
  const newCount = row["new_line_count"] == null ? null : asNumber(row["new_line_count"]);
  const newEnd = lineRangeEnd(newStart, newCount);
  if (oldCount == null || newStart == null || newCount == null || newEnd == null) return null;
  if (endLine < newStart) return { startLine, endLine };
  if (startLine > newEnd) {
    const delta = oldCount - newCount;
    return { startLine: startLine + delta, endLine: endLine + delta };
  }
  return null;
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 8;

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.resetGadSchema();
    this.createImmutableTables();
  }

  private resetGadSchema(): void {
    const staleViews = this.sql.exec(
      `SELECT name FROM sqlite_master
       WHERE type = 'view'
         AND (name LIKE 'gad_%' OR name IN ('pi_messages_view', 'pi_message_blocks_view'))`,
    ).toArray() as Array<{ name: string }>;
    for (const view of staleViews) {
      this.sql.exec(`DROP VIEW IF EXISTS ${quoteIdentifier(String(view.name))}`);
    }
    const staleTables = this.sql.exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gad_%'`,
    ).toArray() as Array<{ name: string }>;
    const legacyNonGadTables = [
      "blob_policies",
      "embedding_vectors",
      "semantic_relations",
      "semantic_chunk_mentions",
      "semantic_chunks",
      "parsed_structures",
      "plans",
      "branch_snapshot_files",
      "branch_snapshots",
      "tool_call_mutations",
      "tool_call_reads",
      "file_versions",
      "tool_calls",
      "conversation_turns",
      "sessions",
      "tracked_files",
      "branches",
      "blobs",
      "pi_messages_view",
      "pi_message_blocks_view",
    ];
    for (const table of [...legacyNonGadTables, ...staleTables.map((row) => String(row.name))]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    }
  }

  private createImmutableTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_blobs (
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mime_type TEXT,
        policy_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_payloads (
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        json TEXT,
        text TEXT,
        blob_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_file_versions (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mode INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_file_versions_path ON gad_file_versions(workspace_id, path)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_nodes (
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_manifest_entries (
        workspace_id TEXT NOT NULL,
        parent_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        entry_kind TEXT NOT NULL,
        child_manifest_hash TEXT,
        file_version_id INTEGER,
        PRIMARY KEY (workspace_id, parent_hash, name)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_manifest_entries_child ON gad_manifest_entries(workspace_id, child_manifest_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_manifest_entries_file ON gad_manifest_entries(workspace_id, file_version_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_state_roots (
        workspace_id TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        manifest_root_hash TEXT NOT NULL,
        produced_by_trajectory_id INTEGER,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, state_hash)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_state_roots_manifest ON gad_state_roots(workspace_id, manifest_root_hash)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_branches (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_branch_id TEXT,
        channel_id TEXT,
        context_id TEXT,
        forked_from_trajectory_id INTEGER,
        forked_from_state_hash TEXT,
        head_trajectory_id INTEGER,
        head_trajectory_hash TEXT,
        head_state_hash TEXT NOT NULL,
        dirty INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (workspace_id, id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_branches_channel ON gad_branches(workspace_id, channel_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_trajectory_items (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        parent_id INTEGER,
        parent_hash TEXT,
        introduced_on_branch_id TEXT,
        kind TEXT NOT NULL,
        actor TEXT,
        payload_hash TEXT,
        input_state_hash TEXT,
        output_state_hash TEXT,
        message_id TEXT,
        block_id TEXT,
        tool_call_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT,
        UNIQUE (workspace_id, hash)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_trajectory_introduced_branch ON gad_trajectory_items(workspace_id, introduced_on_branch_id, id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_trajectory_parent ON gad_trajectory_items(workspace_id, parent_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_trajectory_tool_call ON gad_trajectory_items(workspace_id, tool_call_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_state_transitions (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        trajectory_id INTEGER NOT NULL,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (workspace_id, trajectory_id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_state_transitions_output ON gad_state_transitions(workspace_id, output_state_hash)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_state_transitions_trajectory ON gad_state_transitions(workspace_id, trajectory_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_file_change_hunks (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        trajectory_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        before_file_version_id INTEGER,
        after_file_version_id INTEGER,
        old_start_line INTEGER,
        old_line_count INTEGER,
        new_start_line INTEGER,
        new_line_count INTEGER,
        old_start_byte INTEGER,
        old_byte_count INTEGER,
        new_start_byte INTEGER,
        new_byte_count INTEGER,
        old_text_hash TEXT,
        new_text_hash TEXT
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_file_change_hunks_path ON gad_file_change_hunks(workspace_id, path, trajectory_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_file_change_hunks_after ON gad_file_change_hunks(workspace_id, after_file_version_id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_file_change_hunks_before ON gad_file_change_hunks(workspace_id, before_file_version_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_claims (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        claim_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL,
        created_trajectory_id INTEGER NOT NULL,
        UNIQUE (workspace_id, claim_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_claim_edges (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_claim_id INTEGER NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        trajectory_id INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_theories (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        current_version_id INTEGER,
        UNIQUE (workspace_id, name)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_theory_versions (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        theory_id INTEGER NOT NULL,
        trajectory_id INTEGER NOT NULL,
        parent_version_id INTEGER,
        summary TEXT,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_contradictions (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        left_claim_id INTEGER,
        right_claim_id INTEGER,
        detected_trajectory_id INTEGER NOT NULL,
        resolved_trajectory_id INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        notes TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_index_jobs (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (workspace_id, source_hash, job_kind)
      )
    `);
    this.ensureEmptyStateRoot(WORKSPACE_ID);
  }

  rawSql(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    this.ensureReady();
    if (!isReadOnlySql(sql) && extractSqlTables(sql).some((table) => AUTHORITATIVE_TABLES.has(table))) {
      this.markDirty(WORKSPACE_ID);
    }
    const rows = this.sql.exec(sql, ...bindings).toArray() as JsonRecord[];
    return { rows };
  }

  query(sql: string, bindings: SqlBinding[] = []): { rows: JsonRecord[] } {
    return this.rawSql(sql, bindings);
  }

  ensureBlob(hash: string, size = 0, mimeType?: string | null, workspaceId = WORKSPACE_ID): void {
    this.ensureReady();
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_blobs (workspace_id, hash, size, mime_type) VALUES (?, ?, ?, ?)`,
      workspaceId,
      hash,
      size,
      mimeType ?? null,
    );
  }

  ensureGadBranch(input: EnsureGadBranchInput): {
    workspaceId: string;
    branchId: string;
    headTrajectoryId: number | null;
    headTrajectoryHash: string | null;
    headStateHash: string;
    dirty: boolean;
  } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const branchId = input.branchId;
    if (!branchId) throw new Error("ensureGadBranch requires branchId");
    this.ensureEmptyStateRoot(workspaceId);
    this.sql.exec(
      `INSERT INTO gad_branches (
         workspace_id, id, name, channel_id, context_id, head_state_hash,
         forked_from_state_hash, metadata_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         channel_id = COALESCE(excluded.channel_id, gad_branches.channel_id),
         context_id = COALESCE(excluded.context_id, gad_branches.context_id),
         metadata_json = COALESCE(excluded.metadata_json, gad_branches.metadata_json),
         updated_at = excluded.updated_at`,
      workspaceId,
      branchId,
      branchId,
      input.channelId ?? null,
      input.contextId ?? null,
      EMPTY_STATE_HASH,
      EMPTY_STATE_HASH,
      json(input.metadata),
      nowIso(),
    );
    return this.getGadBranchHead({ workspaceId, branchId });
  }

  getGadBranchHead(input: { workspaceId?: string | null; branchId: string }): {
    workspaceId: string;
    branchId: string;
    headTrajectoryId: number | null;
    headTrajectoryHash: string | null;
    headStateHash: string;
    dirty: boolean;
  } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const row = this.sql.exec(
      `SELECT * FROM gad_branches WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      input.branchId,
    ).toArray()[0] as JsonRecord | undefined;
    if (!row) throw new Error(`Unknown gad branch: ${input.branchId}`);
    return {
      workspaceId,
      branchId: input.branchId,
      headTrajectoryId: row["head_trajectory_id"] == null ? null : asNumber(row["head_trajectory_id"]),
      headTrajectoryHash: asString(row["head_trajectory_hash"]),
      headStateHash: asString(row["head_state_hash"]) ?? EMPTY_STATE_HASH,
      dirty: row["dirty"] === 1,
    };
  }

  async appendGadTrajectoryBatch(input: AppendGadTrajectoryBatchInput): Promise<{
    workspaceId: string;
    branchId: string;
    headTrajectoryId: number | null;
    headTrajectoryHash: string | null;
    headStateHash: string;
    items: Array<{ id: number; hash: string; inputStateHash: string | null; outputStateHash: string | null }>;
  }> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const branch = this.getGadBranchHead({ workspaceId, branchId: input.branchId });
    if (branch.dirty) throw new Error(`gad branch ${input.branchId} is dirty; validate before appending`);
    const branchId = branch.branchId;
    if ("expectedTrajectoryHash" in input && (input.expectedTrajectoryHash ?? null) !== branch.headTrajectoryHash) {
      throw new Error("gad head conflict");
    }
    if ("expectedStateHash" in input && (input.expectedStateHash ?? null) !== branch.headStateHash) {
      throw new Error("gad state conflict");
    }

    let parentHash = branch.headTrajectoryHash;
    let parentId = branch.headTrajectoryId;
    let currentState = branch.headStateHash;
    let currentFiles: ManifestFileEntry[] | null = null;
    const prepared: Array<{
      hash: string;
      payloadHash: string | null;
      payloadKind: string | null;
      payloadJson: string | null;
      payloadText: string | null;
      spec: GadTrajectoryItemSpec;
      inputStateHash: string | null;
      outputStateHash: string | null;
      parentHash: string | null;
      parentId: number | null;
      stateTransition?: StateTransitionPlan;
    }> = [];

    for (const spec of input.items) {
      const itemInputState = spec.inputStateHash ?? currentState;
      if (itemInputState !== currentState) throw new Error(`Invalid state transition for ${spec.kind}`);
      const stateTransition = await this.prepareStateTransition(workspaceId, currentState, spec, currentFiles ?? undefined);
      if (!stateTransition && spec.outputStateHash != null) throw new Error(`Non-mutating ${spec.kind} cannot set outputStateHash`);
      const effectiveStateTransition = stateTransition?.stateHash === currentState ? null : stateTransition;
      if (stateTransition && spec.outputStateHash != null && spec.outputStateHash !== stateTransition.stateHash) {
        throw new Error(`Invalid outputStateHash for ${spec.kind}`);
      }
      const itemOutputState = effectiveStateTransition ? effectiveStateTransition.stateHash : null;
      const payload = spec.payload ?? null;
      const payloadKind = typeof payload === "string" ? "text" : spec.kind;
      const payloadHash = payload == null ? null : await sha256("payload", { kind: payloadKind, payload });
      const hash = await sha256("trajectory", {
        parentHash,
        kind: spec.kind,
        actor: spec.actor ?? null,
        payloadHash,
        inputStateHash: itemInputState,
        outputStateHash: itemOutputState,
        messageId: spec.messageId ?? null,
        blockId: spec.blockId ?? null,
        toolCallId: spec.toolCallId ?? null,
        metadata: spec.metadata ?? null,
      });
      prepared.push({
        hash,
        payloadHash,
        payloadKind: payload == null ? null : payloadKind,
        payloadJson: payload != null && typeof payload !== "string" ? json(payload) : null,
        payloadText: typeof payload === "string" ? payload : null,
        spec,
        inputStateHash: itemInputState,
        outputStateHash: itemOutputState,
        parentHash,
        parentId,
        stateTransition: effectiveStateTransition ?? undefined,
      });
      parentHash = hash;
      parentId = null;
      if (itemOutputState) currentState = itemOutputState;
      if (effectiveStateTransition) currentFiles = effectiveStateTransition.files;
    }

    const created: Array<{ id: number; hash: string; inputStateHash: string | null; outputStateHash: string | null }> = [];
    this.transaction(() => {
      const pendingFileVersionIds = new Map<string, number>();
      for (const item of prepared) {
        if (item.payloadHash) {
          this.sql.exec(
            `INSERT OR IGNORE INTO gad_payloads (workspace_id, hash, kind, json, text)
             VALUES (?, ?, ?, ?, ?)`,
            workspaceId,
            item.payloadHash,
            item.payloadKind,
            item.payloadJson,
            item.payloadText,
          );
        }
        if (item.stateTransition) {
          let newFileVersionId: number | null = null;
          if (item.stateTransition.newFile) {
            this.sql.exec(
              `INSERT INTO gad_file_versions (workspace_id, path, content_hash, mode)
               VALUES (?, ?, ?, ?)`,
              workspaceId,
              item.stateTransition.newFile.path,
              item.stateTransition.newFile.contentHash,
              item.stateTransition.newFile.mode,
            );
            newFileVersionId = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
            item.stateTransition.newFileVersionId = newFileVersionId;
            pendingFileVersionIds.set(item.stateTransition.newFile.path, newFileVersionId);
            this.ensureBlob(item.stateTransition.newFile.contentHash, 0, null, workspaceId);
          }
          for (const node of item.stateTransition.nodes) {
            this.sql.exec(
              `INSERT OR IGNORE INTO gad_manifest_nodes (workspace_id, hash, kind) VALUES (?, ?, 'dir')`,
              workspaceId,
              node.hash,
            );
            for (const entry of node.entries) {
              let fileVersionId = entry.fileVersionId;
              if (entry.entryKind === "file" && fileVersionId == null && entry.path) {
                fileVersionId = pendingFileVersionIds.get(entry.path) ?? null;
              }
              this.sql.exec(
                `INSERT OR IGNORE INTO gad_manifest_entries (
                   workspace_id, parent_hash, name, entry_kind, child_manifest_hash, file_version_id
                 ) VALUES (?, ?, ?, ?, ?, ?)`,
                workspaceId,
                entry.parentHash,
                entry.name,
                entry.entryKind,
                entry.childManifestHash,
                fileVersionId,
              );
            }
          }
        }
        const parentRow = item.parentId == null && item.parentHash
          ? this.sql.exec(
            `SELECT id FROM gad_trajectory_items WHERE workspace_id = ? AND hash = ?`,
            workspaceId,
            item.parentHash,
          ).toArray()[0] as JsonRecord | undefined
          : undefined;
        const resolvedParentId = item.parentId ?? (parentRow?.["id"] == null ? null : asNumber(parentRow["id"]));
        this.sql.exec(
          `INSERT INTO gad_trajectory_items (
             workspace_id, hash, parent_id, parent_hash, introduced_on_branch_id, kind, actor,
             payload_hash, input_state_hash, output_state_hash, message_id, block_id, tool_call_id, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          workspaceId,
          item.hash,
          resolvedParentId,
          item.parentHash,
          branchId,
          item.spec.kind,
          item.spec.actor ?? null,
          item.payloadHash,
          item.inputStateHash,
          item.outputStateHash,
          item.spec.messageId ?? null,
          item.spec.blockId ?? null,
          item.spec.toolCallId ?? null,
          json(item.spec.metadata),
        );
        const id = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
        parentId = id;
        created.push({ id, hash: item.hash, inputStateHash: item.inputStateHash, outputStateHash: item.outputStateHash });
        if (item.stateTransition) {
          this.sql.exec(
            `INSERT OR IGNORE INTO gad_state_roots (
               workspace_id, state_hash, manifest_root_hash, produced_by_trajectory_id, metadata_json
             ) VALUES (?, ?, ?, ?, ?)`,
            workspaceId,
            item.stateTransition.stateHash,
            item.stateTransition.rootHash,
            id,
            JSON.stringify({ source: "trajectory", kind: item.spec.kind }),
          );
        }
        this.applyTrajectorySidecars(workspaceId, item, id);
      }
      const final = created.length > 0 ? created[created.length - 1] : undefined;
      const finalHeadId = final?.id ?? branch.headTrajectoryId;
      const finalHeadHash = final?.hash ?? branch.headTrajectoryHash;
      this.sql.exec(
        `UPDATE gad_branches
         SET head_trajectory_id = ?, head_trajectory_hash = ?,
             head_state_hash = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND head_trajectory_hash IS ? AND head_state_hash = ?`,
        finalHeadId,
        finalHeadHash,
        currentState,
        nowIso(),
        workspaceId,
        branchId,
        branch.headTrajectoryHash,
        branch.headStateHash,
      );
      for (const item of created) this.enqueueIndexJob(workspaceId, item.hash, "trajectory", "trajectory-sidecars");
    });

    return {
      workspaceId,
      branchId,
      headTrajectoryId: (created.length > 0 ? created[created.length - 1]?.id : undefined) ?? branch.headTrajectoryId,
      headTrajectoryHash: (created.length > 0 ? created[created.length - 1]?.hash : undefined) ?? branch.headTrajectoryHash,
      headStateHash: currentState,
      items: created,
    };
  }

  materializePiMessages(input: { workspaceId?: string | null; branchId: string }): { messages: JsonRecord[] } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const rows = this.branchTrajectoryRows(workspaceId, input.branchId, { order: "ASC" });
    return { messages: this.materializePiMessagesFromTrajectory(workspaceId, rows) };
  }

  listGadBranchTrajectory(input: { workspaceId?: string | null; branchId: string; limit?: number }): JsonRecord[] {
    this.ensureReady();
    return this.branchTrajectoryRows(input.workspaceId ?? WORKSPACE_ID, input.branchId, { order: "DESC", limit: input.limit ?? 200 });
  }

  forkGadBranch(input: ForkGadBranchInput): ReturnType<GadWorkspaceDO["getGadBranchHead"]> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const sourceBranch = this.getGadBranchHead({ workspaceId, branchId: input.sourceBranchId });
    const chain = input.trajectoryId != null || input.trajectoryHash
      ? this.branchTrajectoryRows(workspaceId, input.sourceBranchId, { order: "ASC" })
      : [];
    const row = input.trajectoryId != null
      ? (chain.find((item) => item["trajectory_id"] === input.trajectoryId) ?? null)
      : input.trajectoryHash
        ? (chain.find((item) => item["trajectory_hash"] === input.trajectoryHash) ?? null)
        : null;
    if ((input.trajectoryId != null || input.trajectoryHash) && !row) throw new Error("Unknown fork trajectory item");
    const forkTrajectoryId = row ? asNumber(row["trajectory_id"]) : sourceBranch.headTrajectoryId;
    const forkTrajectoryHash = row ? asString(row["trajectory_hash"]) : sourceBranch.headTrajectoryHash;
    const stateHash = (row ? (asString(row["output_state_hash"]) ?? asString(row["input_state_hash"])) : sourceBranch.headStateHash) ?? EMPTY_STATE_HASH;
    const branchId = input.newBranchId ?? `${input.sourceBranchId}:fork:${Date.now()}`;
    this.sql.exec(
      `INSERT INTO gad_branches (
         workspace_id, id, name, parent_branch_id, channel_id, context_id,
         forked_from_trajectory_id, forked_from_state_hash,
         head_trajectory_id, head_trajectory_hash, head_state_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workspaceId,
      branchId,
      branchId,
      input.sourceBranchId,
      input.channelId ?? null,
      input.contextId ?? null,
      forkTrajectoryId,
      stateHash,
      forkTrajectoryId,
      forkTrajectoryHash,
      stateHash,
    );
    return this.getGadBranchHead({ workspaceId, branchId });
  }

  listGadBranches(input: { workspaceId?: string | null } = {}): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM gad_branches WHERE workspace_id = ? ORDER BY updated_at DESC`,
      input.workspaceId ?? WORKSPACE_ID,
    ).toArray() as JsonRecord[];
  }

  listGadBranchFiles(input: { workspaceId?: string | null; branchId: string }): JsonRecord[] {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const branch = this.sql.exec(
      `SELECT head_state_hash FROM gad_branches WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      input.branchId,
    ).toArray()[0] as JsonRecord | undefined;
    if (!branch) return [];
    return this.filesForState(workspaceId, asString(branch["head_state_hash"]) ?? EMPTY_STATE_HASH);
  }

  diffGadStates(input: { workspaceId?: string | null; leftStateHash: string; rightStateHash: string }): {
    added: JsonRecord[];
    removed: JsonRecord[];
    changed: JsonRecord[];
  } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const added: JsonRecord[] = [];
    const removed: JsonRecord[] = [];
    const changed: JsonRecord[] = [];
    const leftRoot = this.manifestRootForState(workspaceId, input.leftStateHash);
    const rightRoot = this.manifestRootForState(workspaceId, input.rightStateHash);
    this.diffManifestNodes(workspaceId, leftRoot, rightRoot, "", added, removed, changed);
    return { added, removed, changed };
  }

  readGadFileAtState(input: { workspaceId?: string | null; stateHash: string; path: string }): JsonRecord | null {
    this.ensureReady();
    const path = normalizePath(input.path);
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const root = this.manifestRootForState(workspaceId, input.stateHash);
    if (!root) return null;
    return this.readManifestFile(workspaceId, root, path);
  }

  async validateGadHashes(input: { workspaceId?: string | null } = {}): Promise<{ ok: boolean; errors: string[] }> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const errors: string[] = [];
    const manifests = this.sql.exec(
      `SELECT hash FROM gad_manifest_nodes WHERE workspace_id = ? ORDER BY hash`,
      workspaceId,
    ).toArray() as JsonRecord[];
    for (const manifest of manifests) {
      const hash = asString(manifest["hash"]);
      if (!hash) {
        errors.push("invalid manifest node row");
        continue;
      }
      const entries = this.manifestEntryRows(workspaceId, hash);
      const hashEntries: JsonRecord[] = [];
      for (const entry of entries) {
        const name = asString(entry["name"]);
        const kind = asString(entry["entry_kind"]);
        if (!name || (kind !== "dir" && kind !== "file")) {
          errors.push(`invalid manifest entry in ${hash}`);
          continue;
        }
        if (kind === "dir") {
          const childManifestHash = asString(entry["child_manifest_hash"]);
          if (!childManifestHash) errors.push(`directory entry ${name} in ${hash} has no child hash`);
          hashEntries.push({ name, kind, childManifestHash });
        } else {
          const file = this.fileRecordForEntry(workspaceId, entry, name);
          if (!file) {
            errors.push(`file entry ${name} in ${hash} has no file version`);
            continue;
          }
          hashEntries.push({
            name,
            kind,
            contentHash: asString(file["content_hash"]),
            mode: typeof file["mode"] === "number" ? file["mode"] : null,
          });
        }
      }
      const expected = await sha256("manifest", { kind: "dir", entries: hashEntries.sort((a, b) => String(a["name"]).localeCompare(String(b["name"]))) });
      if (expected !== hash) errors.push(`manifest hash mismatch: ${hash} expected ${expected}`);
    }
    const states = this.sql.exec(
      `SELECT state_hash, manifest_root_hash FROM gad_state_roots WHERE workspace_id = ?`,
      workspaceId,
    ).toArray() as JsonRecord[];
    for (const state of states) {
      const stateHash = asString(state["state_hash"]);
      const manifestRootHash = asString(state["manifest_root_hash"]);
      if (!stateHash || !manifestRootHash) {
        errors.push("invalid state row");
        continue;
      }
      const expected = await sha256("state", { manifestRootHash });
      if (expected !== stateHash) errors.push(`state hash mismatch: ${stateHash} expected ${expected}`);
    }
    if (errors.length === 0) {
      this.sql.exec(`UPDATE gad_branches SET dirty = 0 WHERE workspace_id = ?`, workspaceId);
    }
    return { ok: errors.length === 0, errors };
  }

  async clearDirtyAfterValidation(input: { workspaceId?: string | null } = {}): Promise<{ ok: boolean; errors: string[] }> {
    return this.validateGadHashes(input);
  }

  async checkGadIntegrity(input: { workspaceId?: string | null; branchId?: string | null } = {}): Promise<{ ok: boolean; errors: GadIntegrityError[] }> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const errors: GadIntegrityError[] = [];
    const add = (error: GadIntegrityError) => errors.push(error);
    const trajectories = this.sql.exec(
      `SELECT * FROM gad_trajectory_items WHERE workspace_id = ? ORDER BY id`,
      workspaceId,
    ).toArray() as JsonRecord[];
    const trajectoryById = new Map<number, JsonRecord>();
    for (const row of trajectories) trajectoryById.set(asNumber(row["id"]), row);

    const stateRows = this.sql.exec(
      `SELECT state_hash, manifest_root_hash FROM gad_state_roots WHERE workspace_id = ?`,
      workspaceId,
    ).toArray() as JsonRecord[];
    const stateHashes = new Set(stateRows.flatMap((row) => {
      const hash = asString(row["state_hash"]);
      return hash ? [hash] : [];
    }));
    const fileVersionIds = new Set((this.sql.exec(
      `SELECT id FROM gad_file_versions WHERE workspace_id = ?`,
      workspaceId,
    ).toArray() as JsonRecord[]).map((row) => asNumber(row["id"])));

    for (const row of trajectories) {
      const id = asNumber(row["id"]);
      const hash = asString(row["hash"]) ?? undefined;
      const parentId = row["parent_id"] == null ? null : asNumber(row["parent_id"]);
      const parentHash = asString(row["parent_hash"]);
      if (parentId == null) {
        if (parentHash) {
          add({
            code: "parent_hash_without_parent_id",
            message: `Trajectory ${id} has parent_hash but no parent_id`,
            trajectoryId: id,
            trajectoryHash: hash,
          });
        }
        continue;
      }
      const parent = trajectoryById.get(parentId);
      if (!parent) {
        add({
          code: "missing_parent",
          message: `Trajectory ${id} points at missing parent ${parentId}`,
          trajectoryId: id,
          trajectoryHash: hash,
        });
        continue;
      }
      if (parentHash && parentHash !== asString(parent["hash"])) {
        add({
          code: "parent_hash_mismatch",
          message: `Trajectory ${id} parent_hash does not match parent row`,
          trajectoryId: id,
          trajectoryHash: hash,
        });
      }
    }

    const branches = this.sql.exec(
      `SELECT * FROM gad_branches
       WHERE workspace_id = ?
         AND (? IS NULL OR id = ?)
       ORDER BY id`,
      workspaceId,
      input.branchId ?? null,
      input.branchId ?? null,
    ).toArray() as JsonRecord[];

    const traceBranchRows = (branch: JsonRecord): { rows: JsonRecord[]; ids: Set<number>; cycle: boolean } => {
      const rows: JsonRecord[] = [];
      const ids = new Set<number>();
      let id = branch["head_trajectory_id"] == null ? null : asNumber(branch["head_trajectory_id"]);
      let cycle = false;
      while (id != null) {
        if (ids.has(id)) {
          cycle = true;
          break;
        }
        ids.add(id);
        const row = trajectoryById.get(id);
        if (!row) break;
        rows.push(row);
        id = row["parent_id"] == null ? null : asNumber(row["parent_id"]);
      }
      rows.reverse();
      return { rows, ids, cycle };
    };

    for (const branch of branches) {
      const branchId = asString(branch["id"]) ?? undefined;
      const headId = branch["head_trajectory_id"] == null ? null : asNumber(branch["head_trajectory_id"]);
      const headHash = asString(branch["head_trajectory_hash"]);
      const headStateHash = asString(branch["head_state_hash"]);
      if (headStateHash && !stateHashes.has(headStateHash)) {
        add({
          code: "branch_head_state_missing",
          message: `Branch ${branchId ?? "(unknown)"} points at missing state root`,
          branchId,
          stateHash: headStateHash,
        });
      }
      if (headId != null) {
        const head = trajectoryById.get(headId);
        if (!head) {
          add({
            code: "branch_head_missing",
            message: `Branch ${branchId ?? "(unknown)"} points at missing trajectory ${headId}`,
            branchId,
            trajectoryId: headId,
          });
        } else if (headHash && headHash !== asString(head["hash"])) {
          add({
            code: "branch_head_hash_mismatch",
            message: `Branch ${branchId ?? "(unknown)"} head hash does not match head trajectory`,
            branchId,
            trajectoryId: headId,
            trajectoryHash: headHash,
          });
        }
      } else if (headHash) {
        add({
          code: "branch_head_hash_without_id",
          message: `Branch ${branchId ?? "(unknown)"} has a head hash but no head trajectory id`,
          branchId,
          trajectoryHash: headHash,
        });
      }
      const traced = traceBranchRows(branch);
      if (traced.cycle) {
        add({
          code: "branch_trajectory_cycle",
          message: `Branch ${branchId ?? "(unknown)"} reaches a trajectory parent cycle`,
          branchId,
        });
      }
      const requested = new Map<string, number>();
      for (const row of traced.rows) {
        const kind = asString(row["kind"]);
        const toolCallId = asString(row["tool_call_id"]);
        if (!toolCallId) continue;
        if (kind === "tool_call_requested") {
          const count = requested.get(toolCallId) ?? 0;
          if (count > 0) {
            add({
              code: "duplicate_tool_request",
              message: `Branch ${branchId ?? "(unknown)"} has duplicate request rows for tool call ${toolCallId}`,
              branchId,
              trajectoryId: asNumber(row["id"]),
              trajectoryHash: asString(row["hash"]) ?? undefined,
              toolCallId,
            });
          }
          requested.set(toolCallId, count + 1);
        }
        if (kind === "tool_result_observed" && !requested.has(toolCallId)) {
          add({
            code: "tool_result_without_request",
            message: `Branch ${branchId ?? "(unknown)"} has a tool result without an earlier request for ${toolCallId}`,
            branchId,
            trajectoryId: asNumber(row["id"]),
            trajectoryHash: asString(row["hash"]) ?? undefined,
            toolCallId,
          });
        }
      }
    }

    const transitions = this.sql.exec(
      `SELECT * FROM gad_state_transitions WHERE workspace_id = ? ORDER BY id`,
      workspaceId,
    ).toArray() as JsonRecord[];
    for (const transition of transitions) {
      const trajectoryId = asNumber(transition["trajectory_id"]);
      const trajectory = trajectoryById.get(trajectoryId);
      const outputStateHash = asString(transition["output_state_hash"]) ?? undefined;
      if (!trajectory) {
        add({
          code: "state_transition_missing_trajectory",
          message: `State transition points at missing trajectory ${trajectoryId}`,
          trajectoryId,
          stateHash: outputStateHash,
        });
        continue;
      }
      const kind = asString(trajectory["kind"]) as GadTrajectoryKind | null;
      if (!kind || !MUTATING_TRAJECTORY_KINDS.has(kind)) {
        add({
          code: "state_transition_non_mutating_kind",
          message: `State transition trajectory ${trajectoryId} has non-mutating kind ${kind ?? "(unknown)"}`,
          trajectoryId,
          trajectoryHash: asString(trajectory["hash"]) ?? undefined,
          stateHash: outputStateHash,
        });
      }
      if (transition["input_state_hash"] === transition["output_state_hash"]) {
        add({
          code: "state_transition_noop",
          message: `State transition ${transition["id"]} does not change state`,
          trajectoryId,
          trajectoryHash: asString(trajectory["hash"]) ?? undefined,
          stateHash: outputStateHash,
        });
      }
      if (outputStateHash && !stateHashes.has(outputStateHash)) {
        add({
          code: "state_transition_missing_output_state",
          message: `State transition output state ${outputStateHash} is missing`,
          trajectoryId,
          trajectoryHash: asString(trajectory["hash"]) ?? undefined,
          stateHash: outputStateHash,
        });
      }
    }

    const hunks = this.sql.exec(
      `SELECT * FROM gad_file_change_hunks WHERE workspace_id = ? ORDER BY id`,
      workspaceId,
    ).toArray() as JsonRecord[];
    const hunksByAfterVersion = new Map<string, JsonRecord[]>();
    for (const hunk of hunks) {
      const trajectoryId = asNumber(hunk["trajectory_id"]);
      const trajectory = trajectoryById.get(trajectoryId);
      const path = asString(hunk["path"]) ?? undefined;
      if (!trajectory) {
        add({
          code: "file_hunk_missing_trajectory",
          message: `File hunk ${hunk["id"]} points at missing trajectory ${trajectoryId}`,
          trajectoryId,
          path,
        });
      }
      for (const column of ["before_file_version_id", "after_file_version_id"] as const) {
        if (hunk[column] == null) continue;
        const fileVersionId = asNumber(hunk[column]);
        if (!fileVersionIds.has(fileVersionId)) {
          add({
            code: "file_hunk_missing_file_version",
            message: `File hunk ${hunk["id"]} references missing ${column} ${fileVersionId}`,
            trajectoryId,
            trajectoryHash: trajectory ? asString(trajectory["hash"]) ?? undefined : undefined,
            path,
          });
        }
      }
      const afterFileVersionId = hunk["after_file_version_id"] == null ? null : asNumber(hunk["after_file_version_id"]);
      if (path && afterFileVersionId != null) {
        const key = `${path}\0${afterFileVersionId}`;
        const existing = hunksByAfterVersion.get(key) ?? [];
        existing.push(hunk);
        hunksByAfterVersion.set(key, existing);
      }
    }
    for (const [key, lineageHunks] of hunksByAfterVersion) {
      for (const hunk of lineageHunks) {
        const seen = new Set<number>();
        let current: JsonRecord | undefined = hunk;
        while (current) {
          const id = asNumber(current["id"]);
          if (seen.has(id)) {
            add({
              code: "file_hunk_lineage_cycle",
              message: `File hunk lineage cycles at hunk ${id}`,
              trajectoryId: asNumber(current["trajectory_id"]),
              path: asString(current["path"]) ?? key.split("\0")[0],
            });
            break;
          }
          seen.add(id);
          const beforeFileVersionId = current["before_file_version_id"] == null ? null : asNumber(current["before_file_version_id"]);
          if (beforeFileVersionId == null) break;
          current = hunksByAfterVersion.get(`${asString(current["path"])}\0${beforeFileVersionId}`)?.[0];
        }
      }
    }

    const manifestRows = this.sql.exec(
      `SELECT hash FROM gad_manifest_nodes WHERE workspace_id = ? ORDER BY hash`,
      workspaceId,
    ).toArray() as JsonRecord[];
    const manifestHashes = new Set(manifestRows.flatMap((row) => {
      const hash = asString(row["hash"]);
      return hash ? [hash] : [];
    }));
    for (const manifest of manifestRows) {
      const hash = asString(manifest["hash"]);
      if (!hash) {
        add({ code: "invalid_manifest_node", message: "Manifest node row is missing a hash" });
        continue;
      }
      const entries = this.manifestEntryRows(workspaceId, hash);
      const hashEntries: JsonRecord[] = [];
      for (const entry of entries) {
        const name = asString(entry["name"]);
        const kind = asString(entry["entry_kind"]);
        if (!name || (kind !== "dir" && kind !== "file")) {
          add({ code: "invalid_manifest_entry", message: `Manifest ${hash} has an invalid entry` });
          continue;
        }
        if (kind === "dir") {
          const childManifestHash = asString(entry["child_manifest_hash"]);
          if (!childManifestHash || !manifestHashes.has(childManifestHash)) {
            add({
              code: "manifest_missing_child",
              message: `Manifest ${hash} directory ${name} points at a missing child manifest`,
            });
          }
          hashEntries.push({ name, kind, childManifestHash });
        } else {
          const file = this.fileRecordForEntry(workspaceId, entry, name);
          if (!file) {
            add({
              code: "manifest_missing_file_version",
              message: `Manifest ${hash} file ${name} points at a missing file version`,
              path: name,
            });
            continue;
          }
          hashEntries.push({
            name,
            kind,
            contentHash: asString(file["content_hash"]),
            mode: typeof file["mode"] === "number" ? file["mode"] : null,
          });
        }
      }
      const expected = await sha256("manifest", { kind: "dir", entries: hashEntries.sort((a, b) => String(a["name"]).localeCompare(String(b["name"]))) });
      if (expected !== hash) {
        add({
          code: "manifest_hash_mismatch",
          message: `Manifest hash ${hash} does not match its entries`,
        });
      }
    }

    for (const state of stateRows) {
      const stateHash = asString(state["state_hash"]);
      const manifestRootHash = asString(state["manifest_root_hash"]);
      if (!stateHash || !manifestRootHash) {
        add({ code: "invalid_state_root", message: "State root row is missing hash data", stateHash: stateHash ?? undefined });
        continue;
      }
      if (!manifestHashes.has(manifestRootHash)) {
        add({
          code: "state_root_missing_manifest",
          message: `State root ${stateHash} points at a missing manifest`,
          stateHash,
        });
      }
      const expected = await sha256("state", { manifestRootHash });
      if (expected !== stateHash) {
        add({
          code: "state_hash_mismatch",
          message: `State hash ${stateHash} does not match manifest root`,
          stateHash,
        });
      }
    }

    return { ok: errors.length === 0, errors };
  }

  private branchTrajectoryRows(workspaceId: string, branchId: string, options: BranchTrajectoryOptions = {}): JsonRecord[] {
    const direction = options.order === "DESC" ? "DESC" : "ASC";
    const includePayload = options.includePayload === true;
    const limitClause = options.limit == null ? "" : " LIMIT ?";
    const throughClause = options.throughTrajectoryId == null ? "" : " WHERE trajectory_id <= ?";
    const payloadJoin = includePayload
      ? "LEFT JOIN gad_payloads p ON p.workspace_id = branch_rows.workspace_id AND p.hash = branch_rows.payload_hash"
      : "";
    const payloadSelect = includePayload ? ", p.kind AS payload_kind, p.json AS payload_json, p.text AS payload_text" : "";
    const bindings: SqlBinding[] = [workspaceId, branchId];
    if (options.throughTrajectoryId != null) bindings.push(options.throughTrajectoryId);
    if (options.limit != null) bindings.push(options.limit);
    return this.sql.exec(
      `WITH RECURSIVE branch_chain AS (
         SELECT ti.*
         FROM gad_branches b
         JOIN gad_trajectory_items ti
           ON ti.workspace_id = b.workspace_id AND ti.id = b.head_trajectory_id
         WHERE b.workspace_id = ? AND b.id = ? AND b.head_trajectory_id IS NOT NULL

         UNION ALL

         SELECT parent.*
         FROM gad_trajectory_items parent
         JOIN branch_chain child
           ON parent.workspace_id = child.workspace_id AND parent.id = child.parent_id
       ),
       branch_rows AS (
       SELECT id AS trajectory_id, hash AS trajectory_hash, workspace_id,
              parent_id, parent_hash, introduced_on_branch_id, kind, actor, payload_hash,
              input_state_hash, output_state_hash, message_id, block_id,
              tool_call_id, created_at, metadata_json
       FROM branch_chain
       )
       SELECT branch_rows.*${payloadSelect}
       FROM branch_rows
       ${payloadJoin}
       ${throughClause}
       ORDER BY trajectory_id ${direction}${limitClause}`,
      ...bindings,
    ).toArray() as JsonRecord[];
  }

  private branchTrajectoryIdSet(workspaceId: string, branchId: string): Set<number> {
    return new Set(this.branchTrajectoryRows(workspaceId, branchId, { order: "ASC" }).map((row) => asNumber(row["trajectory_id"])));
  }

  private fileLineageRows(workspaceId: string, path: string, fileVersionId: number): JsonRecord[] {
    return this.sql.exec(
      `WITH RECURSIVE file_lineage AS (
         SELECT h.*, 0 AS depth
         FROM gad_file_change_hunks h
         WHERE h.workspace_id = ?
           AND h.path = ?
           AND h.after_file_version_id = ?

         UNION ALL

         SELECT parent.*, file_lineage.depth + 1 AS depth
         FROM gad_file_change_hunks parent
         JOIN file_lineage
           ON parent.workspace_id = file_lineage.workspace_id
          AND parent.path = file_lineage.path
          AND parent.after_file_version_id = file_lineage.before_file_version_id
       )
       SELECT file_lineage.*, ti.hash AS origin_trajectory_hash, ti.kind, ti.actor,
              ti.message_id, ti.block_id, ti.tool_call_id AS origin_tool_call_id
       FROM file_lineage
       JOIN gad_trajectory_items ti
         ON ti.workspace_id = file_lineage.workspace_id
        AND ti.id = file_lineage.trajectory_id
       ORDER BY file_lineage.depth ASC, file_lineage.id DESC`,
      workspaceId,
      path,
      fileVersionId,
    ).toArray() as JsonRecord[];
  }

  private toolCallRowsFromTrajectory(workspaceId: string, branchId: string, toolCallId?: string | null): JsonRecord[] {
    const rows = this.branchTrajectoryRows(workspaceId, branchId, { order: "ASC" });
    const calls = this.materializeToolCallsFromTrajectory(workspaceId, branchId, rows);
    return toolCallId ? calls.filter((row) => row["tool_call_id"] === toolCallId) : calls;
  }

  enqueueGadIndexJob(input: { workspaceId?: string | null; sourceHash: string; sourceKind: string; jobKind: string }): { id: number } {
    this.ensureReady();
    this.enqueueIndexJob(input.workspaceId ?? WORKSPACE_ID, input.sourceHash, input.sourceKind, input.jobKind);
    const row = this.sql.exec(
      `SELECT id FROM gad_index_jobs WHERE workspace_id = ? AND source_hash = ? AND job_kind = ?`,
      input.workspaceId ?? WORKSPACE_ID,
      input.sourceHash,
      input.jobKind,
    ).one();
    return { id: asNumber(row["id"]) };
  }

  processGadIndexJobs(input: { workspaceId?: string | null; limit?: number } = {}): { processed: number } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const rows = this.sql.exec(
      `SELECT id FROM gad_index_jobs WHERE workspace_id = ? AND status = 'queued' ORDER BY id LIMIT ?`,
      workspaceId,
      input.limit ?? 100,
    ).toArray() as JsonRecord[];
    for (const row of rows) {
      this.sql.exec(`UPDATE gad_index_jobs SET status = 'complete', updated_at = ? WHERE id = ?`, nowIso(), row["id"]);
    }
    return { processed: rows.length };
  }

  listGadBranchToolCalls(input: { workspaceId?: string | null; branchId: string; limit?: number }): JsonRecord[] {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    return this.toolCallRowsFromTrajectory(workspaceId, input.branchId)
      .sort((a, b) => asNumber(b["source_trajectory_id"]) - asNumber(a["source_trajectory_id"]))
      .slice(0, input.limit ?? 200);
  }

  getGadToolProvenance(input: { workspaceId?: string | null; branchId: string; toolCallId: string }): JsonRecord | null {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    return this.toolCallRowsFromTrajectory(workspaceId, input.branchId, input.toolCallId)[0] ?? null;
  }

  getGadStateProducer(input: { workspaceId?: string | null; stateHash: string; branchId?: string | null }): JsonRecord | null {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const branchIds = input.branchId ? this.branchTrajectoryIdSet(workspaceId, input.branchId) : null;
    const rows = this.sql.exec(
      `SELECT st.*, ti.hash AS trajectory_hash, ti.kind, ti.actor, ti.message_id,
              ti.block_id, ti.tool_call_id, ti.payload_hash
       FROM gad_state_transitions st
       JOIN gad_trajectory_items ti
         ON ti.workspace_id = st.workspace_id AND ti.id = st.trajectory_id
       WHERE st.workspace_id = ? AND st.output_state_hash = ?
       ORDER BY st.trajectory_id DESC`,
      workspaceId,
      input.stateHash,
    ).toArray() as JsonRecord[];
    return rows.find((row) => !branchIds || branchIds.has(asNumber(row["trajectory_id"]))) ?? null;
  }

  blameGadFileSnippet(input: {
    workspaceId?: string | null;
    stateHash?: string | null;
    fileVersionId?: number | null;
    path: string;
    startLine?: number | null;
    endLine?: number | null;
  }): JsonRecord[] {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    let fileVersionId = input.fileVersionId ?? null;
    const path = normalizePath(input.path);
    if (fileVersionId == null && input.stateHash) {
      const file = this.readGadFileAtState({ workspaceId, stateHash: input.stateHash, path });
      fileVersionId = typeof file?.["file_version_id"] === "number" ? file["file_version_id"] : null;
    }
    if (fileVersionId == null) return [];
    let startLine = input.startLine ?? 1;
    let endLine = input.endLine ?? startLine;
    const lineage = this.fileLineageRows(workspaceId, path, fileVersionId);
    for (const row of lineage) {
      if (hunkOverlapsLineRange(row, startLine, endLine)) return [row];
      const previousRange = translateLineRangeBeforeHunk(row, startLine, endLine);
      if (!previousRange) return [];
      startLine = previousRange.startLine;
      endLine = previousRange.endLine;
    }
    return [];
  }

  getStatus(): { metric: string; value: number }[] {
    this.ensureReady();
    const count = (table: string) => asNumber(this.sql.exec(`SELECT COUNT(*) AS value FROM ${table}`).one()["value"]);
    return [
      { metric: "Branches", value: count("gad_branches") },
      { metric: "Trajectory items", value: count("gad_trajectory_items") },
      { metric: "State transitions", value: count("gad_state_transitions") },
      { metric: "File change hunks", value: count("gad_file_change_hunks") },
      { metric: "Payloads", value: count("gad_payloads") },
      { metric: "Blobs", value: count("gad_blobs") },
      { metric: "File versions", value: count("gad_file_versions") },
      { metric: "State roots", value: count("gad_state_roots") },
      { metric: "Index jobs", value: count("gad_index_jobs") },
    ];
  }

  private applyTrajectorySidecars(workspaceId: string, item: {
    hash: string;
    payloadHash: string | null;
    spec: GadTrajectoryItemSpec;
    inputStateHash: string | null;
    outputStateHash: string | null;
    stateTransition?: StateTransitionPlan;
  }, trajectoryId: number): void {
    const payload = item.payloadHash ? this.payloadFor(workspaceId, item.payloadHash) : {};
    if (item.stateTransition && item.inputStateHash && item.outputStateHash && item.inputStateHash !== item.outputStateHash) {
      this.sql.exec(
        `INSERT OR IGNORE INTO gad_state_transitions (
           workspace_id, trajectory_id, input_state_hash, output_state_hash
         ) VALUES (?, ?, ?, ?)`,
        workspaceId,
        trajectoryId,
        item.inputStateHash,
        item.outputStateHash,
      );
      this.recordFileProvenance(workspaceId, item, payload, trajectoryId);
    }
    if (item.spec.kind === "claim_asserted" || item.spec.kind === "claim_revised") {
      this.recordSemanticClaim(workspaceId, item, payload, trajectoryId);
    }
    if (item.spec.kind === "theory_updated") {
      this.recordTheoryUpdate(workspaceId, payload, trajectoryId);
    }
    if (item.spec.kind === "contradiction_detected") {
      this.recordContradiction(workspaceId, payload, trajectoryId);
    }
    void trajectoryId;
  }

  private recordSemanticClaim(workspaceId: string, item: { hash: string }, payload: JsonRecord, trajectoryId: number): void {
    const text = asString(payload["text"]);
    if (!text) return;
    const claimHash = asString(payload["claimHash"]) ?? item.hash.replace(/^trajectory:/u, "claim:");
    this.sql.exec(
      `INSERT INTO gad_claims (
         workspace_id, claim_hash, text, normalized_text, status, confidence, created_trajectory_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, claim_hash) DO UPDATE SET
         text = excluded.text,
         normalized_text = excluded.normalized_text,
         status = excluded.status,
         confidence = excluded.confidence`,
      workspaceId,
      claimHash,
      text,
      asString(payload["normalizedText"]) ?? text.toLowerCase(),
      asString(payload["status"]) ?? "active",
      typeof payload["confidence"] === "number" ? payload["confidence"] : null,
      trajectoryId,
    );
    const claimId = asNumber(this.sql.exec(
      `SELECT id FROM gad_claims WHERE workspace_id = ? AND claim_hash = ?`,
      workspaceId,
      claimHash,
    ).one()["id"]);
    const edges = Array.isArray(payload["edges"]) ? payload["edges"] : [];
    for (const edge of edges) {
      if (!edge || typeof edge !== "object") continue;
      const row = edge as JsonRecord;
      const targetType = asString(row["targetType"]);
      const targetId = asString(row["targetId"]);
      const relation = asString(row["relation"]);
      if (!targetType || !targetId || !relation) continue;
      this.sql.exec(
        `INSERT INTO gad_claim_edges (
           workspace_id, source_claim_id, target_type, target_id, relation, trajectory_id
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        workspaceId,
        claimId,
        targetType,
        targetId,
        relation,
        trajectoryId,
      );
    }
  }

  private recordTheoryUpdate(workspaceId: string, payload: JsonRecord, trajectoryId: number): void {
    const name = asString(payload["name"]);
    if (!name) return;
    this.sql.exec(
      `INSERT INTO gad_theories (workspace_id, name) VALUES (?, ?)
       ON CONFLICT(workspace_id, name) DO NOTHING`,
      workspaceId,
      name,
    );
    const theoryId = asNumber(this.sql.exec(
      `SELECT id FROM gad_theories WHERE workspace_id = ? AND name = ?`,
      workspaceId,
      name,
    ).one()["id"]);
    this.sql.exec(
      `INSERT INTO gad_theory_versions (
         workspace_id, theory_id, trajectory_id, parent_version_id, summary, status
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      workspaceId,
      theoryId,
      trajectoryId,
      typeof payload["parentVersionId"] === "number" ? payload["parentVersionId"] : null,
      asString(payload["summary"]),
      asString(payload["status"]) ?? "active",
    );
    const versionId = asNumber(this.sql.exec(`SELECT last_insert_rowid() AS id`).one()["id"]);
    this.sql.exec(
      `UPDATE gad_theories SET current_version_id = ? WHERE workspace_id = ? AND id = ?`,
      versionId,
      workspaceId,
      theoryId,
    );
  }

  private recordContradiction(workspaceId: string, payload: JsonRecord, trajectoryId: number): void {
    this.sql.exec(
      `INSERT INTO gad_contradictions (
         workspace_id, left_claim_id, right_claim_id, detected_trajectory_id, status, notes
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      workspaceId,
      typeof payload["leftClaimId"] === "number" ? payload["leftClaimId"] : null,
      typeof payload["rightClaimId"] === "number" ? payload["rightClaimId"] : null,
      trajectoryId,
      asString(payload["status"]) ?? "open",
      asString(payload["notes"]),
    );
  }

  private recordFileProvenance(workspaceId: string, item: {
    hash: string;
    spec: GadTrajectoryItemSpec;
    stateTransition?: StateTransitionPlan;
  }, payload: JsonRecord, trajectoryId: number): void {
    const transition = item.stateTransition;
    if (!transition?.newFile && asString(payload["operation"]) !== "delete") return;
    const path = transition.newFile?.path ?? asString(payload["path"]);
    if (!path) return;
    const oldString = asString(payload["oldString"]);
    const newString = asString(payload["newString"]);
    const beforeText = asString(payload["beforeText"]);
    const afterText = asString(payload["afterText"]);
    const oldStartLine = lineForSubstring(beforeText, oldString) ?? (oldString != null ? 1 : null);
    const newStartLine = lineForSubstring(afterText, newString) ?? (newString != null ? 1 : null);
    const oldLineCount = textLineCount(oldString);
    const newLineCount = textLineCount(newString);
    this.sql.exec(
      `INSERT INTO gad_file_change_hunks (
         workspace_id, trajectory_id, path, before_file_version_id, after_file_version_id,
         old_start_line, old_line_count, new_start_line, new_line_count,
         old_start_byte, old_byte_count, new_start_byte, new_byte_count,
         old_text_hash, new_text_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workspaceId,
      trajectoryId,
      path,
      transition.oldFile?.fileVersionId ?? null,
      transition.newFileVersionId ?? null,
      oldStartLine,
      oldLineCount,
      newStartLine,
      newLineCount,
      null,
      byteLength(oldString),
      null,
      byteLength(newString),
      asString(payload["beforeHash"]) ?? null,
      asString(payload["afterHash"]) ?? asString(payload["contentHash"]) ?? null,
    );
  }

  private payloadFor(workspaceId: string, payloadHash: string | null): JsonRecord {
    if (!payloadHash) return {};
    const row = this.sql.exec(
      `SELECT kind, json, text FROM gad_payloads WHERE workspace_id = ? AND hash = ?`,
      workspaceId,
      payloadHash,
    ).toArray()[0] as JsonRecord | undefined;
    if (!row) return {};
    if (row["json"]) return parseJsonRecord(JSON.parse(row["json"] as string));
    if (row["text"]) return { text: row["text"] as string };
    return {};
  }

  private materializePiMessagesFromTrajectory(workspaceId: string, rows: JsonRecord[]): JsonRecord[] {
    type PendingMessage = {
      idx: number;
      message: JsonRecord;
      blocks: Array<{ idx: number; block: JsonValue }>;
      toolResultOverride?: JsonRecord;
    };
    const byId = new Map<string, PendingMessage>();
    let nextIdx = 0;
    const entryFor = (messageId: string, fallbackRole: string, createdAt: string | null): PendingMessage => {
      const existing = byId.get(messageId);
      if (existing) return existing;
      const timestamp = createdAt ? Date.parse(createdAt) : NaN;
      const message: JsonRecord = { role: fallbackRole, content: [] };
      if (Number.isFinite(timestamp)) message["timestamp"] = timestamp;
      const entry = { idx: nextIdx++, message, blocks: [] };
      byId.set(messageId, entry);
      return entry;
    };

    for (const row of rows) {
      const kind = asString(row["kind"]);
      const messageId = asString(row["message_id"]);
      const toolCallId = asString(row["tool_call_id"]);
      const actor = asString(row["actor"]) ?? "assistant";
      const payload = this.payloadFor(workspaceId, asString(row["payload_hash"]));
      const createdAt = asString(row["created_at"]);

      if (kind === "message_created" && messageId) {
        const role = asString(payload["role"]) ?? actor;
        const entry = entryFor(messageId, role, createdAt);
        entry.message["role"] = role;
        entry.idx = typeof payload["messageIndex"] === "number" ? payload["messageIndex"] : entry.idx;
        if (typeof payload["timestamp"] === "number") entry.message["timestamp"] = payload["timestamp"];
        if (payload["details"] != null) entry.message["details"] = payload["details"];
        continue;
      }

      if (kind === "message_block_added" && messageId) {
        const entry = entryFor(messageId, actor, createdAt);
        const block = payload["block"];
        if (block != null) {
          entry.blocks.push({
            idx: typeof payload["blockIndex"] === "number" ? payload["blockIndex"] : entry.blocks.length,
            block,
          });
        }
        continue;
      }

      if (kind === "message_finalized" && messageId) {
        const entry = entryFor(messageId, actor, createdAt);
        if (payload["stopReason"] != null) entry.message["stopReason"] = payload["stopReason"];
        if (payload["errorMessage"] != null) entry.message["errorMessage"] = payload["errorMessage"];
        continue;
      }

      if (kind === "tool_result_observed") {
        const payloadToolCallId = toolCallId ?? asString(payload["toolCallId"]);
        const id = messageId ?? (payloadToolCallId ? `tool-result:${payloadToolCallId}` : null);
        if (!id) continue;
        const content = Array.isArray(payload["content"])
          ? payload["content"] as JsonValue[]
          : [{ type: "text", text: asString(payload["summary"]) ?? "" }];
        const message: JsonRecord = {
          role: "toolResult",
          toolCallId: payloadToolCallId ?? "",
          toolName: asString(payload["toolName"]) ?? "unknown",
          content,
          isError: payload["isError"] === true,
        };
        if (typeof payload["timestamp"] === "number") message["timestamp"] = payload["timestamp"];
        if (payload["details"] != null) message["details"] = payload["details"];
        const entry = entryFor(id, "toolResult", createdAt);
        entry.toolResultOverride = message;
      }
    }

    return [...byId.values()]
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => {
        if (entry.toolResultOverride) return entry.toolResultOverride;
        entry.message["content"] = entry.blocks
          .sort((a, b) => a.idx - b.idx)
          .map((block) => block.block);
        return entry.message;
      });
  }

  private materializeToolCallsFromTrajectory(workspaceId: string, branchId: string, rows: JsonRecord[]): JsonRecord[] {
    const calls = new Map<string, JsonRecord>();
    for (const row of rows) {
      const kind = asString(row["kind"]);
      if (kind !== "tool_call_requested" && kind !== "tool_result_observed") continue;
      const payload = this.payloadFor(workspaceId, asString(row["payload_hash"]));
      const toolCallId = asString(row["tool_call_id"]) ?? asString(payload["toolCallId"]);
      if (!toolCallId) continue;
      const existing = calls.get(toolCallId) ?? {
        workspace_id: workspaceId,
        branch_id: branchId,
        tool_call_id: toolCallId,
        request_trajectory_id: null,
        request_trajectory_hash: null,
        result_trajectory_id: null,
        result_trajectory_hash: null,
        message_id: null,
        block_id: null,
        tool_name: null,
        provider_handle: null,
        parameters_json: null,
        status: "observed",
        result_summary: null,
        started_at: null,
        completed_at: null,
        source_trajectory_id: null,
      };

      if (kind === "tool_call_requested") {
        existing["request_trajectory_id"] = row["trajectory_id"] ?? null;
        existing["request_trajectory_hash"] = row["trajectory_hash"] ?? null;
        existing["message_id"] = row["message_id"] ?? existing["message_id"] ?? null;
        existing["block_id"] = row["block_id"] ?? existing["block_id"] ?? null;
        existing["tool_name"] = asString(payload["toolName"]) ?? toolNameFromBlock(payload["block"]) ?? existing["tool_name"] ?? null;
        existing["provider_handle"] = asString(payload["providerHandle"]) ?? existing["provider_handle"] ?? null;
        existing["parameters_json"] = json(payload["parameters"] ?? null);
        existing["status"] = "requested";
        existing["started_at"] = row["created_at"] ?? null;
      } else {
        existing["result_trajectory_id"] = row["trajectory_id"] ?? null;
        existing["result_trajectory_hash"] = row["trajectory_hash"] ?? null;
        existing["message_id"] = row["message_id"] ?? existing["message_id"] ?? null;
        existing["block_id"] = row["block_id"] ?? existing["block_id"] ?? null;
        existing["tool_name"] = asString(payload["toolName"]) ?? existing["tool_name"] ?? null;
        existing["status"] = payload["isError"] === true ? "error" : "complete";
        existing["result_summary"] = asString(payload["summary"]);
        existing["completed_at"] = row["created_at"] ?? null;
      }
      existing["source_trajectory_id"] = existing["result_trajectory_id"] ?? existing["request_trajectory_id"];
      calls.set(toolCallId, existing);
    }
    return [...calls.values()];
  }

  private async prepareStateTransition(
    workspaceId: string,
    currentStateHash: string,
    spec: GadTrajectoryItemSpec,
    baseFiles?: ManifestFileEntry[],
  ): Promise<StateTransitionPlan | null> {
    if (spec.kind !== "file_observed" && spec.kind !== "file_mutation" && spec.kind !== "workspace_observed") {
      return null;
    }
    const payload = typeof spec.payload === "object" && spec.payload != null ? spec.payload as JsonRecord : {};
    const rawPath = asString(payload["path"]);
    if (!rawPath) return null;
    const path = normalizePath(rawPath);
    const operation = asString(payload["operation"]) ?? spec.kind;
    const contentHash = asString(payload["afterHash"]) ?? asString(payload["contentHash"]);
    const mode = typeof payload["mode"] === "number" ? payload["mode"] : null;

    const files: ManifestFileEntry[] = baseFiles ?? this.filesForState(workspaceId, currentStateHash).flatMap((file) => {
      const existingContentHash = asString(file["content_hash"]);
      if (!existingContentHash) return [];
      return [{
        path: String(file["path"]),
        fileVersionId: typeof file["file_version_id"] === "number" ? file["file_version_id"] : null,
        contentHash: existingContentHash,
        mode: typeof file["mode"] === "number" ? file["mode"] : null,
      }];
    });
    const next = new Map<string, ManifestFileEntry>();
    for (const file of files) {
      next.set(file.path, file);
    }
    const oldFile = next.get(path) ?? null;
    let newFile: { path: string; contentHash: string; mode: number | null } | null = null;
    if (operation === "delete") {
      next.delete(path);
    } else if (contentHash) {
      newFile = { path, contentHash, mode };
      next.set(path, { path, fileVersionId: null, contentHash, mode });
    } else {
      return null;
    }
    const entries: ManifestFileEntry[] = [...next.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value);
    const tree = await this.buildManifestTree(entries);
    const rootHash = tree.rootHash;
    const stateHash = await sha256("state", { manifestRootHash: rootHash });
    return { rootHash, stateHash, nodes: tree.nodes, files: entries, oldFile, newFile };
  }

  private filesForState(workspaceId: string, stateHash: string): JsonRecord[] {
    const rootHash = this.manifestRootForState(workspaceId, stateHash);
    if (!rootHash) return [];
    const out: JsonRecord[] = [];
    this.collectManifestFiles(workspaceId, rootHash, "", out, new Set());
    return out.sort((a, b) => String(a["path"]).localeCompare(String(b["path"])));
  }

  private manifestRootForState(workspaceId: string, stateHash: string): string | null {
    const state = this.sql.exec(
      `SELECT manifest_root_hash FROM gad_state_roots WHERE workspace_id = ? AND state_hash = ?`,
      workspaceId,
      stateHash,
    ).toArray()[0] as JsonRecord | undefined;
    return asString(state?.["manifest_root_hash"]);
  }

  private readManifestFile(workspaceId: string, rootHash: string, path: string): JsonRecord | null {
    const parts = path.split("/");
    let parentHash = rootHash;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const entry = this.sql.exec(
        `SELECT name, entry_kind, child_manifest_hash, file_version_id
         FROM gad_manifest_entries
         WHERE workspace_id = ? AND parent_hash = ? AND name = ?`,
        workspaceId,
        parentHash,
        name,
      ).toArray()[0] as JsonRecord | undefined;
      if (!entry) return null;
      const last = i === parts.length - 1;
      if (last) {
        return entry["entry_kind"] === "file" ? this.fileRecordForEntry(workspaceId, entry, path) : null;
      }
      if (entry["entry_kind"] !== "dir") return null;
      const childHash = asString(entry["child_manifest_hash"]);
      if (!childHash) return null;
      parentHash = childHash;
    }
    return null;
  }

  private diffManifestNodes(
    workspaceId: string,
    leftHash: string | null,
    rightHash: string | null,
    prefix: string,
    added: JsonRecord[],
    removed: JsonRecord[],
    changed: JsonRecord[],
  ): void {
    if (leftHash === rightHash) return;
    if (!leftHash && rightHash) {
      this.collectManifestFiles(workspaceId, rightHash, prefix, added, new Set());
      return;
    }
    if (leftHash && !rightHash) {
      this.collectManifestFiles(workspaceId, leftHash, prefix, removed, new Set());
      return;
    }
    if (!leftHash || !rightHash) return;

    const left = new Map(this.manifestEntryRows(workspaceId, leftHash).map((row) => [String(row["name"]), row]));
    const right = new Map(this.manifestEntryRows(workspaceId, rightHash).map((row) => [String(row["name"]), row]));
    const names = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      const l = left.get(name);
      const r = right.get(name);
      if (!l && r) {
        if (r["entry_kind"] === "dir") this.diffManifestNodes(workspaceId, null, asString(r["child_manifest_hash"]), path, added, removed, changed);
        else {
          const file = this.fileRecordForEntry(workspaceId, r, path);
          if (file) added.push(file);
        }
        continue;
      }
      if (l && !r) {
        if (l["entry_kind"] === "dir") this.diffManifestNodes(workspaceId, asString(l["child_manifest_hash"]), null, path, added, removed, changed);
        else {
          const file = this.fileRecordForEntry(workspaceId, l, path);
          if (file) removed.push(file);
        }
        continue;
      }
      if (!l || !r) continue;
      if (l["entry_kind"] !== r["entry_kind"]) {
        if (l["entry_kind"] === "dir") this.diffManifestNodes(workspaceId, asString(l["child_manifest_hash"]), null, path, added, removed, changed);
        else {
          const file = this.fileRecordForEntry(workspaceId, l, path);
          if (file) removed.push(file);
        }
        if (r["entry_kind"] === "dir") this.diffManifestNodes(workspaceId, null, asString(r["child_manifest_hash"]), path, added, removed, changed);
        else {
          const file = this.fileRecordForEntry(workspaceId, r, path);
          if (file) added.push(file);
        }
        continue;
      }
      if (l["entry_kind"] === "dir") {
        this.diffManifestNodes(
          workspaceId,
          asString(l["child_manifest_hash"]),
          asString(r["child_manifest_hash"]),
          path,
          added,
          removed,
          changed,
        );
      } else {
        const leftFile = this.fileRecordForEntry(workspaceId, l, path);
        const rightFile = this.fileRecordForEntry(workspaceId, r, path);
        if (leftFile && rightFile && (
          leftFile["content_hash"] !== rightFile["content_hash"] ||
          leftFile["mode"] !== rightFile["mode"]
        )) {
          changed.push({
            path,
            before: leftFile["content_hash"] ?? null,
            after: rightFile["content_hash"] ?? null,
            beforeMode: leftFile["mode"] ?? null,
            afterMode: rightFile["mode"] ?? null,
          });
        }
      }
    }
  }

  private async buildManifestTree(files: ManifestFileEntry[]): Promise<{ rootHash: string; nodes: ManifestNodePlan[] }> {
    interface MutableDir {
      dirs: Map<string, MutableDir>;
      files: Map<string, ManifestFileEntry>;
    }
    const root: MutableDir = { dirs: new Map(), files: new Map() };
    for (const file of files) {
      const parts = file.path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let child = dir.dirs.get(part);
        if (!child) {
          child = { dirs: new Map(), files: new Map() };
          dir.dirs.set(part, child);
        }
        dir = child;
      }
      dir.files.set(parts[parts.length - 1]!, file);
    }

    const nodes: ManifestNodePlan[] = [];
    const build = async (dir: MutableDir, prefix: string): Promise<string> => {
      const childDirs: Array<{ name: string; hash: string }> = [];
      for (const [name, child] of [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        childDirs.push({ name, hash: await build(child, prefix ? `${prefix}/${name}` : name) });
      }
      const fileEntries = [...dir.files.entries()].sort(([a], [b]) => a.localeCompare(b));
      const hashEntries = [
        ...childDirs.map((entry) => ({ name: entry.name, kind: "dir", childManifestHash: entry.hash })),
        ...fileEntries.map(([name, file]) => ({
          name,
          kind: "file",
          contentHash: file.contentHash,
          mode: file.mode,
        })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      const hash = await sha256("manifest", { kind: "dir", entries: hashEntries });
      const nodeEntries: ManifestEntryPlan[] = [
        ...childDirs.map((entry) => ({
          parentHash: hash,
          name: entry.name,
          entryKind: "dir" as const,
          childManifestHash: entry.hash,
          fileVersionId: null,
          path: null,
        })),
        ...fileEntries.map(([name, file]) => ({
          parentHash: hash,
          name,
          entryKind: "file" as const,
          childManifestHash: null,
          fileVersionId: file.fileVersionId,
          path: file.path,
        })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      nodes.push({ hash, entries: nodeEntries });
      void prefix;
      return hash;
    };

    const rootHash = await build(root, "");
    return { rootHash, nodes };
  }

  private collectManifestFiles(
    workspaceId: string,
    manifestHash: string,
    prefix: string,
    out: JsonRecord[],
    seen: Set<string>,
  ): void {
    if (seen.has(manifestHash)) return;
    seen.add(manifestHash);
    for (const entry of this.manifestEntryRows(workspaceId, manifestHash)) {
      const name = String(entry["name"]);
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry["entry_kind"] === "dir") {
        const childHash = asString(entry["child_manifest_hash"]);
        if (childHash) this.collectManifestFiles(workspaceId, childHash, path, out, seen);
      } else if (entry["entry_kind"] === "file") {
        const file = this.fileRecordForEntry(workspaceId, entry, path);
        if (file) out.push(file);
      }
    }
    seen.delete(manifestHash);
  }

  private manifestEntryRows(workspaceId: string, parentHash: string): JsonRecord[] {
    return this.sql.exec(
      `SELECT name, entry_kind, child_manifest_hash, file_version_id
       FROM gad_manifest_entries
       WHERE workspace_id = ? AND parent_hash = ?
       ORDER BY name`,
      workspaceId,
      parentHash,
    ).toArray() as JsonRecord[];
  }

  private fileRecordForEntry(workspaceId: string, entry: JsonRecord, path: string): JsonRecord | null {
    const fileVersionId = entry["file_version_id"];
    if (typeof fileVersionId !== "number") return null;
    const row = this.sql.exec(
      `SELECT id AS file_version_id, path, content_hash, mode, created_at
       FROM gad_file_versions
       WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      fileVersionId,
    ).toArray()[0] as JsonRecord | undefined;
    if (!row) return null;
    return { ...row, path };
  }

  private ensureEmptyStateRoot(workspaceId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_manifest_nodes (workspace_id, hash, kind) VALUES (?, ?, 'dir')`,
      workspaceId,
      EMPTY_MANIFEST_HASH,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_state_roots (workspace_id, state_hash, manifest_root_hash, metadata_json)
       VALUES (?, ?, ?, ?)`,
      workspaceId,
      EMPTY_STATE_HASH,
      EMPTY_MANIFEST_HASH,
      JSON.stringify({ empty: true }),
    );
  }

  private enqueueIndexJob(workspaceId: string, sourceHash: string, sourceKind: string, jobKind: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_index_jobs (workspace_id, source_hash, source_kind, job_kind)
       VALUES (?, ?, ?, ?)`,
      workspaceId,
      sourceHash,
      sourceKind,
      jobKind,
    );
  }

  private markDirty(workspaceId: string): void {
    this.sql.exec(`UPDATE gad_branches SET dirty = 1 WHERE workspace_id = ?`, workspaceId);
  }

  private transaction<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }
}

export default {
  async fetch(_request: Request) {
    return new Response("gad immutable workspace durable-object service", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
