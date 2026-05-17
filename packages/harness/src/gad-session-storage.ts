/**
 * GadSessionStorage — `SessionStorage<GadSessionMetadata>` adapter over the
 * gad-store RPC surface.
 *
 * The adapter is the only thing that translates between upstream `Session`'s
 * `SessionTreeEntry` vocabulary and the gad envelope (`entryId`,
 * `parentEntryId`, `entryType`, `payload`). The two vocabularies are
 * isomorphic by design — see `Phase 1` of the plan and the payload-discipline
 * table — so each mapping function is a few lines.
 *
 * Concurrency model: every append goes through a per-instance promise chain
 * so concurrent `appendEntry`/`appendBatch` calls serialise. CAS conflicts
 * raised by `gad.appendGadTrajectoryBatch` are retried up to three times by
 * refreshing the branch head between attempts.
 */

import {
  uuidv7,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import type {
  GadAppendTrajectoryBatchInput,
  GadAppendTrajectoryBatchResult,
  GadBranchHead,
  GadEntryRow,
  GadEntryType,
  GadJsonRecord,
  GadTrajectoryItemSpec,
} from "./gad-types.js";

export type {
  GadEntryRow,
  GadEntryType,
  GadJsonRecord,
  GadTrajectoryItemSpec,
} from "./gad-types.js";

/** RPC caller signature accepted by the adapter. */
export interface GadRpcCaller {
  call<T = unknown>(target: string, method: string, ...args: unknown[]): Promise<T>;
}

export interface GadSessionMetadata extends SessionMetadata {
  workspaceId: string;
  branchId: string;
  channelId: string | null;
  contextId: string | null;
}

export interface GadSessionStorageOptions {
  rpc: GadRpcCaller;
  branchId: string;
  workspaceId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
  /**
   * Notified when an envelope payload coming out of the store cannot be
   * mapped back to a `SessionTreeEntry` shape (corrupt / unexpected
   * payload). The caller surfaces a user-visible card; the adapter still
   * throws so the read path aborts.
   */
  onTranscriptShapeError?: (err: TranscriptShapeError) => void;
}

export class TranscriptShapeError extends Error {
  readonly code = "transcript_shape" as const;
  constructor(message: string, public readonly entryId?: string) {
    super(message);
    this.name = "TranscriptShapeError";
  }
}

/**
 * Predicate identifying CAS conflicts thrown by `gad.appendGadTrajectoryBatch`
 * so the adapter can refresh-and-retry. Matches the messages the gad-store
 * raises today ("gad head conflict" / "gad state conflict").
 */
function isCasConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /gad (head|state) conflict/i.test(err.message);
}

const MAX_CAS_RETRIES = 3;

export class GadSessionStorage implements SessionStorage<GadSessionMetadata> {
  private readonly rpc: GadRpcCaller;
  private readonly workspaceId: string | null;
  private readonly branchId: string;
  private readonly channelId: string | null;
  private readonly contextId: string | null;
  private readonly onTranscriptShapeError?: (err: TranscriptShapeError) => void;
  private writeChain: Promise<void> = Promise.resolve();
  private metadataPromise: Promise<GadSessionMetadata> | null = null;

  constructor(opts: GadSessionStorageOptions) {
    this.rpc = opts.rpc;
    this.workspaceId = opts.workspaceId ?? null;
    this.branchId = opts.branchId;
    this.channelId = opts.channelId ?? null;
    this.contextId = opts.contextId ?? null;
    this.onTranscriptShapeError = opts.onTranscriptShapeError;
  }

  // ── SessionStorage<GadSessionMetadata> ───────────────────────────────────

  async getMetadata(): Promise<GadSessionMetadata> {
    if (!this.metadataPromise) {
      this.metadataPromise = (async () => {
        const head = await this.ensureBranch();
        return {
          id: this.branchId,
          createdAt: new Date().toISOString(),
          workspaceId: head.workspaceId,
          branchId: head.branchId,
          channelId: this.channelId,
          contextId: this.contextId,
        };
      })();
    }
    return this.metadataPromise;
  }

  async getLeafId(): Promise<string | null> {
    const head = await this.getHead();
    return head.headEntryId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    await this.serialise(async () => {
      await this.rpc.call("main", "gad.setBranchHead", {
        workspaceId: this.workspaceId,
        branchId: this.branchId,
        entryId: leafId,
      });
    });
  }

  async createEntryId(): Promise<string> {
    return uuidv7();
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    const spec = sessionEntryToSpec(entry);
    await this.appendBatchInternal([spec]);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const row = await this.rpc.call<GadEntryRow | null>("main", "gad.getEntryById", {
      workspaceId: this.workspaceId,
      entryId: id,
    });
    if (!row) return undefined;
    if (!isTranscriptEntryType(row.entryType)) return undefined;
    return this.rowToSessionEntryOrThrow(row);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const rows = await this.rpc.call<GadEntryRow[]>(
      "main",
      "gad.findBranchEntriesByType",
      {
        workspaceId: this.workspaceId,
        branchId: this.branchId,
        entryType: type as GadEntryType,
      },
    );
    return rows.map((row) => this.rowToSessionEntryOrThrow(row)) as Array<
      Extract<SessionTreeEntry, { type: TType }>
    >;
  }

  async getLabel(id: string): Promise<string | undefined> {
    const rows = await this.rpc.call<GadEntryRow[]>(
      "main",
      "gad.findBranchEntriesByType",
      {
        workspaceId: this.workspaceId,
        branchId: this.branchId,
        entryType: "label" as GadEntryType,
      },
    );
    // Latest-wins by chain order; rows come in ASC, so walk in reverse.
    for (let i = rows.length - 1; i >= 0; i--) {
      const payload = rows[i]!.payload as { targetId?: string; label?: string };
      if (payload?.targetId === id) return payload.label;
    }
    return undefined;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    const rows = await this.rpc.call<GadEntryRow[]>("main", "gad.getBranchPath", {
      workspaceId: this.workspaceId,
      branchId: this.branchId,
      throughEntryId: leafId,
    });
    const out: SessionTreeEntry[] = [];
    for (const row of rows) {
      if (!isTranscriptEntryType(row.entryType)) continue;
      out.push(this.rowToSessionEntryOrThrow(row));
    }
    return out;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return this.getPathToRoot(null);
  }

  // ── Provenance / batched-recorder hook ───────────────────────────────────

  /**
   * Append a batch of envelope items (transcript or provenance). One CAS
   * call; CAS conflicts auto-retried up to 3 times. Used by `PiRunner`'s
   * dual-queue recorder.
   */
  async appendBatch(items: GadTrajectoryItemSpec[]): Promise<{ entryIds: string[] }> {
    if (items.length === 0) return { entryIds: [] };
    await this.appendBatchInternal(items);
    return { entryIds: items.map((it) => it.entryId) };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async ensureBranch(): Promise<GadBranchHead> {
    return this.rpc.call<GadBranchHead>("main", "gad.ensureGadBranch", {
      workspaceId: this.workspaceId,
      branchId: this.branchId,
      channelId: this.channelId,
      contextId: this.contextId,
    });
  }

  private async getHead(): Promise<GadBranchHead> {
    return this.rpc.call<GadBranchHead>("main", "gad.getGadBranchHead", {
      workspaceId: this.workspaceId,
      branchId: this.branchId,
    });
  }

  private serialise<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async appendBatchInternal(items: GadTrajectoryItemSpec[]): Promise<void> {
    return this.serialise(async () => {
      let head = await this.getHead();
      for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
        try {
          await this.rpc.call<GadAppendTrajectoryBatchResult>(
            "main",
            "gad.appendGadTrajectoryBatch",
            {
              workspaceId: this.workspaceId,
              branchId: this.branchId,
              expectedTrajectoryHash: head.headTrajectoryHash,
              expectedStateHash: head.headStateHash,
              items,
            } satisfies GadAppendTrajectoryBatchInput,
          );
          return;
        } catch (err) {
          if (!isCasConflict(err) || attempt === MAX_CAS_RETRIES - 1) throw err;
          head = await this.getHead();
        }
      }
      throw new Error(`gad-session-storage: append failed after ${MAX_CAS_RETRIES} retries`);
    });
  }

  private rowToSessionEntryOrThrow(row: GadEntryRow): SessionTreeEntry {
    try {
      return rowToSessionEntry(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new TranscriptShapeError(message, row.entryId);
      this.onTranscriptShapeError?.(wrapped);
      throw wrapped;
    }
  }
}

// ── Mapping: SessionTreeEntry ↔ envelope ──────────────────────────────────

const TRANSCRIPT_ENTRY_TYPES = new Set<GadEntryType>([
  "message",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
  "leaf",
]);

function isTranscriptEntryType(type: GadEntryType): boolean {
  return TRANSCRIPT_ENTRY_TYPES.has(type);
}

/**
 * Map an upstream `SessionTreeEntry` to a gad envelope item. Pure; no I/O.
 *
 * The mapping is 1:1 because the envelope was designed to carry exactly
 * upstream's discriminated-union shape.
 */
export function sessionEntryToSpec(entry: SessionTreeEntry): GadTrajectoryItemSpec {
  const base = {
    entryId: entry.id,
    parentEntryId: entry.parentId,
    actor: null,
    metadata: { timestamp: entry.timestamp } as GadJsonRecord,
  };
  switch (entry.type) {
    case "message":
      return { ...base, entryType: "message", payload: { message: entry.message as unknown as GadJsonRecord } };
    case "thinking_level_change":
      return { ...base, entryType: "thinking_level_change", payload: { thinkingLevel: entry.thinkingLevel } };
    case "model_change":
      return { ...base, entryType: "model_change", payload: { provider: entry.provider, modelId: entry.modelId } };
    case "compaction":
      return {
        ...base,
        entryType: "compaction",
        payload: {
          summary: entry.summary,
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          ...(entry.details !== undefined ? { details: entry.details as unknown as GadJsonRecord } : {}),
          ...(entry.fromHook !== undefined ? { fromHook: entry.fromHook } : {}),
        },
      };
    case "branch_summary":
      return {
        ...base,
        entryType: "branch_summary",
        payload: {
          fromId: entry.fromId,
          summary: entry.summary,
          ...(entry.details !== undefined ? { details: entry.details as unknown as GadJsonRecord } : {}),
          ...(entry.fromHook !== undefined ? { fromHook: entry.fromHook } : {}),
        },
      };
    case "custom":
      return {
        ...base,
        entryType: "custom",
        payload: {
          customType: entry.customType,
          ...(entry.data !== undefined ? { data: entry.data as unknown as GadJsonRecord } : {}),
        },
      };
    case "custom_message":
      return {
        ...base,
        entryType: "custom_message",
        payload: {
          customType: entry.customType,
          content: entry.content as unknown as GadJsonRecord,
          display: entry.display,
          ...(entry.details !== undefined ? { details: entry.details as unknown as GadJsonRecord } : {}),
        },
      };
    case "label":
      return {
        ...base,
        entryType: "label",
        payload: { targetId: entry.targetId, label: entry.label ?? null },
      };
    case "session_info":
      return {
        ...base,
        entryType: "session_info",
        payload: { ...(entry.name !== undefined ? { name: entry.name } : {}) },
      };
    case "leaf":
      return { ...base, entryType: "leaf", payload: { targetId: entry.targetId } };
  }
}

function readString(payload: GadJsonRecord, key: string): string {
  const v = payload[key];
  if (typeof v !== "string") {
    throw new Error(`expected payload.${key} to be a string`);
  }
  return v;
}

function readOptionalString(payload: GadJsonRecord, key: string): string | undefined {
  const v = payload[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`expected payload.${key} to be a string`);
  return v;
}

/**
 * Reverse mapping: gad envelope row → `SessionTreeEntry`. Validates the
 * payload shape; throws if the on-disk payload no longer matches what the
 * upstream type expects. Non-transcript entry types must be filtered before
 * calling this.
 */
export function rowToSessionEntry(row: GadEntryRow): SessionTreeEntry {
  const payload = row.payload;
  const metadata = row.metadata ?? {};
  const timestamp =
    typeof metadata["timestamp"] === "string" ? (metadata["timestamp"] as string) : row.createdAt;
  const base = { id: row.entryId, parentId: row.parentEntryId, timestamp };
  switch (row.entryType) {
    case "message":
      if (!payload || typeof payload !== "object" || !("message" in payload)) {
        throw new Error("message envelope missing payload.message");
      }
      return {
        ...base,
        type: "message",
        message: (payload as { message: unknown }).message as SessionTreeEntry extends {
          type: "message";
          message: infer M;
        }
          ? M
          : never,
      };
    case "thinking_level_change":
      return { ...base, type: "thinking_level_change", thinkingLevel: readString(payload, "thinkingLevel") };
    case "model_change":
      return {
        ...base,
        type: "model_change",
        provider: readString(payload, "provider"),
        modelId: readString(payload, "modelId"),
      };
    case "compaction": {
      const tokensBefore = payload["tokensBefore"];
      if (typeof tokensBefore !== "number") throw new Error("compaction payload.tokensBefore must be a number");
      return {
        ...base,
        type: "compaction",
        summary: readString(payload, "summary"),
        firstKeptEntryId: readString(payload, "firstKeptEntryId"),
        tokensBefore,
        ...(payload["details"] !== undefined ? { details: payload["details"] } : {}),
        ...(payload["fromHook"] !== undefined ? { fromHook: payload["fromHook"] === true } : {}),
      };
    }
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: readString(payload, "fromId"),
        summary: readString(payload, "summary"),
        ...(payload["details"] !== undefined ? { details: payload["details"] } : {}),
        ...(payload["fromHook"] !== undefined ? { fromHook: payload["fromHook"] === true } : {}),
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        customType: readString(payload, "customType"),
        ...(payload["data"] !== undefined ? { data: payload["data"] } : {}),
      };
    case "custom_message": {
      const content = payload["content"];
      if (typeof content !== "string" && !Array.isArray(content)) {
        throw new Error("custom_message payload.content must be string | array");
      }
      const display = payload["display"];
      if (typeof display !== "boolean") throw new Error("custom_message payload.display must be boolean");
      return {
        ...base,
        type: "custom_message",
        customType: readString(payload, "customType"),
        content: content as SessionTreeEntry extends { type: "custom_message"; content: infer C } ? C : never,
        display,
        ...(payload["details"] !== undefined ? { details: payload["details"] } : {}),
      };
    }
    case "label":
      return {
        ...base,
        type: "label",
        targetId: readString(payload, "targetId"),
        label: readOptionalString(payload, "label"),
      };
    case "session_info":
      return {
        ...base,
        type: "session_info",
        ...(payload["name"] !== undefined ? { name: readString(payload, "name") } : {}),
      };
    case "leaf": {
      const targetId = payload["targetId"];
      if (targetId !== null && typeof targetId !== "string") {
        throw new Error("leaf payload.targetId must be string | null");
      }
      return { ...base, type: "leaf", targetId: targetId as string | null };
    }
    default:
      throw new Error(`rowToSessionEntry: non-transcript entryType ${row.entryType}`);
  }
}

