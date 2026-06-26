/**
 * PubSubChannel — Durable Object for pub/sub messaging.
 *
 * WS2: a GENERIC substrate — durable ordered log (delegated to GAD's unified
 * log), live fan-out, roster, and call transport. Every agentic decision
 * (agent-hop stamping, conversation fold, invocation payload vocabulary)
 * lives in `@workspace/channel-policies`, selected by name from channel
 * config and hosted by `policy-host.ts`.
 *
 * State taxonomy (P1): the channel log in GAD is the authority;
 * `pending_calls` (calls.ts), `policy_state:*` (policy-host.ts), and
 * `dedup_keys` are declared caches — deletable at any moment; `participants`
 * is operational transport state (live connections, observed into the log as
 * presence events).
 */

/// <reference path="../workerd.d.ts" />
import { rpc, DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import type { BootstrapSnapshot, ParticipantSnapshot } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  participantRefFromMetadata,
  publicParticipantMetadata,
  type AgenticEvent,
  type AppendIdempotency,
  type InvocationOutcome,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { PARTICIPANT_SESSION_METADATA_KEY } from "@workspace/pubsub/internal-constants";
import {
  participantMetadataSchema,
  participantIsAgentVessel,
  type SubscribeResult,
  type ChannelConfig,
  type PresencePayload,
  type StoredAttachment,
} from "./types.js";
import {
  broadcast,
  buildChannelEvent,
  channelEventToRpcSignal,
  queueEmit,
  queueDoEnvelope,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import { ChannelLog, type ChannelReplayContext, type MessageTypeDefinition } from "./log-store.js";
import { PolicyHost, policyViewFromLogEnvelope } from "./policy-host.js";
import { CallTransport, type PendingCallRow } from "./calls.js";
import type { PolicyEnvelopeView } from "@workspace/channel-policies";

/** How long before an RPC participant is considered stale (no heartbeat). */
const PARTICIPANT_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** Default channel-envelope replay window. */
const REPLAY_LIMIT = 50;
/** Dedup keys are a latency cache; the durable dedupe is the `ik:{key}`
 *  envelope id in the log lineage. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
/** A pending call is eligible for lost-delivery redelivery once it is older
 *  than this (its original delivery already happened at creation). */
const PENDING_REDELIVERY_STALE_MS = 10_000;
/** Bounded redelivery cadence while calls are in flight. Anchored on a
 *  swept-at marker that advances each sweep — NOT on created_at (which never
 *  advances and would re-arm the alarm every 100ms for the call's lifetime,
 *  defeating hibernation). */
const PENDING_REDELIVERY_INTERVAL_MS = 15_000;
const PENDING_REDELIVERY_SWEPT_AT_KEY = "pendingRedeliverySweptAt";

const DEFAULT_POLICY_NAME = "agentic.conversation.v1";

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
  static override schemaVersion = 105;
  private _channelLog: ChannelLog | null = null;
  private _policyHost: PolicyHost | null = null;
  private _calls: CallTransport | null = null;
  private readonly publishDedupInFlight = new Map<string, Promise<ChannelEvent>>();

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
        transport TEXT NOT NULL CHECK (transport IN ('rpc','do')),
        connected_at INTEGER NOT NULL,
        session_id TEXT,
        handle TEXT,
        do_source TEXT,
        do_class TEXT,
        do_object_key TEXT
      )
    `);
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_handle
         ON participants(handle) WHERE handle IS NOT NULL`
    );
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
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_target ON pending_calls(target_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_deadline
         ON pending_calls(deadline_at) WHERE deadline_at IS NOT NULL`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dedup_keys (
        key TEXT PRIMARY KEY,
        result_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_dedup_keys_created ON dedup_keys(created_at)`);
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
    // Channel-side registry cache deleted for good — GAD's
    // channel_message_types projection is the only copy.
    this.sql.exec(`DROP TABLE IF EXISTS message_types`);
    this.createTables();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
    };
  }

  private get channelLog(): ChannelLog {
    this._channelLog ??= new ChannelLog(
      {
        call: <T = unknown>(targetId: string, method: string, args: unknown[]) =>
          this.rpc.call<T>(targetId, method, args),
      },
      this.objectKey
    );
    return this._channelLog;
  }

  private get policyHost(): PolicyHost {
    this._policyHost ??= new PolicyHost({
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
      deleteStateValue: (key) => this.deleteStateValue(key),
      log: this.channelLog,
      policyNames: () => this.getChannelConfig()?.policies,
    });
    return this._policyHost;
  }

  private get calls(): CallTransport {
    this._calls ??= new CallTransport({
      sql: this.sql,
      objectKey: this.objectKey,
      log: this.channelLog,
      builders: () => this.policyHost.callBuilders(),
      appendDurable: (input) => this.appendDurable(input),
      broadcastLive: (event, senderId, ref) =>
        broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, senderId),
      emitSignal: (participantId, event) => {
        void queueEmit(this.broadcastDeps, participantId, {
          channelId: this.objectKey,
          message: channelEventToRpcSignal(event),
        });
      },
      participantRef: (participantId) => this.participantRef(participantId),
      getSenderMetadata: (participantId) => this.getSenderMetadata(participantId),
      participantTransport: (participantId) => {
        const rows = this.sql
          .exec(`SELECT transport FROM participants WHERE id = ?`, participantId)
          .toArray();
        return rows.length > 0 ? (rows[0]!["transport"] as "rpc" | "do") : null;
      },
      rpcCall: (targetId, method, args) => this.rpc.call(targetId, method, args),
      waitUntil: (promise) => {
        if (this.ctx.waitUntil) this.ctx.waitUntil(promise);
        else void promise;
      },
      scheduleNextAlarm: () => this.scheduleNextAlarm(),
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
    });
    return this._calls;
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

  // ── The ONE append pipeline (WS2 §4.3) ───────────────────────────────────
  //
  //  1. policy state catch-up + pure annotate
  //  2. durable append (GAD validates + sanitizes + projects in the txn)
  //  3. fold the appended envelope into the policy caches
  //
  // A crash between 2 and 3 leaves the cache behind head; the next
  // getState() heals it (cache amnesia by construction).

  private async appendDurable(input: {
    type: string;
    payload: unknown;
    senderId: string;
    senderMetadata?: Record<string, unknown>;
    messageId?: string;
    /** "idempotent-by-id" is reserved for the client publish path. */
    idempotency?: AppendIdempotency;
    attachments?: StoredAttachment[];
  }): Promise<ChannelEvent> {
    const payloadRecord =
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : null;
    const senderKind =
      ((payloadRecord?.["actor"] as { kind?: string } | undefined)?.kind as string | undefined) ??
      "unknown";
    const annotations = await this.policyHost.annotate({
      payloadKind: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderKind,
    });
    const event = await this.channelLog.append({
      type: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderMetadata: input.senderMetadata,
      messageId: input.messageId,
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      ...(annotations ? { annotations } : {}),
      attachments: input.attachments,
    });
    this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
    return event;
  }

  private policyViewFromChannelEvent(event: ChannelEvent): PolicyEnvelopeView {
    const actorKind = ((event.payload as { actor?: { kind?: string } } | null)?.actor?.kind ??
      "unknown") as string;
    return {
      envelopeId: event.messageId,
      seq: event.id,
      payloadKind: event.type,
      payload: event.payload,
      senderId: event.senderId,
      senderKind: actorKind,
      ...(event.annotations ? { annotations: event.annotations } : {}),
      appendedAt: new Date(event.ts).toISOString(),
    };
  }

  private currentReplayContext(): ChannelReplayContext {
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

  /** Push this channel's display title to the server-side registry. */
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
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `${method}: participant ${participantId} cannot be used by caller ${caller?.callerId ?? "unknown"}`
      );
    }
  }

  private isAuthorizedParticipantCaller(participantId: string): boolean {
    const caller = this.caller;
    if (!caller?.callerId) return true;
    if (caller.callerId === participantId) return true;
    return caller.callerKind === "panel" && caller.callerPanelId === participantId;
  }

  private isPrivilegedRpcCaller(): boolean {
    const caller = this.caller;
    return (
      caller?.callerId === "main" ||
      caller?.callerKind === "server" ||
      caller?.callerKind === "shell"
    );
  }

  private assertAdminCaller(method: string): void {
    if (this.isPrivilegedRpcCaller()) return;
    const caller = this.caller;
    throw new Error(
      `${method}: privileged caller required (got ${caller?.callerKind ?? "unknown"} ${caller?.callerId ?? "unknown"})`
    );
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

    const event = await this.appendDurable({
      type: "presence",
      payload,
      senderId,
      senderMetadata: publicMetadata,
    });
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
   * Subscribe a participant to this channel. Inserts the participant first,
   * then builds replay, so an initial roster snapshot includes the subscriber.
   */
  @rpc({ callers: ["panel", "do"] })
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<SubscribeResult> {
    const doRef = parseDOParticipantId(participantId);
    const transport = doRef ? "do" : "rpc";
    const callerId = this.rpcCallerId;
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot be subscribed by caller ${caller?.callerId ?? "unknown"}`
      );
    }

    // Validate advertised method names FIRST with the exact legacy message
    // (agents depend on the text), then the zod schema for everything else.
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
    const parsedMetadata = participantMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success) {
      const issue = parsedMetadata.error.issues[0];
      throw new Error(
        `subscribe: invalid participant metadata at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid"}`
      );
    }

    const participantSessionId =
      typeof metadata[PARTICIPANT_SESSION_METADATA_KEY] === "string"
        ? (metadata[PARTICIPANT_SESSION_METADATA_KEY] as string)
        : null;

    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Handle uniqueness: friendly pre-check (exact legacy message); the
    // partial unique index is the race-proof enforcement underneath.
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

    if (doRef && callerId) {
      await this.rpc.call("main", "workers.resolveDurableObject", [
        doRef.source,
        doRef.className,
        doRef.objectKey,
      ]);
    }

    // Re-subscribe with the same participant ID: replace the roster entry, but
    // only redeliver in-flight calls if the underlying client session changed.
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
      cleanupDeliveryChain(this.objectKey, participantId);
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

    try {
      this.sql.exec(
        `INSERT INTO participants (
           id, metadata, transport, connected_at, session_id, handle,
           do_source, do_class, do_object_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        participantId,
        JSON.stringify(storedMetadata),
        transport === "do" ? "do" : "rpc",
        Date.now(),
        participantSessionId,
        handle,
        doRef?.source ?? null,
        doRef?.className ?? null,
        doRef?.objectKey ?? null
      );
    } catch (err) {
      if (handle && err instanceof Error && /unique/iu.test(err.message)) {
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(unknown) in this channel. Handles must be unique.`
        );
      }
      throw err;
    }

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
    // Deliver the structured `onChannelEnvelope` replay only to DO participants
    // that opted in (agent vessels). RPC-style DO clients (the eval's
    // connectViaRpc) receive replay via the `channel:message` emits + subscribe
    // ACK fallback, and have no onChannelEnvelope handler.
    this.queueReplayEnvelope(
      participantId,
      envelope,
      doRef != null && metadata["receivesChannelEnvelopes"] === true
    );

    // Redelivery + the reconnect/redelivery alarm are RPC-STYLE concerns: they serve participants that
    // settle method calls via the broadcast `started` + submitMethodResult — panels AND RPC-style
    // connectionless DO clients (the eval). Agent vessels get method calls via onMethodCall and don't
    // process the redelivered `started`, so they're excluded. Gate on the agent-vessel discriminator,
    // NOT `transport` (which would wrongly exclude the eval just because its id is a DO id).
    const isAgentVessel = participantIsAgentVessel(this.getSenderMetadata(participantId));
    if (sessionReplaced && !isAgentVessel) this.calls.redeliverPendingCallsTo(participantId);

    if (!isAgentVessel) {
      this.scheduleNextAlarm();
    }

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
      envelope,
    };
  }

  private queueReplayEnvelope(
    subscriberId: string,
    envelope: Awaited<ReturnType<ChannelLog["replayInitial"]>>,
    deliverToDo: boolean
  ): void {
    const onFatal = (err: { code?: string }) => {
      if (
        err?.code === "TARGET_NOT_REACHABLE" ||
        err?.code === "RECONNECT_GRACE_EXPIRED" ||
        err?.code === "DO_NOT_CREATED"
      ) {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(this.objectKey, subscriberId);
        return true;
      }
      return false;
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
        void queueDoEnvelope(
          this.broadcastDeps,
          subscriberId,
          {
            kind: "log",
            phase: "replay",
            event,
          },
          onFatal
        );
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
        void queueDoEnvelope(this.broadcastDeps, subscriberId, message, onFatal);
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
      void queueDoEnvelope(this.broadcastDeps, subscriberId, readyMessage, onFatal);
    }
  }

  @rpc({ callers: ["panel", "do"] })
  async unsubscribe(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribe");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  @rpc({ callers: ["server", "shell"] })
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
    cleanupDeliveryChain(this.objectKey, participantId);
    await this.calls.failPendingCallsTargeting(participantId, leaveReason);
    await this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);
    this.scheduleNextAlarm();
  }

  /** Abandoned terminals for every pending call targeting a leaver. */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    await this.calls.failPendingCallsTargeting(targetId, reason);
  }

  /** Heartbeat from an RPC participant. */
  @rpc({ callers: ["panel", "do", "worker"] })
  async touch(participantId: string): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET connected_at = ? WHERE id = ?`,
      Date.now(),
      participantId
    );
  }

  /**
   * Publish a typed message. The transport is OPAQUE to payload semantics:
   * GAD validates agentic payloads at append-time inside the txn; policies
   * annotate (never mutate) the envelope.
   */
  @rpc({ callers: ["panel", "do", "worker"] })
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
      const existingId = existing[0]?.["result_id"] as number | null | undefined;
      if (existingId != null) return { id: existingId };
      const inFlight = this.publishDedupInFlight.get(idempotencyKey);
      if (inFlight) return { id: (await inFlight).id };
      if (existing.length > 0) {
        // A previous publish reserved the key but failed or the DO restarted
        // before storing a result. Let this request become the new owner.
        this.sql.exec(`DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`, idempotencyKey);
      }
    }

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;
    const event = await this.runDedupedPublish(idempotencyKey, async () =>
      this.appendDurable({
        type,
        payload,
        senderId: participantId,
        senderMetadata,
        // Durable idempotency is the deterministic envelope id in the log
        // lineage; dedup_keys is only a latency cache (WS2 §3.2). Client
        // retries carry a stable key with volatile payload fields, so this
        // path — and ONLY this path — appends first-write-wins.
        messageId: idempotencyKey ? `ik:${idempotencyKey}` : undefined,
        ...(idempotencyKey ? { idempotency: "idempotent-by-id" as const } : {}),
        attachments,
      })
    );

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, participantId);
    return { id: event.id };
  }

  /** Policy fold state (replaces getConversationState — WS2 §4.4). */
  @rpc({ callers: ["panel", "do", "server"] })
  async getPolicyState(name?: string): Promise<{
    policy: string;
    version: number;
    foldedThroughSeq: number;
    state: unknown;
  }> {
    return this.policyHost.getState(name ?? DEFAULT_POLICY_NAME);
  }

  private async runDedupedPublish(
    idempotencyKey: string | undefined,
    append: () => Promise<ChannelEvent>
  ): Promise<ChannelEvent> {
    if (!idempotencyKey) return append();

    let promise!: Promise<ChannelEvent>;
    promise = (async () => {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, NULL, ?)`,
        idempotencyKey,
        Date.now()
      );
      try {
        const event = await append();
        this.sql.exec(
          `UPDATE dedup_keys SET result_id = ?, created_at = ? WHERE key = ?`,
          event.id,
          Date.now(),
          idempotencyKey
        );
        this.scheduleNextAlarm();
        return event;
      } catch (err) {
        this.sql.exec(`DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`, idempotencyKey);
        throw err;
      } finally {
        if (this.publishDedupInFlight.get(idempotencyKey) === promise) {
          this.publishDedupInFlight.delete(idempotencyKey);
        }
      }
    })();

    this.publishDedupInFlight.set(idempotencyKey, promise);
    return promise;
  }

  /**
   * Broadcast envelopes that were durably appended to GAD outside this DO
   * (trajectory publication fan-out). Folds each into the policy caches.
   */
  @rpc({ callers: ["server", "do"] })
  async broadcastStoredEnvelopes(envelopeIds: string[]): Promise<{ broadcasted: number }> {
    let broadcasted = 0;
    for (const envelopeId of envelopeIds) {
      if (typeof envelopeId !== "string" || envelopeId.length === 0) continue;
      const event = await this.channelLog.getEventByEnvelopeId(envelopeId);
      if (!event) continue;
      this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, event.senderId);
      broadcasted += 1;
    }
    return { broadcasted };
  }

  /** Mark a message as errored (durable `error` channel event). */
  @rpc({ callers: ["panel", "do", "worker"] })
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
    const event = await this.appendDurable({
      type: "error",
      payload,
      senderId: participantId,
      senderMetadata,
    });
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getReplayAfter(sinceId: number) {
    return this.channelLog.replayAfter(sinceId, this.currentReplayContext());
  }

  /** Send a non-durable signal message. */
  @rpc({ callers: ["panel", "do", "worker"] })
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

  /** Replace a participant's metadata entirely. */
  @rpc({ callers: ["panel", "do", "worker"] })
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    await this.updateParticipantMetadata(participantId, metadata);
  }

  @rpc({ callers: ["server", "shell"] })
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

  @rpc({ callers: ["panel", "do", "worker"] })
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  @rpc({ callers: ["server", "shell"] })
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

  /** Get all participants with DO identity when available. */
  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      metadata: Record<string, unknown>;
      transport: string;
      doRef?: { source: string; className: string; objectKey: string };
    }>
  > {
    const rows = this.sql
      .exec(`SELECT id, metadata, transport, do_source, do_class, do_object_key FROM participants`)
      .toArray();
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
      if (row["do_source"] && row["do_class"] && row["do_object_key"]) {
        entry.doRef = {
          source: row["do_source"] as string,
          className: row["do_class"] as string,
          objectKey: row["do_object_key"] as string,
        };
      }
      return entry;
    });
  }

  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getConfig(): Promise<ChannelConfig | null> {
    return this.getChannelConfig();
  }

  @rpc({ callers: ["panel", "server"] })
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    this.policyHost.invalidatePolicySelection();
    const event = await this.appendDurable({
      type: "config-update",
      payload: newConfig,
      senderId: "system",
    });
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
    void this.refreshOwnTitle();
    return newConfig;
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getReplayBefore(beforeSeq: number, limit?: number) {
    return this.channelLog.replayBefore(beforeSeq, limit ?? 100, this.currentReplayContext());
  }

  // Registry reads: direct passthrough to GAD's channel_message_types
  // projection (hydrated — published `source` payloads are blob-spilled).

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return this.channelLog.listMessageTypes();
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return this.channelLog.getMessageType(typeId);
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageSender(participantId: string, messageId: string): Promise<string | null> {
    this.assertParticipantCaller(participantId, "getMessageSender");
    const replay = await this.channelLog.replayInitial(500, this.currentReplayContext());
    for (const event of [...replay.logEvents].reverse()) {
      if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
      const payload = event.payload as {
        kind?: string;
        causality?: Record<string, unknown>;
      } | null;
      if (!payload || typeof payload !== "object") continue;
      if (payload.kind !== "message.completed") continue;
      if (payload.causality?.["messageId"] === messageId) return event.senderId;
    }
    return null;
  }

  @rpc({ callers: ["server", "shell"] })
  async adminInspectSchema() {
    this.assertAdminCaller("adminInspectSchema");
    const tableNames = ["participants", "pending_calls", "dedup_keys"];
    const tables = tableNames.map((table) => ({
      table,
      columns: this.sql.exec(`PRAGMA table_info(${table})`).toArray(),
    }));
    const indexes = tableNames.flatMap((table) => {
      const list = this.sql.exec(`PRAGMA index_list(${table})`).toArray();
      return list.map((idx) => ({
        table,
        ...idx,
        columns: this.sql.exec(`PRAGMA index_info(${idx["name"] as string})`).toArray(),
      }));
    });
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

  @rpc({ callers: ["server", "shell"] })
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

  @rpc({ callers: ["server", "shell"] })
  async adminInspectEnvelope(envelopeId: string) {
    this.assertAdminCaller("adminInspectMessageChain");
    return { rows: await this.channelLog.inspectEnvelope(envelopeId) };
  }

  @rpc({ callers: ["server", "shell"] })
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

  @rpc({ callers: ["server", "shell"] })
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

  // ── Method calls (calls.ts — pending_calls is a declared cache) ──────────

  @rpc({ callers: ["panel", "do", "worker"] })
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    await this.calls.callMethod(callerPid, targetPid, callId, method, args, opts);
  }

  @rpc({ callers: ["panel", "do", "worker"] })
  async submitMethodResult(
    participantId: string,
    transportCallId: string,
    content: unknown,
    isError: boolean,
    opts?: {
      invocationId?: string;
      turnId?: string;
      terminalOutcome?: InvocationOutcome;
      terminalReasonCode?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<{ id?: number; dropped?: boolean; reason?: string; recovered?: boolean }> {
    this.assertParticipantCaller(participantId, "submitMethodResult");
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodResult"
    );
    if (resolution.kind === "terminal") {
      return { id: resolution.eventId };
    }
    if (resolution.kind === "missing") {
      // No live pending row AND no durable `started`/terminal even after
      // reconcile: a cache-cold / lost record. Dropping the result here strands
      // the caller forever — its parked invocation only settles on a terminal
      // carrying the same invocationId/transportCallId, so with NO terminal the
      // turn never closes and waitForIdle hangs. Recover by rooting the method
      // (sanctioned synthetic `started`, satisfying the fold) and appending +
      // broadcasting a real terminal keyed on the caller's invocationId.
      const id = await this.calls.settleMissingCall(
        participantId,
        transportCallId,
        content,
        isError,
        {
          ...(opts?.invocationId ? { invocationId: opts.invocationId } : {}),
          ...(opts?.turnId ? { turnId: opts.turnId } : {}),
          ...(opts?.terminalOutcome ? { terminalOutcome: opts.terminalOutcome } : {}),
          ...(opts?.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
        }
      );
      console.warn(
        `[Channel] submitMethodResult recovered a lost call (no pending row): rooted method + ` +
          `appended terminal so the caller settles: channel=${this.objectKey} ` +
          `transportCallId=${transportCallId} isError=${isError} terminalSeq=${id}`
      );
      return { id, dropped: false, recovered: true };
    }
    const id = await this.calls.settleCall(
      transportCallId,
      content,
      isError,
      opts?.terminalOutcome,
      opts?.terminalReasonCode,
      { attachments: opts?.attachments }
    );
    return { id };
  }

  @rpc({ callers: ["panel", "do", "worker"] })
  async submitMethodProgress(
    participantId: string,
    transportCallId: string,
    content: unknown,
    opts?: {
      invocationId?: string;
      turnId?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "submitMethodProgress");
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodProgress"
    );
    if (resolution.kind !== "pending") {
      return;
    }
    await this.calls.submitMethodProgress(transportCallId, content, {
      attachments: opts?.attachments,
    });
  }

  /** Terminal result entry point (kept for DO delivery + external callers). */
  async handleMethodResult(
    transportCallId: string,
    content: unknown,
    isError: boolean,
    terminalOutcome?: InvocationOutcome,
    terminalReasonCode?: string,
    transportOpts?: {
      attachments?: StoredAttachment[];
    }
  ): Promise<number | undefined> {
    return this.calls.settleCall(
      transportCallId,
      content,
      isError,
      terminalOutcome,
      terminalReasonCode,
      { attachments: transportOpts?.attachments }
    );
  }

  @rpc({ callers: ["server"] })
  async cancelMethodCall(callId: string): Promise<void> {
    await this.calls.cancelMethodCall(callId, "cancelled");
  }

  @rpc({ callers: ["server"] })
  async timeoutMethodCall(callId: string, reason?: string): Promise<void> {
    const pending = await this.calls.cancelMethodCall(callId, reason ?? "timed out");
    if (!pending) return;
    // Tell the target agent its call rotted — the caller already got a
    // terminal, but the agent otherwise never learns it failed to respond.
    await this.publishMethodCallFeedback(
      pending.targetId,
      pending.transportCallId,
      pending.method,
      reason ?? "method call deadline expired"
    );
  }

  /** Publish a ui.feedback event targeted at a participant (best effort). */
  private async publishMethodCallFeedback(
    targetId: string,
    transportCallId: string,
    method: string,
    message: string
  ): Promise<void> {
    try {
      const event: AgenticEvent<"ui.feedback"> = {
        kind: "ui.feedback",
        actor: { kind: "system", id: "channel" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          target: this.participantRef(targetId),
          category: "method_call_failed",
          refs: { callId: transportCallId },
          error: { message: `${method}: ${message}` },
          occurrenceKey: `method_call_failed:${transportCallId}`,
        },
        createdAt: new Date().toISOString(),
      };
      const logged = await this.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: event,
        senderId: "system",
      });
      broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, "system");
    } catch (err) {
      console.warn(`[Channel] failed to publish method-call feedback for ${transportCallId}:`, err);
    }
  }

  /** Convergence sweep for the pending_calls cache (P3 — also an ops hook). */
  async reconcilePendingCalls(force = false): Promise<{ inserted: number; deleted: number }> {
    return this.calls.reconcilePendingCalls(force);
  }

  // ── Alarm — single scheduler over pure next-time sources (WS2 §8.2) ──────

  private nextDedupSweepAt(): number | null {
    const oldest = this.sql.exec(`SELECT MIN(created_at) AS oldest FROM dedup_keys`).toArray()[0]?.[
      "oldest"
    ];
    return typeof oldest === "number" ? oldest + DEDUP_TTL_MS : null;
  }

  private nextParticipantSweepAt(now: number): number | null {
    void now;
    const earliest = this.sql
      .exec(`SELECT MIN(connected_at) AS connectedAt FROM participants WHERE transport = 'rpc'`)
      .toArray()[0]?.["connectedAt"];
    return typeof earliest === "number" ? earliest + PARTICIPANT_STALE_MS : null;
  }

  private scheduleNextAlarm(): void {
    const now = Date.now();
    const sources = [
      this.nextDedupSweepAt(),
      this.nextParticipantSweepAt(now),
      this.calls.nextCallDeadlineAt(),
      // While method calls are in flight, wake soon enough for the
      // lost-delivery redelivery sweep (at-least-once within seconds, not
      // only at the 5-minute expiry).
      this.nextPendingRedeliveryAt(now),
    ].filter((value): value is number => typeof value === "number");
    if (sources.length === 0) {
      this.deleteAlarm();
      return;
    }
    this.setAlarm(Math.max(Math.min(...sources) - now, 100));
  }

  private nextPendingRedeliveryAt(now: number): number | null {
    void now;
    const oldest = this.sql
      .exec(`SELECT MIN(created_at) AS createdAt FROM pending_calls`)
      .toArray()[0]?.["createdAt"];
    if (typeof oldest !== "number") return null;
    // First redelivery one stale-window after the call was created; every
    // subsequent one is `interval` after the LAST sweep (the marker advances
    // in alarm()), so the alarm never busy-loops while a long call runs.
    const firstEligible = oldest + PENDING_REDELIVERY_STALE_MS;
    const lastSwept = Number(this.getStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY) ?? 0);
    const nextRecurring =
      lastSwept > 0 ? lastSwept + PENDING_REDELIVERY_INTERVAL_MS : firstEligible;
    return Math.max(firstEligible, nextRecurring);
  }

  override async alarm(): Promise<void> {
    await super.alarm();

    await this.evictStaleParticipants();

    // Dedup TTL sweep — unconditional (no latch; a key inserted while no
    // publish succeeds is still swept).
    this.sql.exec(`DELETE FROM dedup_keys WHERE created_at < ?`, Date.now() - DEDUP_TTL_MS);

    await this.calls.timeoutExpiredPendingCalls(async (pending, message) => {
      await this.publishMethodCallFeedback(
        pending.targetId,
        pending.transportCallId,
        pending.method,
        message
      );
    });

    // Convergence sweep for the pending_calls cache (cheap: skipped when the
    // observed head hasn't moved).
    try {
      await this.calls.reconcilePendingCalls();
    } catch (err) {
      console.warn(`[Channel] reconcilePendingCalls failed:`, err);
    }

    // At-least-once for in-flight method calls: a delivery lost to a session
    // replacement race otherwise strands the call until expiry. Re-emitting
    // is idempotent client-side (executing/submitted call-id sets). The
    // swept-at marker advances the next redelivery deadline by one interval
    // so the alarm can't busy-loop on a long-running call.
    try {
      const pendingCount = this.sql
        .exec(`SELECT COUNT(*) AS cnt FROM pending_calls`)
        .toArray()[0]?.["cnt"];
      if (typeof pendingCount === "number" && pendingCount > 0) {
        this.redeliverStalePendingCalls();
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, String(Date.now()));
      } else {
        // No pending calls — clear the marker so the next call's first
        // redelivery is anchored to its own creation, not a stale sweep.
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, "0");
      }
    } catch (err) {
      console.warn(`[Channel] pending-call redelivery sweep failed:`, err);
    }

    this.scheduleNextAlarm();
  }

  /** Re-emit pending calls older than one alarm tick whose target is a
   *  connected rpc participant (lost-delivery healing). */
  private redeliverStalePendingCalls(): void {
    const cutoff = Date.now() - 10_000;
    const targets = new Set<string>();
    for (const row of this.sql
      .exec(`SELECT DISTINCT target_id FROM pending_calls WHERE created_at < ?`, cutoff)
      .toArray()) {
      targets.add(String((row as Record<string, unknown>)["target_id"]));
    }
    for (const targetId of targets) {
      const connected = this.sql
        .exec(`SELECT 1 FROM participants WHERE id = ? AND transport = 'rpc'`, targetId)
        .toArray();
      if (connected.length > 0) this.calls.redeliverPendingCallsTo(targetId);
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
      cleanupDeliveryChain(this.objectKey, pid);
      await this.calls.failPendingCallsTargeting(pid, "disconnect");
      await this.publishPresenceEvent(pid, "leave", metadata, "disconnect");
    }

    if (stale.length > 0) {
      console.log(`[Channel] Evicted ${stale.length} stale RPC participant(s)`);
      this.scheduleNextAlarm();
    }
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite. Forks the durable
   * channel log (no-copy), clears operational state, and REBUILDS the policy
   * caches by replaying the forked lineage — conversation state survives the
   * fork (WS2 §4.5).
   */
  @rpc({ callers: ["worker", "server"] })
  async postClone(
    parentChannelId: string,
    forkPointId: number,
    // The clone's new context. A true context fork (`runtime.cloneContext`) lands
    // the clone in a fresh, isolated context; thread it so the channel's stored
    // contextId re-homes (matching the clone's entity record). Omit for a legacy
    // same-context clone (keeps the inherited contextId).
    newContextId?: string
  ): Promise<void> {
    // Fix identity: cloneDO copies parent's __objectKey; overwrite with our actual key
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    // Re-home the context (bypasses initChannel's mismatch guard by writing the
    // state row directly — this IS the authorized re-home).
    if (newContextId !== undefined) {
      this.setStateValue("contextId", newContextId);
    }
    this.setStateValue("forkedFrom", parentChannelId);
    this.setStateValue("forkPointId", String(forkPointId));
    await this.channelLog.forkFrom(parentChannelId, forkPointId);
    // Clear operational state + caches
    this.sql.exec(`DELETE FROM participants`);
    this.sql.exec(`DELETE FROM pending_calls`);
    this.sql.exec(`DELETE FROM dedup_keys`);
    await this.policyHost.rebuildAfterFork();
    // Rebuild pending_calls for any started-without-terminal in the inherited
    // prefix (they will be abandoned/redelivered by normal roster flow).
    await this.calls.reconcilePendingCalls(true);
  }

  // ── State introspection ─────────────────────────────────────────────────

  @rpc({ callers: ["panel", "server", "shell"] })
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

export type { PendingCallRow };
