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
  "gad_history_items",
  "gad_branches",
  "gad_branch_history_view",
]);

export type GadHistoryKind =
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
  | "system_event";

export interface GadHistoryItemSpec {
  kind: GadHistoryKind;
  actor?: string | null;
  payload?: JsonRecord | string | null;
  messageId?: string | null;
  blockId?: string | null;
  toolCallId?: string | null;
  inputStateHash?: string | null;
  outputStateHash?: string | null;
  metadata?: JsonRecord | null;
}

export interface AppendGadHistoryBatchInput {
  workspaceId?: string | null;
  branchId: string;
  expectedHeadHash?: string | null;
  expectedStateHash?: string | null;
  items: GadHistoryItemSpec[];
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
  historyHash?: string | null;
  historyId?: number | null;
  channelId?: string | null;
  contextId?: string | null;
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
  newFile: { path: string; contentHash: string; mode: number | null } | null;
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

function contentTextFromBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const item = block as Record<string, unknown>;
  if (typeof item["text"] === "string") return item["text"];
  if (typeof item["thinking"] === "string") return item["thinking"];
  return "";
}

function blockType(block: unknown): string {
  if (typeof block === "string") return "text";
  if (!block || typeof block !== "object") return "unknown";
  return asString((block as Record<string, unknown>)["type"]) ?? "object";
}

function messageRole(message: JsonRecord): string {
  return asString(message["role"]) ?? "unknown";
}

function messageBlocks(message: JsonRecord): unknown[] {
  const content = message["content"];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function toolCallIdFromBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const item = block as Record<string, unknown>;
  return asString(item["id"]) ?? asString(item["toolCallId"]) ?? null;
}

function toolNameFromBlock(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const item = block as Record<string, unknown>;
  return asString(item["name"]) ?? asString(item["toolName"]) ?? null;
}

export class GadWorkspaceDO extends DurableObjectBase {
  static override schemaVersion = 4;

  constructor(ctx: ConstructorParameters<typeof DurableObjectBase>[0], env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.createImmutableTables();
  }

  protected override migrate(_fromVersion: number, _toVersion: number): void {
    this.dropOldTables();
    this.createImmutableTables();
  }

  private dropOldTables(): void {
    for (const table of [
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
      "gad_branch_history_view",
      "pi_messages_view",
      "pi_message_blocks_view",
      "gad_tool_calls_view",
      "gad_file_activity_view",
      "gad_index_jobs",
      "gad_history_items",
      "gad_branches",
      "gad_state_roots",
      "gad_manifest_entries",
      "gad_manifest_nodes",
      "gad_file_versions",
      "gad_payloads",
      "gad_blobs",
    ]) {
      this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
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
        forked_from_history_id INTEGER,
        forked_from_state_hash TEXT,
        head_history_id INTEGER,
        head_history_hash TEXT,
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
      CREATE TABLE IF NOT EXISTS gad_history_items (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        parent_id INTEGER,
        parent_hash TEXT,
        branch_id TEXT,
        kind TEXT NOT NULL,
        actor TEXT,
        payload_hash TEXT,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        message_id TEXT,
        block_id TEXT,
        tool_call_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT,
        UNIQUE (workspace_id, hash)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_history_branch ON gad_history_items(workspace_id, branch_id, id)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_gad_history_tool_call ON gad_history_items(workspace_id, branch_id, tool_call_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_branch_history_view (
        workspace_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        history_id INTEGER NOT NULL,
        history_hash TEXT NOT NULL,
        parent_hash TEXT,
        kind TEXT NOT NULL,
        actor TEXT,
        message_id TEXT,
        block_id TEXT,
        tool_call_id TEXT,
        input_state_hash TEXT NOT NULL,
        output_state_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, branch_id, history_hash)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_messages_view (
        workspace_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        finalized INTEGER NOT NULL DEFAULT 0,
        source_head_hash TEXT,
        source_history_id INTEGER,
        PRIMARY KEY (workspace_id, branch_id, message_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_message_blocks_view (
        workspace_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        block_idx INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        text TEXT,
        json TEXT,
        source_history_id INTEGER,
        source_history_hash TEXT,
        PRIMARY KEY (workspace_id, branch_id, message_id, block_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_tool_calls_view (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        message_id TEXT,
        block_id TEXT,
        tool_name TEXT,
        provider_handle TEXT,
        parameters_json TEXT,
        status TEXT NOT NULL DEFAULT 'requested',
        result_summary TEXT,
        requested_history_hash TEXT,
        completed_history_hash TEXT,
        source_history_id INTEGER,
        UNIQUE (workspace_id, branch_id, tool_call_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gad_file_activity_view (
        id INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        branch_id TEXT,
        history_hash TEXT NOT NULL,
        history_id INTEGER NOT NULL,
        operation TEXT NOT NULL,
        path TEXT,
        before_hash TEXT,
        after_hash TEXT,
        input_state_hash TEXT,
        output_state_hash TEXT,
        metadata_json TEXT
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
    headHistoryId: number | null;
    headHistoryHash: string | null;
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
    headHistoryId: number | null;
    headHistoryHash: string | null;
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
      headHistoryId: row["head_history_id"] == null ? null : asNumber(row["head_history_id"]),
      headHistoryHash: asString(row["head_history_hash"]),
      headStateHash: asString(row["head_state_hash"]) ?? EMPTY_STATE_HASH,
      dirty: row["dirty"] === 1,
    };
  }

  async appendGadHistoryBatch(input: AppendGadHistoryBatchInput): Promise<{
    workspaceId: string;
    branchId: string;
    headHistoryId: number | null;
    headHistoryHash: string | null;
    headStateHash: string;
    items: Array<{ id: number; hash: string; inputStateHash: string; outputStateHash: string }>;
  }> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const branch = this.getGadBranchHead({ workspaceId, branchId: input.branchId });
    if (branch.dirty) throw new Error(`gad branch ${input.branchId} is dirty; validate before appending`);
    const branchId = branch.branchId;
    if ("expectedHeadHash" in input && (input.expectedHeadHash ?? null) !== branch.headHistoryHash) {
      throw new Error("gad head conflict");
    }
    if ("expectedStateHash" in input && (input.expectedStateHash ?? null) !== branch.headStateHash) {
      throw new Error("gad state conflict");
    }

    let parentHash = branch.headHistoryHash;
    let parentId = branch.headHistoryId;
    let currentState = branch.headStateHash;
    let currentFiles: ManifestFileEntry[] | null = null;
    const prepared: Array<{
      hash: string;
      payloadHash: string | null;
      payloadKind: string | null;
      payloadJson: string | null;
      payloadText: string | null;
      spec: GadHistoryItemSpec;
      inputStateHash: string;
      outputStateHash: string;
      parentHash: string | null;
      parentId: number | null;
      stateTransition?: StateTransitionPlan;
    }> = [];

    for (const spec of input.items) {
      const itemInputState = spec.inputStateHash ?? currentState;
      if (itemInputState !== currentState) throw new Error(`Invalid state transition for ${spec.kind}`);
      const stateTransition = await this.prepareStateTransition(workspaceId, currentState, spec, currentFiles ?? undefined);
      const itemOutputState = spec.outputStateHash ?? stateTransition?.stateHash ?? currentState;
      const payload = spec.payload ?? null;
      const payloadKind = typeof payload === "string" ? "text" : spec.kind;
      const payloadHash = payload == null ? null : await sha256("payload", { kind: payloadKind, payload });
      const hash = await sha256("history", {
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
        stateTransition: stateTransition ?? undefined,
      });
      parentHash = hash;
      parentId = null;
      currentState = itemOutputState;
      if (stateTransition) currentFiles = stateTransition.files;
    }

    const created: Array<{ id: number; hash: string; inputStateHash: string; outputStateHash: string }> = [];
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
          this.sql.exec(
            `INSERT OR IGNORE INTO gad_state_roots (workspace_id, state_hash, manifest_root_hash, metadata_json)
             VALUES (?, ?, ?, ?)`,
            workspaceId,
            item.stateTransition.stateHash,
            item.stateTransition.rootHash,
            JSON.stringify({ source: "history", kind: item.spec.kind }),
          );
        }
        this.sql.exec(
          `INSERT INTO gad_history_items (
             workspace_id, hash, parent_id, parent_hash, branch_id, kind, actor,
             payload_hash, input_state_hash, output_state_hash, message_id, block_id, tool_call_id, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          workspaceId,
          item.hash,
          item.parentId,
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
        this.applyRuntimeReadModel(workspaceId, branchId, item, id);
      }
      const final = created.length > 0 ? created[created.length - 1] : undefined;
      const finalHeadId = final?.id ?? branch.headHistoryId;
      const finalHeadHash = final?.hash ?? branch.headHistoryHash;
      this.sql.exec(
        `UPDATE gad_branches
         SET head_history_id = ?, head_history_hash = ?, head_state_hash = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND head_history_hash IS ? AND head_state_hash = ?`,
        finalHeadId,
        finalHeadHash,
        currentState,
        nowIso(),
        workspaceId,
        branchId,
        branch.headHistoryHash,
        branch.headStateHash,
      );
      for (const item of created) this.enqueueIndexJob(workspaceId, item.hash, "history", "runtime-read-model");
    });

    return {
      workspaceId,
      branchId,
      headHistoryId: (created.length > 0 ? created[created.length - 1]?.id : undefined) ?? branch.headHistoryId,
      headHistoryHash: (created.length > 0 ? created[created.length - 1]?.hash : undefined) ?? branch.headHistoryHash,
      headStateHash: currentState,
      items: created,
    };
  }

  materializePiMessages(input: { workspaceId?: string | null; branchId: string }): { messages: JsonRecord[] } {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const rows = this.sql.exec(
      `SELECT message_json FROM pi_messages_view
       WHERE workspace_id = ? AND branch_id = ?
       ORDER BY idx`,
      workspaceId,
      input.branchId,
    ).toArray() as JsonRecord[];
    return { messages: rows.map((row) => JSON.parse(String(row["message_json"]))) };
  }

  listGadBranchHistory(input: { workspaceId?: string | null; branchId: string; limit?: number }): JsonRecord[] {
    this.ensureReady();
    return this.sql.exec(
      `SELECT * FROM gad_branch_history_view
       WHERE workspace_id = ? AND branch_id = ?
       ORDER BY history_id DESC LIMIT ?`,
      input.workspaceId ?? WORKSPACE_ID,
      input.branchId,
      input.limit ?? 200,
    ).toArray() as JsonRecord[];
  }

  forkGadBranch(input: ForkGadBranchInput): ReturnType<GadWorkspaceDO["getGadBranchHead"]> {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    const sourceBranch = this.getGadBranchHead({ workspaceId, branchId: input.sourceBranchId });
    const source = input.historyId != null
      ? this.sql.exec(`SELECT * FROM gad_history_items WHERE workspace_id = ? AND id = ?`, workspaceId, input.historyId).toArray()[0]
      : input.historyHash
        ? this.sql.exec(`SELECT * FROM gad_history_items WHERE workspace_id = ? AND hash = ?`, workspaceId, input.historyHash).toArray()[0]
        : null;
    const row = (source as JsonRecord | undefined) ?? null;
    if ((input.historyId != null || input.historyHash) && !row) throw new Error("Unknown fork history item");
    const forkHistoryId = row ? asNumber(row["id"]) : sourceBranch.headHistoryId;
    const forkHistoryHash = row ? asString(row["hash"]) : sourceBranch.headHistoryHash;
    const stateHash = (row ? asString(row["output_state_hash"]) : sourceBranch.headStateHash) ?? EMPTY_STATE_HASH;
    const branchId = input.newBranchId ?? `${input.sourceBranchId}:fork:${Date.now()}`;
    this.sql.exec(
      `INSERT INTO gad_branches (
         workspace_id, id, name, parent_branch_id, channel_id, context_id,
         forked_from_history_id, forked_from_state_hash, head_history_id,
         head_history_hash, head_state_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workspaceId,
      branchId,
      branchId,
      input.sourceBranchId,
      input.channelId ?? null,
      input.contextId ?? null,
      forkHistoryId,
      stateHash,
      forkHistoryId,
      forkHistoryHash,
      stateHash,
    );
    this.copyBranchReadModels(workspaceId, input.sourceBranchId, branchId, forkHistoryId);
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

  rebuildGadReadModels(input: { workspaceId?: string | null; branchId: string }): { messages: number } {
    const materialized = this.materializePiMessages(input);
    return { messages: materialized.messages.length };
  }

  listGadBranchToolCalls(input: { workspaceId?: string | null; branchId: string; limit?: number }): JsonRecord[] {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    return this.sql.exec(
      `SELECT * FROM gad_tool_calls_view
       WHERE workspace_id = ? AND branch_id = ?
       ORDER BY COALESCE(source_history_id, id) DESC LIMIT ?`,
      workspaceId,
      input.branchId,
      input.limit ?? 200,
    ).toArray() as JsonRecord[];
  }

  getGadToolProvenance(input: { workspaceId?: string | null; branchId: string; toolCallId: string }): JsonRecord | null {
    this.ensureReady();
    const workspaceId = input.workspaceId ?? WORKSPACE_ID;
    return (this.sql.exec(
      `SELECT * FROM gad_tool_calls_view
       WHERE workspace_id = ? AND branch_id = ? AND tool_call_id = ?`,
      workspaceId,
      input.branchId,
      input.toolCallId,
    ).toArray()[0] as JsonRecord | undefined) ?? null;
  }

  getStatus(): { metric: string; value: number }[] {
    this.ensureReady();
    const count = (table: string) => asNumber(this.sql.exec(`SELECT COUNT(*) AS value FROM ${table}`).one()["value"]);
    return [
      { metric: "Branches", value: count("gad_branches") },
      { metric: "History items", value: count("gad_history_items") },
      { metric: "Branch history rows", value: count("gad_branch_history_view") },
      { metric: "Payloads", value: count("gad_payloads") },
      { metric: "Blobs", value: count("gad_blobs") },
      { metric: "File versions", value: count("gad_file_versions") },
      { metric: "State roots", value: count("gad_state_roots") },
      { metric: "Index jobs", value: count("gad_index_jobs") },
    ];
  }

  private applyRuntimeReadModel(workspaceId: string, branchId: string, item: {
    hash: string;
    payloadHash: string | null;
    spec: GadHistoryItemSpec;
    inputStateHash: string;
    outputStateHash: string;
  }, historyId: number): void {
    const payload = item.payloadHash ? this.payloadFor(workspaceId, item.payloadHash) : {};
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_branch_history_view (
         workspace_id, branch_id, history_id, history_hash, parent_hash, kind,
         actor, message_id, block_id, tool_call_id, input_state_hash,
         output_state_hash, created_at
       ) SELECT workspace_id, ?, id, hash, parent_hash, kind, actor, message_id,
                block_id, tool_call_id, input_state_hash, output_state_hash, created_at
         FROM gad_history_items
         WHERE workspace_id = ? AND id = ?`,
      branchId,
      workspaceId,
      historyId,
    );
    const messageId = item.spec.messageId;
    if (item.spec.kind === "message_created" && messageId) {
      const idx = asNumber(this.sql.exec(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM pi_messages_view WHERE workspace_id = ? AND branch_id = ?`,
        workspaceId,
        branchId,
      ).one()["next"]);
      const role = asString(payload["role"]) ?? "assistant";
      this.sql.exec(
        `INSERT OR IGNORE INTO pi_messages_view (
           workspace_id, branch_id, message_id, idx, role, message_json, source_head_hash, source_history_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceId,
        branchId,
        messageId,
        idx,
        role,
        JSON.stringify({ role, content: [], timestamp: payload["timestamp"] ?? Date.now() }),
        item.hash,
        historyId,
      );
      return;
    }
    if (item.spec.kind === "message_block_added" && messageId && item.spec.blockId) {
      const block = payload["block"];
      const blockIdx = asNumber(this.sql.exec(
        `SELECT COALESCE(MAX(block_idx) + 1, 0) AS next
         FROM pi_message_blocks_view
         WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
        workspaceId,
        branchId,
        messageId,
      ).one()["next"]);
      this.sql.exec(
        `INSERT OR IGNORE INTO pi_message_blocks_view (
           workspace_id, branch_id, message_id, block_id, block_idx, block_type,
           tool_call_id, tool_name, text, json, source_history_id, source_history_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceId,
        branchId,
        messageId,
        item.spec.blockId,
        blockIdx,
        blockType(block),
        toolCallIdFromBlock(block),
        toolNameFromBlock(block),
        contentTextFromBlock(block),
        json(block),
        historyId,
        item.hash,
      );
      this.refreshMessageView(workspaceId, branchId, messageId);
      return;
    }
    if (item.spec.kind === "message_finalized" && messageId) {
      this.sql.exec(
        `UPDATE pi_messages_view
         SET finalized = 1, source_head_hash = ?, source_history_id = ?
         WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
        item.hash,
        historyId,
        workspaceId,
        branchId,
        messageId,
      );
      return;
    }
    if (item.spec.kind === "tool_call_requested") {
      this.sql.exec(
        `INSERT INTO gad_tool_calls_view (
           workspace_id, branch_id, tool_call_id, message_id, block_id, tool_name,
           provider_handle, parameters_json, status, requested_history_hash, source_history_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)
         ON CONFLICT(workspace_id, branch_id, tool_call_id) DO UPDATE SET
           status = 'requested',
           requested_history_hash = excluded.requested_history_hash,
           source_history_id = excluded.source_history_id`,
        workspaceId,
        branchId,
        item.spec.toolCallId,
        item.spec.messageId ?? null,
        item.spec.blockId ?? null,
        asString(payload["toolName"]) ?? toolNameFromBlock(payload["block"]),
        asString(payload["providerHandle"]),
        json(payload["parameters"] ?? null),
        item.hash,
        historyId,
      );
      return;
    }
    if (item.spec.kind === "tool_result_observed") {
      const toolCallId = item.spec.toolCallId ?? asString(payload["toolCallId"]);
      if (!toolCallId) return;
      this.sql.exec(
        `INSERT INTO gad_tool_calls_view (
           workspace_id, branch_id, tool_call_id, message_id, block_id, tool_name,
           status, result_summary, completed_history_hash, source_history_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, branch_id, tool_call_id) DO UPDATE SET
           status = excluded.status,
           result_summary = excluded.result_summary,
           completed_history_hash = excluded.completed_history_hash,
         source_history_id = excluded.source_history_id`,
        workspaceId,
        branchId,
        toolCallId,
        item.spec.messageId ?? null,
        item.spec.blockId ?? null,
        asString(payload["toolName"]),
        payload["isError"] === true ? "error" : "complete",
        asString(payload["summary"]),
        item.hash,
        historyId,
      );
      this.upsertToolResultMessageView(workspaceId, branchId, item, payload, historyId);
      return;
    }
    if (item.spec.kind === "file_read" || item.spec.kind === "file_observed" || item.spec.kind === "file_mutation") {
      this.sql.exec(
        `INSERT INTO gad_file_activity_view (
           workspace_id, branch_id, history_hash, history_id, operation, path,
           before_hash, after_hash, input_state_hash, output_state_hash, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceId,
        branchId,
        item.hash,
        historyId,
        item.spec.kind,
        payload["path"] ?? null,
        payload["beforeHash"] ?? null,
        payload["afterHash"] ?? payload["contentHash"] ?? null,
        item.inputStateHash,
        item.outputStateHash,
        json(payload),
      );
    }
    void historyId;
  }

  private refreshMessageView(workspaceId: string, branchId: string, messageId: string): void {
    const row = this.sql.exec(
      `SELECT role, idx, message_json FROM pi_messages_view WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
      workspaceId,
      branchId,
      messageId,
    ).toArray()[0] as JsonRecord | undefined;
    if (!row) return;
    const blocks = this.sql.exec(
      `SELECT json FROM pi_message_blocks_view
       WHERE workspace_id = ? AND branch_id = ? AND message_id = ?
       ORDER BY block_idx`,
      workspaceId,
      branchId,
      messageId,
    ).toArray() as JsonRecord[];
    const message = JSON.parse(row["message_json"] as string) as JsonRecord;
    message["content"] = blocks.map((block) => JSON.parse(block["json"] as string));
    this.sql.exec(
      `UPDATE pi_messages_view SET message_json = ? WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
      JSON.stringify(message),
      workspaceId,
      branchId,
      messageId,
    );
  }

  private upsertToolResultMessageView(workspaceId: string, branchId: string, item: {
    hash: string;
    spec: GadHistoryItemSpec;
  }, payload: JsonRecord, historyId: number): void {
    const toolCallId = item.spec.toolCallId ?? asString(payload["toolCallId"]);
    if (!toolCallId) return;
    const messageId = item.spec.messageId ?? `tool-result:${toolCallId}`;
    const existing = this.sql.exec(
      `SELECT idx FROM pi_messages_view WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
      workspaceId,
      branchId,
      messageId,
    ).toArray()[0] as JsonRecord | undefined;
    const idx = existing
      ? asNumber(existing["idx"])
      : asNumber(this.sql.exec(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM pi_messages_view WHERE workspace_id = ? AND branch_id = ?`,
        workspaceId,
        branchId,
      ).one()["next"]);
    const content = Array.isArray(payload["content"])
      ? payload["content"] as JsonValue[]
      : [{ type: "text", text: asString(payload["summary"]) ?? "" }];
    const message: JsonRecord = {
      role: "toolResult",
      toolCallId,
      toolName: asString(payload["toolName"]) ?? "unknown",
      content,
      timestamp: typeof payload["timestamp"] === "number" ? payload["timestamp"] : Date.now(),
      isError: payload["isError"] === true,
    };
    if (payload["details"] != null) message["details"] = payload["details"];
    this.sql.exec(
      `INSERT INTO pi_messages_view (
         workspace_id, branch_id, message_id, idx, role, message_json, finalized, source_head_hash, source_history_id
       ) VALUES (?, ?, ?, ?, 'toolResult', ?, 1, ?, ?)
       ON CONFLICT(workspace_id, branch_id, message_id) DO UPDATE SET
         role = 'toolResult',
         message_json = excluded.message_json,
         finalized = 1,
         source_head_hash = excluded.source_head_hash,
         source_history_id = excluded.source_history_id`,
      workspaceId,
      branchId,
      messageId,
      idx,
      JSON.stringify(message),
      item.hash,
      historyId,
    );
    this.sql.exec(
      `DELETE FROM pi_message_blocks_view WHERE workspace_id = ? AND branch_id = ? AND message_id = ?`,
      workspaceId,
      branchId,
      messageId,
    );
    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
      const block = content[blockIdx]!;
      this.sql.exec(
        `INSERT OR IGNORE INTO pi_message_blocks_view (
           workspace_id, branch_id, message_id, block_id, block_idx, block_type,
           tool_call_id, tool_name, text, json, source_history_id, source_history_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workspaceId,
        branchId,
        messageId,
        `${messageId}:block:${blockIdx}`,
        blockIdx,
        blockType(block),
        toolCallId,
        asString(payload["toolName"]) ?? "unknown",
        contentTextFromBlock(block),
        json(block),
        historyId,
        item.hash,
      );
    }
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

  private copyBranchReadModels(workspaceId: string, sourceBranchId: string, targetBranchId: string, throughHistoryId: number | null): void {
    const through = throughHistoryId ?? Number.MAX_SAFE_INTEGER;
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_branch_history_view
       SELECT workspace_id, ?, history_id, history_hash, parent_hash, kind, actor,
              message_id, block_id, tool_call_id, input_state_hash, output_state_hash, created_at
       FROM gad_branch_history_view
       WHERE workspace_id = ? AND branch_id = ? AND history_id <= ?`,
      targetBranchId,
      workspaceId,
      sourceBranchId,
      through,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO pi_messages_view
       SELECT workspace_id, ?, message_id, idx, role, message_json, finalized, source_head_hash, source_history_id
       FROM pi_messages_view
       WHERE workspace_id = ? AND branch_id = ? AND COALESCE(source_history_id, 0) <= ?`,
      targetBranchId,
      workspaceId,
      sourceBranchId,
      through,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO pi_message_blocks_view
       SELECT workspace_id, ?, message_id, block_id, block_idx, block_type, tool_call_id,
              tool_name, text, json, source_history_id, source_history_hash
       FROM pi_message_blocks_view
       WHERE workspace_id = ? AND branch_id = ? AND COALESCE(source_history_id, 0) <= ?`,
      targetBranchId,
      workspaceId,
      sourceBranchId,
      through,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO gad_tool_calls_view (
         workspace_id, branch_id, tool_call_id, message_id, block_id, tool_name,
         provider_handle, parameters_json, status, result_summary,
         requested_history_hash, completed_history_hash, source_history_id
       )
       SELECT workspace_id, ?, tool_call_id, message_id, block_id, tool_name,
              provider_handle, parameters_json, status, result_summary,
              requested_history_hash, completed_history_hash, source_history_id
       FROM gad_tool_calls_view
       WHERE workspace_id = ? AND branch_id = ? AND COALESCE(source_history_id, 0) <= ?`,
      targetBranchId,
      workspaceId,
      sourceBranchId,
      through,
    );
    this.sql.exec(
      `INSERT INTO gad_file_activity_view (
         workspace_id, branch_id, history_hash, history_id, operation, path,
         before_hash, after_hash, input_state_hash, output_state_hash, metadata_json
       )
       SELECT workspace_id, ?, history_hash, history_id, operation, path,
              before_hash, after_hash, input_state_hash, output_state_hash, metadata_json
       FROM gad_file_activity_view
       WHERE workspace_id = ? AND branch_id = ? AND history_id <= ?`,
      targetBranchId,
      workspaceId,
      sourceBranchId,
      through,
    );
  }

  private async prepareStateTransition(
    workspaceId: string,
    currentStateHash: string,
    spec: GadHistoryItemSpec,
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
    return { rootHash, stateHash, nodes: tree.nodes, files: entries, newFile };
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
