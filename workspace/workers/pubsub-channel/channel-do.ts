/**
 * PubSubChannel — Durable Object for pub/sub messaging.
 *
 * Each channel is a single DO instance. All participants (panels, DOs, workers)
 * interact via RPC calls. Broadcasting uses this.rpc.emit() to push events
 * to subscribers.
 *
 * State: participants, pending_calls, and connection dedup keys in local SQLite.
 * Durable channel envelopes are delegated to GAD through ChannelLogStore.
 */

/// <reference path="../workerd.d.ts" />
import { DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import type { BootstrapSnapshot, ParticipantSnapshot } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  participantRefFromMetadata,
  publicParticipantMetadata,
  type AgenticEvent,
  type InvocationId,
  type ParticipantRef,
  type TurnId,
} from "@workspace/agentic-protocol";
import { PARTICIPANT_SESSION_METADATA_KEY } from "@workspace/pubsub/internal-constants";
import type { SubscribeResult, ChannelConfig, PresencePayload, StoredAttachment } from "./types.js";
import {
  broadcast,
  buildChannelEvent,
  channelEventToRpcSignal,
  queueEmit,
  queueDoEnvelope,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import {
  GadChannelLogStore,
  type ChannelLogStore,
  type MessageTypeDefinition,
  type RegistryMutationInput,
} from "./channel-log-store.js";
import {
  storeCall,
  consumeCall,
  cancelCall as cancelCallDb,
  cancelCallsForTarget,
} from "./invocation-calls.js";

/** How long before an RPC participant is considered stale (no heartbeat). */
const PARTICIPANT_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** How often to check for stale participants. */
const PARTICIPANT_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
/** Default channel-envelope replay window. */
const REPLAY_LIMIT = 50;
const MAX_INLINE_METHOD_RESULT_BYTES = 64 * 1024;
const METHOD_RESULT_PREVIEW_CHARS = 120;

function jsonByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function summarizeOversizedResult(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (value && typeof value === "object") {
    return { type: "object", keys: Object.keys(value as Record<string, unknown>).slice(0, 50) };
  }
  return { type: typeof value };
}

function parseDOParticipantId(
  participantId: string
): { source: string; className: string; objectKey: string } | null {
  if (!participantId.startsWith("do:")) return null;
  const parts = participantId.slice(3).split(":");
  if (parts.length < 3) return null;
  const [source, className, ...objectKeyParts] = parts;
  const objectKey = objectKeyParts.join(":");
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = 103;
  private _channelLog: ChannelLogStore | null = null;
  private _registryHydrated = false;
  private _registryHydrationPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
    try {
      this.sql.exec(`PRAGMA foreign_keys = ON`);
    } catch {
      /* workerd may ignore pragmas */
    }
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        session_id TEXT,
        handle TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        transport_call_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        caller_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER
      )
    `);
    try {
      this.sql.exec(`ALTER TABLE pending_calls ADD COLUMN deadline_at INTEGER`);
    } catch {
      // Existing databases may already have the column, and freshly-created
      // databases get it from CREATE TABLE above.
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dedup_keys (
        key TEXT PRIMARY KEY,
        result_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS message_types (
        type_id TEXT PRIMARY KEY,
        definition_json TEXT,
        updated_at_seq INTEGER NOT NULL DEFAULT -1,
        cleared_at_seq INTEGER
      )
    `);
  }

  protected override migrate(_fromVersion: number, _toVersion: number): void {
    this.sql.exec(`DROP INDEX IF EXISTS idx_channel_envelopes_published_at`);
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root`);
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root_chat`);
    this.sql.exec(`DROP TABLE IF EXISTS channel_envelopes`);
    this.sql.exec(`DROP TABLE IF EXISTS messages`);
    this.sql.exec(`DROP TABLE IF EXISTS participants`);
    this.sql.exec(`DROP TABLE IF EXISTS pending_calls`);
    this.sql.exec(`DROP TABLE IF EXISTS dedup_keys`);
    this.sql.exec(`DROP TABLE IF EXISTS message_types`);
    this.createTables();
  }

  // ── Broadcast deps ──────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
    };
  }

  private get channelLog(): ChannelLogStore {
    this._channelLog ??= new GadChannelLogStore(
      {
        call: <T = unknown>(targetId: string, method: string, args: unknown[]) =>
          this.rpc.call<T>(targetId, method, args),
      },
      this.objectKey
    );
    return this._channelLog;
  }

  /** Look up a participant's metadata from the participants table. */
  private getSenderMetadata(participantId: string): Record<string, unknown> | undefined {
    const row = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (row.length === 0) return undefined;
    try {
      return JSON.parse(row[0]!["metadata"] as string);
    } catch {
      return undefined;
    }
  }

  private participantRef(participantId: string): ParticipantRef {
    return participantRefFromMetadata(participantId, this.getSenderMetadata(participantId));
  }

  private invocationStartedPayload(
    callerId: string,
    targetId: string,
    invocationId: string,
    transportCallId: string,
    turnId: string | undefined,
    methodName: string,
    args: unknown
  ): AgenticEvent {
    return {
      kind: "invocation.started",
      actor: this.participantRef(callerId),
      ...(turnId ? { turnId: turnId as TurnId } : {}),
      causality: {
        invocationId: invocationId as InvocationId,
        transportCallId,
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: methodName,
        invocationType: "panel",
        request: args,
        transport: {
          kind: "channel",
          channelId: this.objectKey as never,
          target: this.participantRef(targetId),
          transportCallId,
        },
        userVisible: false,
      },
      createdAt: new Date().toISOString(),
    };
  }

  private invocationResultPayload(
    callerId: string,
    invocationId: string,
    transportCallId: string | undefined,
    turnId: string | undefined,
    result: unknown,
    isError: boolean
  ): AgenticEvent {
    return {
      kind: isError ? "invocation.failed" : "invocation.completed",
      actor: this.participantRef(callerId),
      ...(turnId ? { turnId: turnId as TurnId } : {}),
      causality: {
        invocationId: invocationId as InvocationId,
        ...(transportCallId ? { transportCallId } : {}),
      },
      payload: isError
        ? { protocol: AGENTIC_PROTOCOL_VERSION, reason: "method failed", error: result }
        : { protocol: AGENTIC_PROTOCOL_VERSION, result },
      createdAt: new Date().toISOString(),
    } as AgenticEvent;
  }

  private invocationCancelledPayload(
    actorId: string,
    invocationId: string,
    transportCallId: string | undefined,
    turnId: string | undefined,
    reason: string
  ): AgenticEvent {
    return {
      kind: "invocation.cancelled",
      actor: this.participantRef(actorId),
      ...(turnId ? { turnId: turnId as TurnId } : {}),
      causality: {
        invocationId: invocationId as InvocationId,
        ...(transportCallId ? { transportCallId } : {}),
      },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason },
      createdAt: new Date().toISOString(),
    };
  }

  private invocationResultFromPublishedPayload(
    type: string,
    payload: unknown
  ): {
    transportCallId: string;
    invocationId: string;
    turnId?: string;
    content: unknown;
    isError: boolean;
    complete: boolean;
  } | null {
    if (
      type !== AGENTIC_EVENT_PAYLOAD_KIND ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return null;
    const eventObj = payload as AgenticEvent;
    if (!eventObj.kind.startsWith("invocation.")) return null;
    const invocationId = eventObj.causality?.invocationId;
    if (typeof invocationId !== "string" || invocationId.length === 0) return null;
    const transportCallId = eventObj.causality?.transportCallId ?? invocationId;
    const turnId = typeof eventObj.turnId === "string" ? eventObj.turnId : undefined;
    if (eventObj.kind === "invocation.completed") {
      const result = "result" in eventObj.payload ? eventObj.payload.result : undefined;
      return {
        transportCallId,
        invocationId,
        turnId,
        content: result,
        isError: false,
        complete: true,
      };
    }
    if (eventObj.kind === "invocation.failed" || eventObj.kind === "invocation.cancelled") {
      const payloadObj = eventObj.payload as Record<string, unknown>;
      return {
        transportCallId,
        invocationId,
        turnId,
        content: payloadObj["error"] ?? payloadObj["reason"] ?? "Invocation failed",
        isError: true,
        complete: true,
      };
    }
    return {
      transportCallId,
      invocationId,
      turnId,
      content: eventObj.payload,
      isError: false,
      complete: false,
    };
  }

  private registryMutationFromPublishedPayload(
    type: string,
    payload: unknown
  ): RegistryMutationInput | null {
    if (
      type !== AGENTIC_EVENT_PAYLOAD_KIND ||
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    )
      return null;
    const event = payload as AgenticEvent;
    if (event.kind === "messageType.registered") {
      const body = event.payload as Record<string, unknown>;
      const typeId = typeof body["typeId"] === "string" ? body["typeId"] : "";
      const displayMode =
        body["displayMode"] === "inline" ? "inline" : body["displayMode"] === "row" ? "row" : null;
      const source = body["source"];
      if (!typeId || !displayMode || !source || typeof source !== "object" || Array.isArray(source))
        return null;
      const sourceRecord = source as Record<string, unknown>;
      const normalizedSource =
        sourceRecord["type"] === "code" && typeof sourceRecord["code"] === "string"
          ? { type: "code" as const, code: sourceRecord["code"] }
          : sourceRecord["type"] === "file" && typeof sourceRecord["path"] === "string"
            ? { type: "file" as const, path: sourceRecord["path"] }
            : null;
      if (!normalizedSource) return null;
      const row: RegistryMutationInput & { kind: "upsertMessageType" } = {
        kind: "upsertMessageType",
        typeId,
        row: {
          displayMode,
          source: normalizedSource,
        },
      };
      if (
        body["imports"] &&
        typeof body["imports"] === "object" &&
        !Array.isArray(body["imports"])
      ) {
        row.row.imports = body["imports"] as Record<string, string>;
      }
      if (body["schemaSourceOrPath"] !== undefined)
        row.row.schemaSourceOrPath = body["schemaSourceOrPath"];
      if (
        body["registeredBy"] &&
        typeof body["registeredBy"] === "object" &&
        !Array.isArray(body["registeredBy"])
      ) {
        row.row.registeredBy = body["registeredBy"] as Record<string, unknown>;
      }
      return row;
    }
    if (event.kind === "messageType.cleared") {
      const body = event.payload as Record<string, unknown>;
      const typeId = typeof body["typeId"] === "string" ? body["typeId"] : "";
      return typeId ? { kind: "clearMessageType", typeId } : null;
    }
    return null;
  }

  private async appendLogEvent(
    type: string,
    payload: unknown,
    senderId: string,
    senderMetadata?: Record<string, unknown>,
    opts?: {
      messageId?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<ChannelEvent> {
    return this.channelLog.append({
      type,
      payload,
      senderId,
      senderMetadata,
      messageId: opts?.messageId,
      attachments: opts?.attachments,
    });
  }

  private async appendRegistryEvent(
    type: string,
    payload: AgenticEvent,
    senderId: string,
    senderMetadata: Record<string, unknown> | undefined,
    mutation: RegistryMutationInput
  ): Promise<ChannelEvent> {
    await this.ensureRegistryHydrated();
    const event = await this.channelLog.appendWithRegistryMutation(
      {
        type,
        payload,
        senderId,
        senderMetadata,
      },
      mutation
    );
    this.cacheMessageTypeMutation(event.id, mutation);
    return event;
  }

  private cacheMessageTypeMutation(seq: number, mutation: RegistryMutationInput): void {
    if (mutation.kind === "upsertMessageType") {
      const definition: MessageTypeDefinition = {
        typeId: mutation.typeId,
        displayMode: mutation.row.displayMode,
        source: mutation.row.source,
        updatedAtSeq: seq,
      };
      if (mutation.row.imports !== undefined) definition.imports = mutation.row.imports;
      if (mutation.row.schemaSourceOrPath !== undefined)
        definition.schemaSourceOrPath = mutation.row.schemaSourceOrPath;
      if (mutation.row.registeredBy !== undefined)
        definition.registeredBy = mutation.row.registeredBy;
      this.sql.exec(
        `INSERT INTO message_types (type_id, definition_json, updated_at_seq, cleared_at_seq)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(type_id) DO UPDATE SET
           definition_json = excluded.definition_json,
           updated_at_seq = excluded.updated_at_seq,
           cleared_at_seq = NULL
         WHERE excluded.updated_at_seq > message_types.updated_at_seq
           AND excluded.updated_at_seq > COALESCE(message_types.cleared_at_seq, -1)`,
        mutation.typeId,
        JSON.stringify(definition),
        seq
      );
      return;
    }
    this.sql.exec(
      `INSERT INTO message_types (type_id, updated_at_seq, cleared_at_seq)
       VALUES (?, -1, ?)
       ON CONFLICT(type_id) DO UPDATE SET
         cleared_at_seq = MAX(COALESCE(message_types.cleared_at_seq, -1), excluded.cleared_at_seq)`,
      mutation.typeId,
      seq
    );
  }

  private cacheMessageTypes(definitions: MessageTypeDefinition[]): void {
    for (const definition of definitions) {
      this.sql.exec(
        `INSERT INTO message_types (type_id, definition_json, updated_at_seq, cleared_at_seq)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(type_id) DO UPDATE SET
           definition_json = excluded.definition_json,
           updated_at_seq = excluded.updated_at_seq,
           cleared_at_seq = excluded.cleared_at_seq`,
        definition.typeId,
        JSON.stringify(definition),
        definition.updatedAtSeq,
        definition.clearedAtSeq ?? null
      );
    }
  }

  private localMessageTypes(): MessageTypeDefinition[] {
    const rows = this.sql
      .exec(
        `SELECT definition_json FROM message_types WHERE definition_json IS NOT NULL AND updated_at_seq > COALESCE(cleared_at_seq, -1)`
      )
      .toArray();
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row["definition_json"] as string) as MessageTypeDefinition];
      } catch {
        return [];
      }
    });
  }

  private async ensureRegistryHydrated(): Promise<void> {
    if (this._registryHydrated) return;
    if (!this._registryHydrationPromise) {
      this._registryHydrationPromise = (async () => {
        const definitions = await this.channelLog.listMessageTypes();
        this.sql.exec(`DELETE FROM message_types`);
        this.cacheMessageTypes(definitions);
        this._registryHydrated = true;
      })().finally(() => {
        this._registryHydrationPromise = null;
      });
    }
    await this._registryHydrationPromise;
  }

  private currentReplayContext(): {
    contextId?: string;
    channelConfig?: Record<string, unknown>;
    snapshots?: BootstrapSnapshot[];
  } {
    return {
      contextId: this.getStateValue("contextId") ?? undefined,
      channelConfig: this.getChannelConfig() ?? undefined,
      snapshots: [this.rosterSnapshot()],
    };
  }

  private rosterSnapshot(): BootstrapSnapshot {
    const participants: ParticipantSnapshot[] = [];
    for (const row of this.sql
      .exec(`SELECT id, metadata FROM participants ORDER BY id ASC`)
      .toArray()) {
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

  private async ensureMethodRoot(
    invocationId: string,
    callerId: string,
    targetId?: string,
    transportCallId?: string,
    turnId?: string,
    methodName?: string,
    args?: unknown
  ): Promise<void> {
    if (await this.channelLog.hasEnvelope(invocationId)) return;
    await this.appendLogEvent(
      AGENTIC_EVENT_PAYLOAD_KIND,
      this.invocationStartedPayload(
        callerId,
        targetId ?? "unknown",
        invocationId,
        transportCallId ?? invocationId,
        turnId,
        methodName ?? "unknown",
        args
      ),
      callerId,
      this.getSenderMetadata(callerId),
      { messageId: invocationId }
    );
  }

  // ── Channel initialization ──────────────────────────────────────────────

  private initChannel(contextId: string, channelConfig?: Record<string, unknown>): void {
    const existing = this.getStateValue("contextId");
    if (existing) {
      if (existing !== contextId) {
        throw new Error(`Context mismatch: channel bound to ${existing}, got ${contextId}`);
      }
      return;
    }
    this.setStateValue("contextId", contextId);
    this.setStateValue("createdAt", String(Date.now()));
    if (channelConfig) this.setStateValue("config", JSON.stringify(channelConfig));
    void this.refreshOwnTitle();
  }

  /** Push this channel's display title to the server-side registry. Falls
   *  back to "Channel" when no title is configured so approval UIs always
   *  have a meaningful label. */
  private async refreshOwnTitle(): Promise<void> {
    const config = this.getChannelConfig();
    const configured =
      config && typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    if (config?.titleExplicit === true) {
      await this.setOwnTitleExplicitly(configured ?? null);
    } else {
      await this.setOwnTitle(configured ?? "Channel");
    }
  }

  private getChannelConfig(): ChannelConfig | null {
    const raw = this.getStateValue("config");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private assertParticipantCaller(participantId: string, method: string): void {
    const callerId = this.rpcCallerId;
    if (callerId && callerId !== participantId) {
      throw new Error(
        `${method}: participant ${participantId} cannot be used by caller ${callerId}`
      );
    }
  }

  private isPrivilegedRpcCaller(): boolean {
    const callerId = this.rpcCallerId;
    const callerKind = this.rpcCallerKind;
    return (
      callerId === "main" ||
      callerKind === "server" ||
      callerKind === "shell" ||
      callerKind === "harness"
    );
  }

  private assertAdminCaller(method: string): void {
    if (this.isPrivilegedRpcCaller()) return;
    const callerId = this.rpcCallerId ?? "unknown";
    const callerKind = this.rpcCallerKind ?? "unknown";
    throw new Error(`${method}: privileged caller required (got ${callerKind} ${callerId})`);
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private async publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number
  ): Promise<void> {
    const publicMetadata = publicParticipantMetadata(metadata) ?? {};
    const payload: PresencePayload = {
      action,
      metadata: publicMetadata,
      ...(leaveReason ? { leaveReason } : {}),
    };

    const event = await this.appendLogEvent("presence", payload, senderId, publicMetadata);
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref: senderRef }, senderId);
  }

  private broadcastPresenceSignal(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced"
  ): void {
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      "presence",
      JSON.stringify(payload),
      senderId,
      metadata,
      Date.now()
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, senderId);
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel.
   * Called by panels (via RPC through server relay) and DOs (via RPC call).
   *
   * Subscribe inserts the participant first, then builds replay. This means an
   * initial roster snapshot always contains the subscriber itself.
   */
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<SubscribeResult> {
    const doRef = parseDOParticipantId(participantId);
    const transport = doRef ? "do" : "rpc";
    const callerId = this.rpcCallerId;
    if (callerId && callerId !== participantId) {
      throw new Error(`Participant ${participantId} cannot be subscribed by caller ${callerId}`);
    }
    const participantSessionId =
      typeof metadata[PARTICIPANT_SESSION_METADATA_KEY] === "string"
        ? (metadata[PARTICIPANT_SESSION_METADATA_KEY] as string)
        : null;

    // Extract contextId from metadata
    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;

    // Initialize channel if contextId provided
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Enforce participant handle uniqueness within the channel.
    // Channel-tools extension uses bare method names keyed by handle, so two
    // participants advertising the same handle would collide. Reject the new
    // subscribe if another live participant already owns this handle.
    const handle = typeof metadata["handle"] === "string" ? (metadata["handle"] as string) : null;
    if (handle) {
      const conflict = this.sql
        .exec(`SELECT id FROM participants WHERE handle = ? AND id != ?`, handle, participantId)
        .toArray();
      if (conflict.length > 0) {
        const otherId = conflict[0]!["id"] as string;
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(${otherId}) in this channel. Handles must be unique.`
        );
      }
    }

    // Validate advertised method names. The channel-tools extension exposes
    // each method to the LLM by its bare name, so names must satisfy the
    // LLM-tool-name contract: ASCII letters/digits/`_`/`-`, starting with a
    // letter, length 1..64, and not collide with Pi's built-in tool names.
    // Reject the subscribe up-front so a misconfigured participant cannot
    // poison the agent's tool list.
    const advertisedMethods = metadata["methods"];
    if (Array.isArray(advertisedMethods)) {
      const VALID_METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
      const RESERVED_METHOD_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls"]);
      for (const m of advertisedMethods) {
        const name =
          m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string"
            ? (m as { name: string }).name
            : null;
        if (name === null) continue; // unknown shape; let downstream handle it
        if (!VALID_METHOD_NAME.test(name) || RESERVED_METHOD_NAMES.has(name)) {
          throw new Error(
            `Invalid method name "${name}" advertised by participant "${participantId}". ` +
              `Method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/ and ` +
              `not collide with built-in tool names (read, edit, write, grep, find, ls).`
          );
        }
      }
    }

    if (doRef && callerId) {
      await this.rpc.call("main", "workers.resolveDurableObject", [
        doRef.source,
        doRef.className,
        doRef.objectKey,
      ]);
    }

    // Re-subscribe with the same participant ID: replace the roster entry, but
    // only redeliver in-flight calls if the underlying client session changed.
    // Clients should keep participantId stable for the logical viewer so
    // cold recovery after a server restart can replay from the last seen id
    // without creating duplicate roster participants.
    const existing = this.sql
      .exec(`SELECT session_id FROM participants WHERE id = ?`, participantId)
      .toArray();
    let sessionReplaced = false;
    if (existing.length > 0) {
      const previousSessionId = existing[0]!["session_id"] as string | null;
      const oldMetadata = this.getSenderMetadata(participantId) ?? {};
      sessionReplaced =
        previousSessionId == null ||
        participantSessionId == null ||
        previousSessionId !== participantSessionId;
      await this.publishPresenceEvent(
        participantId,
        "leave",
        oldMetadata,
        sessionReplaced ? "replaced" : "graceful"
      );
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
      cleanupDeliveryChain(participantId);
      if (sessionReplaced) {
        const pendingCountRow = this.sql
          .exec(`SELECT COUNT(*) as cnt FROM pending_calls WHERE target_id = ?`, participantId)
          .toArray();
        const pendingCount = (pendingCountRow[0]?.["cnt"] as number) ?? 0;
        console.log(
          `[Channel] Participant session replaced: target=${participantId} previousSession=${previousSessionId ?? "unknown"} newSession=${participantSessionId ?? "unknown"} pendingCalls=${pendingCount}`
        );
      }
    }

    // Extract replay options before cleaning metadata
    const wantsReplay = metadata["replay"] !== false;
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as number | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    const storedMetadata = { ...metadata };
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    delete storedMetadata[PARTICIPANT_SESSION_METADATA_KEY];

    this.sql.exec(
      `INSERT INTO participants (id, metadata, transport, connected_at, session_id, handle)
       VALUES (?, ?, ?, ?, ?, ?)`,
      participantId,
      JSON.stringify(storedMetadata),
      transport === "do" ? "do" : "rpc",
      Date.now(),
      participantSessionId,
      handle
    );

    // Publish join presence before building replay so the initial roster snapshot includes self.
    await this.publishPresenceEvent(participantId, "join", storedMetadata);

    const mode = wantsReplay && sinceId && sinceId > 0 ? "after" : "initial";
    const envelope =
      mode === "after"
        ? await this.channelLog.replayAfter(sinceId!, this.currentReplayContext())
        : await this.channelLog.replayInitial(
            wantsReplay ? (replayMessageLimit ?? REPLAY_LIMIT) : 0,
            this.currentReplayContext()
          );
    this.queueReplayEnvelope(participantId, envelope, doRef != null);

    if (sessionReplaced) this.redeliverPendingCallsTo(participantId);

    // Schedule stale participant cleanup for RPC participants
    if (transport !== "do") {
      this.scheduleParticipantCleanup();
    }

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
      envelope,
    };
  }

  private queueReplayEnvelope(
    subscriberId: string,
    envelope: Awaited<ReturnType<ChannelLogStore["replayInitial"]>>,
    deliverToDo: boolean
  ): void {
    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(subscriberId);
      }
    };
    for (const event of envelope.logEvents) {
      void queueEmit(
        this.broadcastDeps,
        subscriberId,
        {
          channelId: this.objectKey,
          message: { kind: "log", phase: "replay", event },
        },
        onFatal
      );
      if (deliverToDo) {
        void queueDoEnvelope(this.broadcastDeps, subscriberId, {
          kind: "log",
          phase: "replay",
          event,
        });
      }
    }
    for (const snapshot of envelope.snapshots) {
      const message = {
        kind: "control" as const,
        type: "roster-snapshot" as const,
        participants: snapshot.participants,
        ts: snapshot.ts,
      };
      void queueEmit(
        this.broadcastDeps,
        subscriberId,
        { channelId: this.objectKey, message },
        onFatal
      );
      if (deliverToDo) {
        void queueDoEnvelope(this.broadcastDeps, subscriberId, message);
      }
    }
    const readyMessage = {
      kind: "control" as const,
      type: "ready" as const,
      ready: envelope.ready,
    };
    void queueEmit(
      this.broadcastDeps,
      subscriberId,
      { channelId: this.objectKey, message: readyMessage },
      onFatal
    );
    if (deliverToDo) {
      void queueDoEnvelope(this.broadcastDeps, subscriberId, readyMessage);
    }
  }

  /**
   * Unsubscribe a participant from this channel.
   */
  async unsubscribe(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribe");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  async adminUnsubscribeParticipant(participantId: string): Promise<void> {
    this.assertAdminCaller("adminUnsubscribeParticipant");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  private async unsubscribeParticipant(
    participantId: string,
    leaveReason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};

    this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    cleanupDeliveryChain(participantId);
    await this.failPendingCallsTargeting(participantId, leaveReason);
    await this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);
  }

  /**
   * Redeliver pending channel invocations to a (re)subscribed participant.
   *
   * The canonical invocation start is durable. If the target's session was
   * interrupted while the call was pending, the provider still needs an
   * operational nudge after it re-subscribes. Re-emit every still-pending call
   * targeting this participant as a signal, queued through the same
   * per-subscriber FIFO as roster/message replay. Delivery is at-least-once
   * over the call's lifetime: a handler may
   * run twice if it executed on the prior session but the result-publish was
   * interrupted. All in-tree methods (feedback_form, feedback_custom,
   * ui_prompt, tool_approval) are idempotent; custom methods with
   * non-idempotent side effects should dedupe on `callId`.
   */
  private redeliverPendingCallsTo(participantId: string): void {
    const rows = this.sql
      .exec(
        `SELECT transport_call_id, invocation_id, turn_id, caller_id, method, args FROM pending_calls WHERE target_id = ?`,
        participantId
      )
      .toArray();
    if (rows.length === 0) return;

    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
        cleanupDeliveryChain(participantId);
      }
    };

    for (const row of rows) {
      const transportCallId = row["transport_call_id"] as string;
      const invocationId = row["invocation_id"] as string;
      const turnId = row["turn_id"] ? (row["turn_id"] as string) : undefined;
      const callerId = row["caller_id"] as string;
      const methodName = row["method"] as string;
      const argsRaw = row["args"] as string | null;
      let args: unknown = undefined;
      if (argsRaw != null) {
        try {
          args = JSON.parse(argsRaw);
        } catch (err) {
          console.warn(
            `[Channel] redeliver: failed to parse args for transportCallId=${transportCallId}:`,
            err
          );
          continue;
        }
      }
      const payload = this.invocationStartedPayload(
        callerId,
        participantId,
        invocationId,
        transportCallId,
        turnId,
        methodName,
        args
      );
      const senderMetadata = this.getSenderMetadata(callerId);
      const ts = Date.now();
      const event: ChannelEvent = {
        id: 0,
        messageId: invocationId,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: callerId,
        senderMetadata,
        ts,
      };
      const msg = channelEventToRpcSignal(event);
      void queueEmit(
        this.broadcastDeps,
        participantId,
        {
          channelId: this.objectKey,
          message: msg,
        },
        onFatal
      );
    }
    console.log(`[Channel] Redelivered ${rows.length} pending call(s) to ${participantId}`);
  }

  /**
   * Cancel any pending tool calls targeting a participant that's leaving the
   * channel. Each affected caller gets a synthetic "target left" error result
   * delivered via the normal result path, so the harness's pendingToolResults
   * map fails with a meaningful error rather than hanging until the harness
   * stall warning fires. Called for graceful unsubscribe and stale-session
   * eviction; session-replace goes through `redeliverPendingCallsTo` instead.
   */
  private async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    const cancelled = cancelCallsForTarget(this.sql, targetId);
    if (cancelled.length === 0) return;
    const errorMessage =
      reason === "graceful"
        ? `Target ${targetId} left the channel before the call completed`
        : reason === "disconnect"
          ? `Target ${targetId} disconnected from the channel before the call completed`
          : `Target ${targetId} was replaced by a new session before the call completed`;
    for (const { transportCallId, invocationId, turnId, callerId } of cancelled) {
      try {
        await this.deliverCallResult(
          callerId,
          invocationId,
          transportCallId,
          turnId,
          undefined,
          { error: errorMessage },
          true
        );
      } catch (err) {
        console.warn(
          `[Channel] failPendingCallsTargeting: deliver failed for ${transportCallId}:`,
          err
        );
      }
    }
    console.log(
      `[Channel] Cancelled ${cancelled.length} pending call(s) targeting ${targetId} (${reason})`
    );
  }

  /**
   * Heartbeat from an RPC participant. Updates connected_at to prevent stale eviction.
   * Panels should call this periodically (e.g., every 60s).
   */
  async touch(participantId: string): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET connected_at = ? WHERE id = ?`,
      Date.now(),
      participantId
    );
  }

  /**
   * Publish a typed message (from any participant).
   * This is the generic publish method used by panel clients for all message types.
   */
  async publish(
    participantId: string,
    type: string,
    payload: unknown,
    opts?: {
      ref?: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: StoredAttachment[];
      idempotencyKey?: string;
    }
  ): Promise<{ id?: number }> {
    this.assertParticipantCaller(participantId, "publish");
    const ref = opts?.ref;
    const attachments = opts?.attachments;
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      if (existing.length > 0) {
        return { id: existing[0]!["result_id"] as number | undefined };
      }
    }

    // Intercept terminal invocation results only if there's a matching pending
    // DO-initiated call. Streaming progress remains in the channel log.
    const invocationResult = this.invocationResultFromPublishedPayload(type, payload);
    if (invocationResult) {
      if (invocationResult.complete) {
        const pending = this.sql
          .exec(
            `SELECT transport_call_id FROM pending_calls WHERE transport_call_id = ?`,
            invocationResult.transportCallId
          )
          .toArray();
        if (pending.length > 0) {
          const resultId = await this.handleMethodResult(
            invocationResult.transportCallId,
            invocationResult.content,
            invocationResult.isError
          );
          if (idempotencyKey && resultId !== undefined) {
            this.sql.exec(
              `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
              idempotencyKey,
              resultId,
              Date.now()
            );
            this.scheduleDedupCleanup();
          }
          return { id: resultId };
        }
      }
      // No pending call, or a non-terminal chunk — fall through to normal broadcast.
    }

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;
    const registryMutation = this.registryMutationFromPublishedPayload(type, payload);
    if (
      type === AGENTIC_EVENT_PAYLOAD_KIND &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      ((payload as AgenticEvent).kind === "messageType.registered" ||
        (payload as AgenticEvent).kind === "messageType.cleared") &&
      !registryMutation
    ) {
      throw new Error(`Invalid registry payload for ${(payload as AgenticEvent).kind}`);
    }
    if (registryMutation) {
      const event = await this.appendRegistryEvent(
        type,
        payload as AgenticEvent,
        participantId,
        senderMetadata,
        registryMutation
      );
      if (idempotencyKey) {
        this.sql.exec(
          `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
          idempotencyKey,
          event.id,
          Date.now()
        );
        this.scheduleDedupCleanup();
      }
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, participantId);
      return { id: event.id };
    }

    const event = await this.appendLogEvent(type, payload, participantId, senderMetadata, {
      messageId: undefined,
      attachments,
    });

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey,
        event.id,
        Date.now()
      );
      this.scheduleDedupCleanup();
    }

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, participantId);
    return { id: event.id };
  }

  /**
   * Broadcast envelopes that were durably appended to GAD outside this DO.
   * This keeps GAD as the provenance/channel-log backend while PubSub remains
   * responsible for live fan-out to connected panels and agents.
   */
  async broadcastStoredEnvelopes(envelopeIds: string[]): Promise<{ broadcasted: number }> {
    let broadcasted = 0;
    for (const envelopeId of envelopeIds) {
      if (typeof envelopeId !== "string" || envelopeId.length === 0) continue;
      const event = await this.channelLog.getEventByEnvelopeId(envelopeId);
      if (!event) continue;
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, event.senderId);
      broadcasted += 1;
    }
    return { broadcasted };
  }

  /**
   * Mark a message as errored. Persists an `error` channel event with a
   * human-readable error string, which the client merge helper surfaces as
   * `ChatMessage.error` + `complete: true` in the chat UI. Used by the
   * channel operation callers when a send/update path fails so users see a
   * visible error instead of a silent empty message.
   */
  async error(
    participantId: string,
    messageId: string,
    errorMessage: string,
    code?: string
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "error");
    const senderMetadata = this.getSenderMetadata(participantId);
    const payload: Record<string, unknown> = { id: messageId, error: errorMessage };
    if (code) payload["code"] = code;
    const event = await this.appendLogEvent("error", payload, participantId, senderMetadata);
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  async getReplayAfter(sinceId: number) {
    return this.channelLog.replayAfter(sinceId, this.currentReplayContext());
  }

  /**
   * Send a non-durable signal message (from a participant).
   */
  async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
    this.assertParticipantCaller(participantId, "sendSignal");
    const ts = Date.now();
    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const event = buildChannelEvent(
      0,
      `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      "signal",
      payloadJson,
      participantId,
      senderMetadata,
      ts
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, participantId);
  }

  /**
   * Replace a participant's metadata entirely.
   */
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    await this.updateParticipantMetadata(participantId, metadata);
  }

  async adminUpdateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.assertAdminCaller("adminUpdateParticipantMetadata");
    await this.updateParticipantMetadata(participantId, metadata);
  }

  private async updateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(metadata),
      participantId
    );
    await this.publishPresenceEvent(participantId, "update", metadata);
  }

  /**
   * Set a participant's typing state. Updates the participants table (so
   * reconnecting clients see current state) and broadcasts a signal without
   * inserting a messages row.
   */
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  async adminSetParticipantTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertAdminCaller("adminSetParticipantTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  private setParticipantTypingState(participantId: string, typing: boolean): void {
    const rows = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (rows.length === 0) return;
    const final = { ...JSON.parse(rows[0]!["metadata"] as string), typing };
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(final),
      participantId
    );
    this.broadcastPresenceSignal(participantId, "update", final);
  }

  /**
   * Get all participants with DO identity when available.
   */
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      metadata: Record<string, unknown>;
      transport: string;
      doRef?: { source: string; className: string; objectKey: string };
    }>
  > {
    const rows = this.sql.exec(`SELECT id, metadata, transport FROM participants`).toArray();
    return rows.map((row) => {
      const participantId = row["id"] as string;
      const entry: {
        participantId: string;
        metadata: Record<string, unknown>;
        transport: string;
        doRef?: { source: string; className: string; objectKey: string };
      } = {
        participantId,
        metadata: JSON.parse(row["metadata"] as string),
        transport: row["transport"] as string,
      };
      const doRef = parseDOParticipantId(participantId);
      if (doRef) entry.doRef = doRef;
      return entry;
    });
  }

  /**
   * Get the channel's contextId (set during initChannel).
   */
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  /**
   * Update channel config.
   */
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    const event = await this.appendLogEvent("config-update", newConfig, "system");
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
    void this.refreshOwnTitle();
    return newConfig;
  }

  async getReplayBefore(beforeSeq: number, limit?: number) {
    return this.channelLog.replayBefore(beforeSeq, limit ?? 100, this.currentReplayContext());
  }

  async getMessageTypes(): Promise<MessageTypeDefinition[]> {
    await this.ensureRegistryHydrated();
    return this.localMessageTypes();
  }

  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    await this.ensureRegistryHydrated();
    const cachedState = this.sql
      .exec(
        `SELECT updated_at_seq, cleared_at_seq FROM message_types WHERE type_id = ? LIMIT 1`,
        typeId
      )
      .toArray()[0];
    if (
      cachedState &&
      typeof cachedState["cleared_at_seq"] === "number" &&
      Number(cachedState["cleared_at_seq"]) >= Number(cachedState["updated_at_seq"] ?? -1)
    ) {
      return null;
    }
    const rows = this.sql
      .exec(
        `SELECT definition_json FROM message_types
         WHERE type_id = ? AND definition_json IS NOT NULL
           AND updated_at_seq > COALESCE(cleared_at_seq, -1)
         LIMIT 1`,
        typeId
      )
      .toArray();
    if (rows.length > 0) {
      try {
        return JSON.parse(rows[0]!["definition_json"] as string) as MessageTypeDefinition;
      } catch {
        /* fall through */
      }
    }
    const definition = await this.channelLog.getMessageType(typeId);
    if (definition) this.cacheMessageTypes([definition]);
    return definition;
  }

  async adminInspectSchema() {
    this.assertAdminCaller("adminInspectSchema");
    const tables = ["participants", "pending_calls", "dedup_keys", "message_types"].map(
      (table) => ({
        table,
        columns: this.sql.exec(`PRAGMA table_info(${table})`).toArray(),
      })
    );
    const indexes = ["participants", "pending_calls", "dedup_keys", "message_types"].flatMap(
      (table) => {
        const list = this.sql.exec(`PRAGMA index_list(${table})`).toArray();
        return list.map((idx) => ({
          table,
          ...idx,
          columns: this.sql.exec(`PRAGMA index_info(${idx["name"] as string})`).toArray(),
        }));
      }
    );
    const localEnvelopeTables = this.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`)
      .toArray();
    return {
      tables,
      indexes,
      invariants: [
        {
          name: "durable-log-delegated-to-gad",
          ok: localEnvelopeTables.length === 0,
        },
      ],
    };
  }

  async adminInspectLog(
    opts: {
      afterId?: number;
      beforeId?: number;
      limit?: number;
      includePresence?: boolean;
    } = {}
  ) {
    this.assertAdminCaller("adminInspectLog");
    const rows = await this.channelLog.inspectRows(opts);
    const firstId = rows[0]?.["seq"] as number | undefined;
    const lastId = rows[rows.length - 1]?.["seq"] as number | undefined;
    const before =
      firstId != null
        ? await this.channelLog.replayBefore(firstId, 1, this.currentReplayContext())
        : null;
    const after =
      lastId != null
        ? await this.channelLog.replayAfter(lastId, this.currentReplayContext())
        : null;
    return {
      rows,
      hasMoreBefore: (before?.logEvents.length ?? 0) > 0,
      hasMoreAfter: (after?.logEvents.length ?? 0) > 0,
    };
  }

  async adminInspectEnvelope(envelopeId: string) {
    this.assertAdminCaller("adminInspectMessageChain");
    return { rows: await this.channelLog.inspectEnvelope(envelopeId) };
  }

  async adminReconstructTranscript(opts: { rootLimit?: number; beforeSeq?: number } = {}) {
    this.assertAdminCaller("adminReconstructTranscript");
    const envelope =
      opts.beforeSeq != null
        ? await this.getReplayBefore(opts.beforeSeq, opts.rootLimit)
        : await this.channelLog.replayInitial(
            opts.rootLimit ?? REPLAY_LIMIT,
            this.currentReplayContext()
          );
    return {
      logEvents: envelope.logEvents,
      ready: envelope.ready,
    };
  }

  async adminValidateLog(opts: { rootLimit?: number } = {}) {
    this.assertAdminCaller("adminValidateLog");
    const issues: Array<{ code: string; message: string; rowId?: number }> = [];
    const schema = await this.adminInspectSchema();
    for (const invariant of schema.invariants) {
      if (!invariant.ok)
        issues.push({ code: "schema", message: `schema invariant failed: ${invariant.name}` });
    }
    const rows = await this.channelLog.inspectRows({
      limit: Math.min(Math.max(opts.rootLimit ?? 10000, 1), 100000),
    });
    for (const row of rows) {
      const rowId = row["seq"] as number;
      try {
        const parsed = JSON.parse(row["payload"] as string);
        if (row["payload_kind"] === AGENTIC_EVENT_PAYLOAD_KIND) {
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            issues.push({
              code: "agentic-envelope",
              message: "agentic envelope payload is invalid",
              rowId,
            });
          }
        }
      } catch {
        issues.push({ code: "payload-json", message: "payload is not valid JSON", rowId });
      }
    }
    return {
      ok: issues.length === 0,
      issues,
      stats: {
        rowCount: rows.length,
      },
    };
  }

  // ── Method calls ────────────────────────────────────────────────────────

  /**
   * Initiate an async method call between participants.
   */
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    const transportCallId = opts?.transportCallId ?? callId;
    const invocationId = opts?.invocationId ?? callId;
    const turnId = opts?.turnId;
    const deadlineAt =
      opts?.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;
    storeCall(
      this.sql,
      transportCallId,
      invocationId,
      turnId,
      callerPid,
      targetPid,
      method,
      args,
      deadlineAt
    );
    this.scheduleNextAlarm();
    const payload = this.invocationStartedPayload(
      callerPid,
      targetPid,
      invocationId,
      transportCallId,
      turnId,
      method,
      args
    );
    const senderMetadata = this.getSenderMetadata(callerPid);
    const callEvent = await this.appendLogEvent(
      AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      callerPid,
      senderMetadata,
      {
        messageId: invocationId,
      }
    );
    broadcast(this.broadcastDeps, callEvent, { kind: "log", phase: "live" }, callerPid);

    // Deliver to target
    const target = this.sql
      .exec(`SELECT transport FROM participants WHERE id = ?`, targetPid)
      .toArray();

    if (target.length === 0) {
      // Target not found — deliver error to caller
      this.sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, transportCallId);
      await this.deliverCallResult(
        callerPid,
        invocationId,
        transportCallId,
        turnId,
        method,
        { error: `Target ${targetPid} not found` },
        true
      );
      return;
    }

    const t = target[0]!;
    if (t["transport"] === "do") {
      // Deliver to DO target via RPC call
      try {
        const result = await this.rpc.call(targetPid, "onMethodCall", [
          this.objectKey,
          transportCallId,
          method,
          args,
          { invocationId, turnId },
        ]);
        // Method returned a result — deliver to caller
        const pending = consumeCall(this.sql, transportCallId);
        if (pending) {
          const res = result as { result: unknown; isError?: boolean };
          await this.deliverCallResult(
            callerPid,
            pending.invocationId,
            pending.transportCallId,
            pending.turnId,
            pending.method,
            res.result,
            !!res.isError
          );
        }
      } catch (err) {
        const pending = consumeCall(this.sql, transportCallId);
        if (pending) {
          await this.deliverCallResult(
            callerPid,
            pending.invocationId,
            pending.transportCallId,
            pending.turnId,
            pending.method,
            err instanceof Error ? err.message : String(err),
            true
          );
        }
      }
    } else {
      // RPC targets receive the durable invocation start through the log broadcast above.
    }
  }

  /**
   * Handle an invocation result from a participant.
   */
  async handleMethodResult(
    transportCallId: string,
    content: unknown,
    isError: boolean
  ): Promise<number | undefined> {
    const pending = consumeCall(this.sql, transportCallId);
    if (!pending) {
      console.warn(
        `[Channel] Ignoring invocation result without pending call: ` +
          `channel=${this.objectKey} transportCallId=${transportCallId} isError=${isError}`
      );
      return undefined;
    }
    const resultId = await this.deliverCallResult(
      pending.callerId,
      pending.invocationId,
      pending.transportCallId,
      pending.turnId,
      pending.method,
      content,
      isError
    );
    this.scheduleNextAlarm();
    return resultId;
  }

  /**
   * Cancel a pending method call.
   */
  async cancelMethodCall(callId: string): Promise<void> {
    const cancelled = cancelCallDb(this.sql, callId);
    this.scheduleNextAlarm();
    // Notify the provider so it can abort the executing method
    if (cancelled) {
      const providerId = cancelled.targetId;
      await this.ensureMethodRoot(
        cancelled.invocationId,
        cancelled.callerId,
        providerId,
        cancelled.transportCallId,
        cancelled.turnId
      );
      const event = await this.appendLogEvent(
        AGENTIC_EVENT_PAYLOAD_KIND,
        this.invocationCancelledPayload(
          "system",
          cancelled.invocationId,
          cancelled.transportCallId,
          cancelled.turnId,
          "cancelled"
        ),
        "system"
      );
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
    }
  }

  /**
   * Mark a pending method call as timed out. The channel does not schedule
   * wall-clock timeouts itself; callers that own a deadline can close the call
   * through this durable terminal event.
   */
  async timeoutMethodCall(callId: string, reason?: string): Promise<void> {
    const cancelled = cancelCallDb(this.sql, callId);
    if (!cancelled) return;
    this.scheduleNextAlarm();
    await this.ensureMethodRoot(
      cancelled.invocationId,
      cancelled.callerId,
      cancelled.targetId,
      cancelled.transportCallId,
      cancelled.turnId
    );
    const event = await this.appendLogEvent(
      AGENTIC_EVENT_PAYLOAD_KIND,
      this.invocationCancelledPayload(
        "system",
        cancelled.invocationId,
        cancelled.transportCallId,
        cancelled.turnId,
        reason ?? "timed out"
      ),
      "system"
    );
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
  }

  private async deliverCallResult(
    callerId: string,
    invocationId: string,
    transportCallId: string | undefined,
    turnId: string | undefined,
    methodName: string | undefined,
    result: unknown,
    isError: boolean
  ): Promise<number | undefined> {
    const caller = this.sql.exec(`SELECT id FROM participants WHERE id = ?`, callerId).toArray();
    const callerPresent = caller.length > 0;

    // Persist and broadcast the result as the single canonical invocation completion path.
    await this.ensureMethodRoot(invocationId, callerId, undefined, transportCallId, turnId);
    const boundedResult = await this.boundMethodResultForDurableEvent(
      methodName,
      transportCallId,
      result
    );
    const payload = this.invocationResultPayload(
      callerId,
      invocationId,
      transportCallId,
      turnId,
      boundedResult,
      isError ?? false
    );
    const event = await this.appendLogEvent(AGENTIC_EVENT_PAYLOAD_KIND, payload, callerId);
    if (callerPresent) {
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, callerId);
    }
    return event.id;
  }

  private async boundMethodResultForDurableEvent(
    methodName: string | undefined,
    transportCallId: string | undefined,
    result: unknown
  ): Promise<unknown> {
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch (err) {
      return {
        omitted: true,
        reason: "method result is not JSON serializable",
        method: methodName ?? null,
        transportCallId: transportCallId ?? null,
        error: err instanceof Error ? err.message : String(err),
        preview: String(result).slice(0, METHOD_RESULT_PREVIEW_CHARS),
        summary: summarizeOversizedResult(result),
      };
    }

    const bytes = jsonByteLength(serialized);
    if (bytes <= MAX_INLINE_METHOD_RESULT_BYTES) return result;

    const capped: Record<string, unknown> = {
      omitted: true,
      reason: "method result exceeds durable inline budget",
      method: methodName ?? null,
      transportCallId: transportCallId ?? null,
      bytes,
      inlineLimitBytes: MAX_INLINE_METHOD_RESULT_BYTES,
      summary: summarizeOversizedResult(result),
    };
    try {
      const stored = await this.rpc.call<{ digest: string; size: number }>(
        "main",
        "blobstore.putText",
        [serialized]
      );
      capped["stored"] = {
        digest: stored.digest,
        size: stored.size,
        encoding: "json",
      };
    } catch (err) {
      capped["storageError"] = err instanceof Error ? err.message : String(err);
    }
    capped["preview"] = serialized.slice(0, METHOD_RESULT_PREVIEW_CHARS);
    return capped;
  }

  /**
   * Unified alarm scheduler — computes the minimum next alarm time across all
   * alarm sources (dedup cleanup, participant cleanup) to avoid one source
   * overwriting another's sooner alarm.
   *
   * Method calls do not have an internal wall-clock timeout — agentic
   * activities can run for arbitrary lengths. Pending calls are cancelled by
   * roster events (see cancelCallsForTarget) when a target participant leaves,
   * or by timeoutMethodCall when an external caller owns a deadline.
   */
  private scheduleNextAlarm(): void {
    const now = Date.now();
    let nextMs = Infinity;

    // Dedup cleanup — absolute deadline stored as timestamp
    const dedupDeadline = this.getStateValue("dedup_cleanup_at");
    if (dedupDeadline) {
      const dedupMs = Math.max(Number(dedupDeadline) - now, 100);
      nextMs = Math.min(nextMs, dedupMs);
    }

    // Participant cleanup — 1 minute if RPC participants exist
    const rpcCount = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM participants WHERE transport = 'rpc'`)
      .toArray();
    if ((rpcCount[0]?.["cnt"] as number) > 0) {
      nextMs = Math.min(nextMs, PARTICIPANT_CLEANUP_INTERVAL_MS);
    }

    const nextDeadline = this.sql
      .exec(`SELECT MIN(deadline_at) AS deadline FROM pending_calls WHERE deadline_at IS NOT NULL`)
      .toArray()[0]?.["deadline"];
    if (typeof nextDeadline === "number") {
      nextMs = Math.min(nextMs, Math.max(nextDeadline - now, 100));
    }

    if (nextMs < Infinity) {
      this.setAlarm(nextMs);
    }
  }

  private scheduleDedupCleanup(): void {
    if (this.getStateValue("dedup_cleanup_at")) return;
    this.setStateValue("dedup_cleanup_at", String(Date.now() + 5 * 60 * 1000));
    this.scheduleNextAlarm();
  }

  // ── Alarm (stale participant cleanup + dedup key cleanup) ─────────────────

  override async alarm(): Promise<void> {
    await super.alarm();

    // Evict stale RPC participants (not DO participants — those are persistent).
    // Stale eviction itself fails any pending tool calls targeting the evicted
    // participant via cancelCallsForTarget — see evictStaleParticipants below.
    await this.evictStaleParticipants();

    // Phase 0B: Clean up expired dedup keys
    const dedupCutoff = Date.now() - 5 * 60 * 1000;
    this.sql.exec(`DELETE FROM dedup_keys WHERE created_at < ?`, dedupCutoff);
    const remaining = this.sql.exec(`SELECT COUNT(*) as cnt FROM dedup_keys`).toArray();
    if ((remaining[0]?.["cnt"] as number) === 0) {
      this.deleteStateValue("dedup_cleanup_at");
    } else {
      // Reschedule for another 5 minutes
      this.setStateValue("dedup_cleanup_at", String(Date.now() + 5 * 60 * 1000));
    }

    await this.timeoutExpiredPendingCalls();

    // Unified reschedule — computes minimum next alarm across all sources
    this.scheduleNextAlarm();
  }

  private async timeoutExpiredPendingCalls(): Promise<void> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE deadline_at IS NOT NULL AND deadline_at <= ?`,
        now
      )
      .toArray();
    for (const row of rows) {
      await this.timeoutMethodCall(
        row["transport_call_id"] as string,
        "Channel method deadline expired"
      );
    }
  }

  private async evictStaleParticipants(): Promise<void> {
    const cutoff = Date.now() - PARTICIPANT_STALE_MS;
    const stale = this.sql
      .exec(
        `SELECT id, metadata FROM participants WHERE transport = 'rpc' AND connected_at < ?`,
        cutoff
      )
      .toArray();

    for (const row of stale) {
      const pid = row["id"] as string;
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row["metadata"] as string);
      } catch {
        /* corrupted metadata, use empty default */
      }
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
      cleanupDeliveryChain(pid);
      await this.failPendingCallsTargeting(pid, "disconnect");
      await this.publishPresenceEvent(pid, "leave", metadata, "disconnect");
    }

    if (stale.length > 0) {
      console.log(`[Channel] Evicted ${stale.length} stale RPC participant(s)`);
    }

    // Schedule next cleanup if there are still rpc participants
    this.scheduleParticipantCleanup();
  }

  private scheduleParticipantCleanup(): void {
    this.scheduleNextAlarm();
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite.
   * Forks the durable GAD channel log prefix, then clears signal-only state.
   */
  async postClone(parentChannelId: string, forkPointId: number): Promise<void> {
    // Fix identity: cloneDO copies parent's __objectKey; overwrite with our actual key
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    // RPC identity is automatically updated: the dispatch that calls postClone
    // delivers the clone's fresh instance token via X-Instance-Token header,
    // and fetch() always overwrites identity from headers.
    this.setStateValue("forkedFrom", parentChannelId);
    this.setStateValue("forkPointId", String(forkPointId));
    await this.channelLog.forkFrom(parentChannelId, forkPointId);
    // Clear roster
    this.sql.exec(`DELETE FROM participants`);
    // Clear pending calls
    this.sql.exec(`DELETE FROM pending_calls`);
    // Clear dedup keys
    this.sql.exec(`DELETE FROM dedup_keys`);
  }

  // ── State introspection ─────────────────────────────────────────────────

  override async getState(): Promise<Record<string, unknown>> {
    const replay = await this.channelLog.replayInitial(1, this.currentReplayContext());
    const participants = this.sql.exec(`SELECT * FROM participants`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return {
      envelopeCount: replay.ready.envelopeCount,
      participants,
      pendingCalls,
      state,
    };
  }
}
