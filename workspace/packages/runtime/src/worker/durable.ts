import type { ChannelEvent, HarnessConfig, HarnessOutput, TurnInput, ParticipantDescriptor, UnsubscribeResult, Attachment, ChannelBroadcastEventRaw } from "@natstack/harness/types";
import { toChannelEvent } from "@natstack/harness/types";
import { needsApprovalForTool } from "@natstack/pubsub";
import { PubSubDOClient } from "./pubsub-client.js";
import { ServerDOClient } from "./server-client.js";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";

// Minimal types for workerd DurableObject context (cannot import cloudflare:workers in Node)
interface DurableObjectContext {
  storage: {
    sql: SqlStorage;
  };
}

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlResult;
}

interface SqlResult {
  toArray(): Record<string, unknown>[];
  one(): Record<string, unknown>;
}

interface AlignmentState {
  lastAlignedMessageId: number | null;
}

// Hibernation API types (infrastructure added now, used later)
interface WebSocketMessage {
  data: string | ArrayBuffer;
}

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export type { DurableObjectContext, SqlStorage, SqlResult, AlignmentState };

export abstract class AgentWorkerBase {
  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;
  protected pubsub: PubSubDOClient;
  protected server: ServerDOClient;

  /** DO identity — set by bootstrap(), stored in SQLite */
  protected doRef!: DORef;
  /** Session ID from last bootstrap — used for restart detection */
  protected workerdSessionId: string | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.ensureSchema();

    // Initialize clients from env bindings — these are required for autonomous DOs
    const e = env as Record<string, string>;
    const pubsubUrl = e["PUBSUB_URL"];
    const serverUrl = e["SERVER_URL"];
    const authToken = e["RPC_AUTH_TOKEN"];

    if (!pubsubUrl || !serverUrl || !authToken) {
      throw new Error(
        `AgentWorkerBase requires PUBSUB_URL, SERVER_URL, and RPC_AUTH_TOKEN env bindings. ` +
        `Missing: ${[!pubsubUrl && "PUBSUB_URL", !serverUrl && "SERVER_URL", !authToken && "RPC_AUTH_TOKEN"].filter(Boolean).join(", ")}`,
      );
    }

    this.pubsub = new PubSubDOClient(pubsubUrl, authToken);
    this.server = new ServerDOClient(serverUrl, authToken);

    // Restore identity from SQLite if previously bootstrapped
    this.restoreIdentity();
  }

  static schemaVersion = 3;

  protected ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    let currentVersion = 0;
    try {
      const row = this.sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).toArray();
      if (row.length > 0) currentVersion = parseInt(row[0]!["value"] as string, 10);
    } catch { /* table might not have the row yet */ }

    const targetVersion = (this.constructor as typeof AgentWorkerBase).schemaVersion;
    if (currentVersion < targetVersion) {
      this.createTables();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES ('schema_version', ?)`,
        String(targetVersion)
      );
    }
  }

  private createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        channel_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        subscribed_at INTEGER NOT NULL,
        config TEXT,
        participant_id TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS harnesses (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_id TEXT,
        fork_point_message_id INTEGER,
        external_session_id TEXT,
        state TEXT,
        last_aligned_message_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS turn_map (
        harness_id TEXT NOT NULL,
        turn_message_id TEXT NOT NULL,
        trigger_pubsub_id INTEGER NOT NULL,
        external_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (harness_id, turn_message_id)
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_turn_map_pubsub ON turn_map(harness_id, trigger_pubsub_id)`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        channel_id TEXT NOT NULL,
        harness_id TEXT,
        last_pubsub_id INTEGER NOT NULL,
        last_filtered_id INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, harness_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS in_flight_turns (
        channel_id TEXT NOT NULL,
        harness_id TEXT NOT NULL,
        trigger_message_id TEXT NOT NULL,
        trigger_pubsub_id INTEGER NOT NULL,
        turn_input TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, harness_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS active_turns (
        harness_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        reply_to_id TEXT NOT NULL,
        turn_message_id TEXT,
        sender_participant_id TEXT,
        stream_state TEXT,
        typing_content TEXT,
        started_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        call_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        call_type TEXT NOT NULL,
        context TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    // DO identity table (bootstrapped by workerdManager)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_identity (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  // --- Identity bootstrap (called by workerdManager after instance creation) ---

  async bootstrap(doRef: DORef, sessionId: string): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO do_identity (key, value) VALUES ('doRef', ?)`,
      JSON.stringify(doRef),
    );
    this.doRef = doRef;

    // Detect restart: sessionId is generated once per workerdManager lifetime.
    // Same sessionId = same process = idempotent no-op.
    // Different sessionId = new process = old harnesses are dead.
    const previousSessionId = this.workerdSessionId;
    this.sql.exec(
      `INSERT OR REPLACE INTO do_identity (key, value) VALUES ('workerdSessionId', ?)`,
      sessionId,
    );
    this.workerdSessionId = sessionId;

    if (previousSessionId && previousSessionId !== sessionId) {
      this.sql.exec(`UPDATE harnesses SET status = 'crashed' WHERE status IN ('active', 'starting')`);
      this.sql.exec(`DELETE FROM active_turns`);
      this.sql.exec(`DELETE FROM in_flight_turns`);
      this.sql.exec(`DELETE FROM pending_calls`);
    }
  }

  private restoreIdentity(): void {
    try {
      const rows = this.sql.exec(`SELECT key, value FROM do_identity`).toArray();
      for (const row of rows) {
        const key = row["key"] as string;
        const value = row["value"] as string;
        if (key === "doRef") {
          try { this.doRef = JSON.parse(value); }
          catch (e) { console.error(`[AgentWorkerBase] Corrupt doRef in do_identity: ${value}`, e); }
        }
        if (key === "workerdSessionId") this.workerdSessionId = value;
      }
    } catch { /* identity table may not exist yet — first run before bootstrap */ }
  }

  // --- 5 Customization Hooks ---

  /** Which harness type to spawn. Override for different AI providers. */
  protected getHarnessType(): string { return 'claude-sdk'; }

  /** Configuration for the harness. Override to customize AI behavior. */
  protected getHarnessConfig(): HarnessConfig { return {}; }

  /** Filter: should this channel event trigger a turn?
   *  Protocol messages (typing indicators, method results, etc.) have a
   *  contentType. Only plain user chat messages trigger AI turns. */
  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.senderType !== 'panel' || event.type !== 'message') return false;
    if (event.contentType) return false;
    return true;
  }

  /** Build TurnInput from a channel event. */
  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? '', senderId: event.senderId, attachments: event.attachments };
  }

  /** Declare PubSub identity for a channel. */
  protected getParticipantInfo(_channelId: string, _config?: unknown): ParticipantDescriptor {
    return {
      handle: 'agent',
      name: 'AI Agent',
      type: 'agent',
      metadata: {},
      methods: [],
    };
  }

  // --- StreamWriter factory ---
  protected createWriter(
    channelId: string,
    turn: { replyToId: string; typingContent: string; streamState: PersistedStreamState },
  ): StreamWriter {
    const participantId = this.getParticipantId(channelId);
    if (!participantId) throw new Error(`No participant ID for channel ${channelId}`);
    return new StreamWriter(
      this.pubsub,
      participantId,
      channelId,
      turn.replyToId,
      turn.typingContent,
      turn.streamState,
    );
  }

  // --- Subscription lifecycle ---

  async subscribeChannel(opts: { channelId: string; contextId: string; config?: unknown }): Promise<{ ok: boolean; participantId: string }> {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config) VALUES (?, ?, ?, ?)`,
      opts.channelId, opts.contextId, Date.now(), opts.config ? JSON.stringify(opts.config) : null
    );

    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    // Participant ID IS the route path — must match the URL scheme workerd serves.
    // className and objectKey are percent-encoded (consistent with doRefUrl and bootstrapDO).
    // source is always 2 clean path segments (e.g. "workers/agent-worker") — no encoding needed.
    const participantId = `/_w/${this.doRef.source}/${encodeURIComponent(this.doRef.className)}/${encodeURIComponent(this.doRef.objectKey)}`;

    // Build metadata from descriptor — transport: "post" tells PubSub to deliver via HTTP POST
    const metadata: Record<string, unknown> = {
      name: descriptor.name,
      type: descriptor.type,
      handle: descriptor.handle,
      transport: "post",
      ...descriptor.metadata,
    };
    if (descriptor.methods && descriptor.methods.length > 0) {
      metadata["methods"] = descriptor.methods;
    }

    // Subscribe to PubSub — no callbackUrl needed, PubSub resolves from participant ID + port
    const subResult = await this.pubsub.subscribe(opts.channelId, participantId, metadata);

    // Cache approval level from channel config if present
    if (subResult?.channelConfig?.["approvalLevel"] != null) {
      this.setApprovalLevel(opts.channelId, subResult.channelConfig["approvalLevel"] as number);
    }

    // Store participant ID
    this.sql.exec(
      `UPDATE subscriptions SET participant_id = ? WHERE channel_id = ?`,
      participantId, opts.channelId,
    );

    return { ok: true, participantId };
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    const harnesses = this.sql.exec(
      `SELECT id FROM harnesses WHERE channel_id = ?`, channelId
    ).toArray() as Array<{ id: string }>;
    const harnessIds = harnesses.map(h => h.id);

    // Unsubscribe from PubSub
    const participantId = this.getParticipantId(channelId);
    if (participantId) {
      await this.pubsub.unsubscribe(channelId, participantId);
    }

    // Stop harnesses via server API
    for (const hid of harnessIds) {
      try {
        await this.server.stopHarness(hid);
      } catch { /* harness may already be stopped */ }
      this.sql.exec(`DELETE FROM active_turns WHERE harness_id = ?`, hid);
      this.sql.exec(`DELETE FROM in_flight_turns WHERE harness_id = ?`, hid);
      this.sql.exec(`DELETE FROM turn_map WHERE harness_id = ?`, hid);
      this.sql.exec(`DELETE FROM checkpoints WHERE harness_id = ?`, hid);
    }
    this.sql.exec(`DELETE FROM harnesses WHERE channel_id = ?`, channelId);
    this.sql.exec(`DELETE FROM checkpoints WHERE channel_id = ? AND harness_id IS NULL`, channelId);
    this.sql.exec(`DELETE FROM pending_calls WHERE channel_id = ?`, channelId);
    this.sql.exec(`DELETE FROM subscriptions WHERE channel_id = ?`, channelId);

    return { harnessIds };
  }

  // --- Context + Config helpers ---
  protected getContextId(channelId: string): string {
    const row = this.sql.exec(`SELECT context_id FROM subscriptions WHERE channel_id = ?`, channelId).toArray();
    if (row.length === 0) throw new Error(`No subscription for channel ${channelId}`);
    return row[0]!["context_id"] as string;
  }

  protected getSubscriptionConfig(channelId: string): Record<string, unknown> | null {
    const row = this.sql.exec(`SELECT config FROM subscriptions WHERE channel_id = ?`, channelId).toArray();
    if (row.length === 0 || !row[0]!["config"]) return null;
    return JSON.parse(row[0]!["config"] as string);
  }

  // --- Harness helpers ---
  protected getHarnessForChannel(channelId: string): string | null {
    const row = this.sql.exec(
      `SELECT id FROM harnesses WHERE channel_id = ? AND status = 'active'`, channelId
    ).toArray();
    return row.length > 0 ? (row[0]!["id"] as string) : null;
  }

  protected getChannelForHarness(harnessId: string): string | null {
    const row = this.sql.exec(
      `SELECT channel_id FROM harnesses WHERE id = ?`, harnessId
    ).toArray();
    return row.length > 0 ? (row[0]!["channel_id"] as string) : null;
  }

  // --- Harness registration (called by server during bootstrap) ---
  registerHarness(harnessId: string, channelId: string, type: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO harnesses (id, type, channel_id, status, created_at) VALUES (?, ?, ?, 'starting', ?)`,
      harnessId, type, channelId, Date.now()
    );
  }

  reactivateHarness(harnessId: string): void {
    this.sql.exec(`UPDATE harnesses SET status = 'starting' WHERE id = ?`, harnessId);
  }

  recordTurnStart(harnessId: string, channelId: string, input: TurnInput, triggerMessageId: string, triggerPubsubId: number, senderParticipantId?: string): void {
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: input.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });
    this.setActiveTurn(harnessId, channelId, triggerMessageId, undefined, senderParticipantId, typingContent);

    // Adopt any bootstrap typing message (sent during spawn) into the stream state.
    const bootstrapKey = `bootstrap_typing:${channelId}`;
    const bootstrapRow = this.sql.exec(`SELECT value FROM state WHERE key = ?`, bootstrapKey).toArray();
    if (bootstrapRow.length > 0) {
      const typingMsgId = bootstrapRow[0]!["value"] as string;
      this.sql.exec(`DELETE FROM state WHERE key = ?`, bootstrapKey);
      const turn = this.getActiveTurn(harnessId);
      if (turn) {
        const state = { ...turn.streamState, typingMessageId: typingMsgId };
        this.sql.exec(
          `UPDATE active_turns SET stream_state = ? WHERE harness_id = ?`,
          JSON.stringify(state), harnessId,
        );
      }
    }

    this.setInFlightTurn(channelId, harnessId, triggerMessageId, triggerPubsubId, input);
    this.advanceCheckpoint(channelId, harnessId, triggerPubsubId);
  }

  // --- Turn state helpers ---
  protected setActiveTurn(harnessId: string, channelId: string, replyToId: string, turnMessageId?: string, senderParticipantId?: string, typingContent?: string): void {
    const initialStreamState: PersistedStreamState = {
      responseMessageId: null,
      thinkingMessageId: null,
      actionMessageId: null,
      typingMessageId: null,
    };
    this.sql.exec(
      `INSERT OR REPLACE INTO active_turns (harness_id, channel_id, reply_to_id, turn_message_id, sender_participant_id, stream_state, typing_content, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      harnessId, channelId, replyToId, turnMessageId ?? null, senderParticipantId ?? null, JSON.stringify(initialStreamState), typingContent ?? '', Date.now()
    );
  }

  protected getActiveTurn(harnessId: string): {
    channelId: string;
    replyToId: string;
    turnMessageId: string | null;
    senderParticipantId: string | null;
    typingContent: string;
    streamState: PersistedStreamState;
  } | null {
    const row = this.sql.exec(
      `SELECT channel_id, reply_to_id, turn_message_id, sender_participant_id, stream_state, typing_content FROM active_turns WHERE harness_id = ?`, harnessId
    ).toArray();
    if (row.length === 0) return null;
    const defaultState: PersistedStreamState = { responseMessageId: null, thinkingMessageId: null, actionMessageId: null, typingMessageId: null };
    const turnMsgId = (row[0]!["turn_message_id"] as string | null);
    const streamState: PersistedStreamState = row[0]!["stream_state"]
      ? JSON.parse(row[0]!["stream_state"] as string)
      : { ...defaultState, responseMessageId: turnMsgId };
    return {
      channelId: row[0]!["channel_id"] as string,
      replyToId: row[0]!["reply_to_id"] as string,
      turnMessageId: (row[0]!["turn_message_id"] as string | null),
      senderParticipantId: (row[0]!["sender_participant_id"] as string | null),
      typingContent: (row[0]!["typing_content"] as string) ?? '',
      streamState,
    };
  }

  protected updateActiveTurnMessageId(harnessId: string, turnMessageId: string): void {
    this.sql.exec(`UPDATE active_turns SET turn_message_id = ? WHERE harness_id = ?`, turnMessageId, harnessId);
  }

  protected clearActiveTurn(harnessId: string): void {
    this.sql.exec(`DELETE FROM active_turns WHERE harness_id = ?`, harnessId);
  }

  // --- In-flight turn tracking ---
  protected setInFlightTurn(channelId: string, harnessId: string, messageId: string, pubsubId: number, input: TurnInput): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO in_flight_turns (channel_id, harness_id, trigger_message_id, trigger_pubsub_id, turn_input, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
      channelId, harnessId, messageId, pubsubId, JSON.stringify(input), Date.now()
    );
  }

  protected getInFlightTurn(channelId: string, harnessId: string): { triggerMessageId: string; triggerPubsubId: number; turnInput: TurnInput } | null {
    const row = this.sql.exec(
      `SELECT trigger_message_id, trigger_pubsub_id, turn_input FROM in_flight_turns WHERE channel_id = ? AND harness_id = ?`,
      channelId, harnessId
    ).toArray();
    if (row.length === 0) return null;
    return {
      triggerMessageId: row[0]!["trigger_message_id"] as string,
      triggerPubsubId: row[0]!["trigger_pubsub_id"] as number,
      turnInput: JSON.parse(row[0]!["turn_input"] as string),
    };
  }

  protected clearInFlightTurn(channelId: string, harnessId: string): void {
    this.sql.exec(`DELETE FROM in_flight_turns WHERE channel_id = ? AND harness_id = ?`, channelId, harnessId);
  }

  // --- Checkpoint tracking ---
  protected advanceCheckpoint(channelId: string, harnessId: string | null, pubsubId: number): void {
    const hid = harnessId ?? '';
    this.sql.exec(
      `INSERT OR REPLACE INTO checkpoints (channel_id, harness_id, last_pubsub_id, updated_at) VALUES (?, NULLIF(?, ''), ?, ?)`,
      channelId, hid, pubsubId, Date.now()
    );
  }

  protected getCheckpoint(channelId: string, harnessId: string | null): number | null {
    const row = this.sql.exec(
      harnessId
        ? `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = ? AND harness_id = ?`
        : `SELECT last_pubsub_id FROM checkpoints WHERE channel_id = ? AND harness_id IS NULL`,
      ...(harnessId ? [channelId, harnessId] : [channelId])
    ).toArray();
    if (row.length === 0) return null;
    return row[0]!["last_pubsub_id"] as number;
  }

  // --- Turn recording ---
  protected recordTurn(harnessId: string, messageId: string, triggerPubsubId: number, sessionId: string): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO turn_map (harness_id, turn_message_id, trigger_pubsub_id, external_session_id, created_at) VALUES (?, ?, ?, ?, ?)`,
      harnessId, messageId, triggerPubsubId, sessionId, Date.now()
    );
    this.sql.exec(`UPDATE harnesses SET external_session_id = ? WHERE id = ?`, sessionId, harnessId);
  }

  // --- Fork resolution ---
  protected getTurnAtOrBefore(harnessId: string, pubsubId: number): { turnMessageId: string; externalSessionId: string } | null {
    const row = this.sql.exec(
      `SELECT turn_message_id, external_session_id FROM turn_map WHERE harness_id = ? AND trigger_pubsub_id <= ? ORDER BY trigger_pubsub_id DESC LIMIT 1`,
      harnessId, pubsubId
    ).toArray();
    if (row.length === 0) return null;
    return {
      turnMessageId: row[0]!["turn_message_id"] as string,
      externalSessionId: row[0]!["external_session_id"] as string,
    };
  }

  protected getLatestTurn(harnessId: string): { turnMessageId: string; externalSessionId: string } | null {
    const row = this.sql.exec(
      `SELECT turn_message_id, external_session_id FROM turn_map WHERE harness_id = ? ORDER BY trigger_pubsub_id DESC LIMIT 1`,
      harnessId
    ).toArray();
    if (row.length === 0) return null;
    return {
      turnMessageId: row[0]!["turn_message_id"] as string,
      externalSessionId: row[0]!["external_session_id"] as string,
    };
  }

  protected getResumeSessionId(harnessId: string): string | undefined {
    return this.getLatestTurn(harnessId)?.externalSessionId;
  }

  /** Find the most recent session ID across all harnesses on a channel (for restart recovery). */
  protected getResumeSessionIdForChannel(channelId: string): string | undefined {
    const row = this.sql.exec(
      `SELECT t.external_session_id FROM turn_map t
       JOIN harnesses h ON t.harness_id = h.id
       WHERE h.channel_id = ?
       ORDER BY t.created_at DESC LIMIT 1`,
      channelId,
    ).toArray();
    return row.length > 0 ? (row[0]!["external_session_id"] as string) : undefined;
  }

  // --- Alignment ---
  protected getAlignment(harnessId: string): AlignmentState {
    const row = this.sql.exec(
      `SELECT last_aligned_message_id FROM harnesses WHERE id = ?`, harnessId
    ).toArray();
    return { lastAlignedMessageId: row.length > 0 ? (row[0]!["last_aligned_message_id"] as number | null) : null };
  }

  // --- Participant ID ---

  protected getParticipantId(channelId: string): string | null {
    const row = this.sql.exec(
      `SELECT participant_id FROM subscriptions WHERE channel_id = ?`, channelId
    ).toArray();
    return row.length > 0 ? (row[0]!["participant_id"] as string | null) : null;
  }

  // --- Approval level caching ---

  protected setApprovalLevel(channelId: string, level: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
      `approvalLevel:${channelId}`, String(level),
    );
  }

  protected getApprovalLevel(channelId: string): number {
    const row = this.sql.exec(
      `SELECT value FROM state WHERE key = ?`, `approvalLevel:${channelId}`
    ).toArray();
    if (row.length === 0) return 2; // Default: Full Auto
    return parseInt(row[0]!["value"] as string, 10);
  }

  protected shouldAutoApprove(channelId: string, toolName: string): boolean {
    return !needsApprovalForTool(toolName, this.getApprovalLevel(channelId));
  }

  /**
   * Re-evaluate all pending approval calls for a channel.
   * Called when approval level changes — the DO is the single authority,
   * so it actively resolves any in-flight approvals that the new level permits.
   */
  protected async reevaluatePendingApprovals(channelId: string): Promise<void> {
    const rows = this.sql.exec(
      `SELECT call_id, context FROM pending_calls WHERE channel_id = ? AND call_type = 'approval'`,
      channelId,
    ).toArray();

    for (const row of rows) {
      const callId = row["call_id"] as string;
      const context = JSON.parse(row["context"] as string) as { harnessId: string; toolUseId: string };

      // Check if the new level auto-approves (for Full Auto this is always true)
      const activeHarnessId = this.getHarnessForChannel(channelId);
      if (activeHarnessId === context.harnessId) {
        // Consume the pending call and approve the tool
        this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
        await this.server.sendHarnessCommand(context.harnessId, {
          type: "approve-tool",
          toolUseId: context.toolUseId,
          allow: true,
        });
        // Cancel the in-flight PubSub callMethod — the panel may have already
        // shown a prompt; cancelling dismisses it. If the result already came
        // back, onCallResult finds no pending call and harmlessly drops it.
        try {
          await this.pubsub.cancelCall(channelId, callId);
        } catch { /* best-effort — call may already be completed */ }
      }
    }
  }

  // --- Pending call continuations (survives hibernation) ---

  protected pendingCall(
    callId: string, channelId: string,
    type: string, context: Record<string, unknown>,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (call_id, channel_id, call_type, context, created_at) VALUES (?, ?, ?, ?, ?)`,
      callId, channelId, type, JSON.stringify(context), Date.now(),
    );
  }

  protected consumePendingCall(callId: string): {
    channelId: string; type: string; context: Record<string, unknown>;
  } | null {
    const row = this.sql.exec(
      `SELECT channel_id, call_type, context FROM pending_calls WHERE call_id = ?`, callId
    ).toArray();
    if (row.length === 0) return null;
    this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
    return {
      channelId: row[0]!["channel_id"] as string,
      type: row[0]!["call_type"] as string,
      context: JSON.parse(row[0]!["context"] as string),
    };
  }

  /** Entry point called when an async method-call result arrives from PubSub. */
  async onCallResult(
    callId: string, result: unknown, isError: boolean,
  ): Promise<void> {
    const pending = this.consumePendingCall(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError})`);
      return;
    }
    await this.handleCallResult(pending.type, pending.context, pending.channelId, result, isError);
  }

  /** Override in subclasses to handle different continuation types. */
  protected async handleCallResult(
    _type: string, _context: Record<string, unknown>,
    _channelId: string, _result: unknown, _isError: boolean,
  ): Promise<void> {
    // Default: no-op
  }

  // --- StreamWriter persistence ---
  persistStreamState(harnessId: string, writer: StreamWriter): void {
    const state = writer.getState();
    this.sql.exec(
      `UPDATE active_turns SET stream_state = ?, turn_message_id = COALESCE(?, turn_message_id) WHERE harness_id = ?`,
      JSON.stringify(state),
      state.responseMessageId,
      harnessId,
    );
  }

  // --- Abstract methods (subclasses implement these) ---
  // Return void — DOs handle all side effects via direct outbound calls
  abstract onChannelEvent(channelId: string, event: ChannelEvent): Promise<void>;
  abstract onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void>;

  /**
   * Called when a method call arrives from another participant via PubSub.
   * Returns the result directly (not WorkerActions).
   */
  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: 'not implemented' }, isError: true };
  }

  // --- Optional event hooks (subclasses may override) ---

  /** Called when a channel fork completes. */
  async onChannelForked(_sourceChannel: string, _forkedChannelId: string, _forkPointId: number): Promise<void> {}

  async getState(): Promise<Record<string, unknown>> {
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const harnesses = this.sql.exec(`SELECT * FROM harnesses`).toArray();
    const activeTurns = this.sql.exec(`SELECT * FROM active_turns`).toArray();
    const checkpoints = this.sql.exec(`SELECT * FROM checkpoints`).toArray();
    const inFlightTurns = this.sql.exec(`SELECT * FROM in_flight_turns`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    return { subscriptions, harnesses, activeTurns, checkpoints, inFlightTurns, pendingCalls };
  }

  // --- Hibernation API stubs (infrastructure for future WebSocket support) ---

  webSocketMessage(_ws: unknown, _message: WebSocketMessage): void {}
  webSocketClose(_ws: unknown, _code: number, _reason: string, _wasClean: boolean): void {}
  webSocketError(_ws: unknown, _error: unknown): void {}

  /**
   * HTTP fetch handler — routes /{method} POST requests to DO methods.
   * Called by workerd when the router worker proxies to this DO.
   *
   * Uses the /_w/ URL scheme (source-scoped).
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.replace(/^\/+/, "") || "getState";

    // WebSocket upgrade handling (Hibernation API infrastructure)
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return new Response("WebSocket support not yet implemented", { status: 501 });
    }

    try {
      // Parse args from request body (POST with JSON array or object)
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const parsed = JSON.parse(body);
          args = Array.isArray(parsed) ? parsed : [parsed];
        }
      }


      // For onChannelEvent, transform the raw PubSub broadcast event into a ChannelEvent.
      // PubSub POST-back sends [channelId, ChannelBroadcastEvent] where the broadcast event
      // has senderMetadata (JSON string) instead of senderType, and payload may be a JSON string.
      if (method === "onChannelEvent" && args.length === 2) {
        const rawEvent = args[1] as ChannelBroadcastEventRaw;

        // Intercept config-update events: cache approval level, re-evaluate
        // pending approvals, don't forward to subclass
        if (rawEvent.type === "config-update") {
          const channelId = args[0] as string;
          try {
            const config = typeof rawEvent.payload === "string" ? JSON.parse(rawEvent.payload) : rawEvent.payload;
            if (config && typeof config === "object" && "approvalLevel" in (config as Record<string, unknown>)) {
              const newLevel = (config as Record<string, unknown>)["approvalLevel"] as number;
              this.setApprovalLevel(channelId, newLevel);
              // The DO is the single authority on approval. When the level
              // changes, re-evaluate all in-flight approval calls so none
              // are left dangling if the new level permits auto-approval.
              if (newLevel >= 2) {
                await this.reevaluatePendingApprovals(channelId);
              }
            }
          } catch { /* ignore parse errors */ }
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }

        args[1] = toChannelEvent(rawEvent);
      }

      // Route to the appropriate method
      const fn = (this as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        return new Response(JSON.stringify({ error: `Unknown method: ${method}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
      return new Response(JSON.stringify(result ?? null), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}
