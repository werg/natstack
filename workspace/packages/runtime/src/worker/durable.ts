import type { ChannelEvent, HarnessConfig, HarnessOutput, TurnInput, WorkerActions, ParticipantDescriptor, UnsubscribeResult, Attachment } from "@natstack/harness";
import { ActionCollector } from "./action-collector.js";
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

export type { DurableObjectContext, SqlStorage, SqlResult, AlignmentState };

export abstract class AgentWorkerBase {
  protected ctx: DurableObjectContext;
  protected sql: SqlStorage;

  constructor(ctx: DurableObjectContext, _env: unknown) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  static schemaVersion = 2;

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

  // --- ActionCollector factory ---
  protected actions(): ActionCollector {
    return new ActionCollector(this);
  }

  // --- Subscription lifecycle ---
  async subscribeChannel(opts: { channelId: string; contextId: string; config?: unknown }): Promise<ParticipantDescriptor> {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config) VALUES (?, ?, ?, ?)`,
      opts.channelId, opts.contextId, Date.now(), opts.config ? JSON.stringify(opts.config) : null
    );
    return this.getParticipantInfo(opts.channelId, opts.config);
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    const harnesses = this.sql.exec(
      `SELECT id FROM harnesses WHERE channel_id = ?`, channelId
    ).toArray() as Array<{ id: string }>;
    const harnessIds = harnesses.map(h => h.id);

    for (const hid of harnessIds) {
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
    // This lets the StreamWriter complete it by ID when the first content event arrives.
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
    // Fall back to turn_message_id as responseMessageId when stream_state is absent
    // (handles rows created before stream_state was introduced, or manual SQL inserts in tests)
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

  // --- Alignment ---
  protected getAlignment(harnessId: string): AlignmentState {
    const row = this.sql.exec(
      `SELECT last_aligned_message_id FROM harnesses WHERE id = ?`, harnessId
    ).toArray();
    return { lastAlignedMessageId: row.length > 0 ? (row[0]!["last_aligned_message_id"] as number | null) : null };
  }

  // --- Participant ID (stored after server-side subscription) ---

  async setParticipantId(channelId: string, participantId: string): Promise<WorkerActions> {
    this.sql.exec(
      `UPDATE subscriptions SET participant_id = ? WHERE channel_id = ?`,
      participantId, channelId,
    );
    return { actions: [] };
  }

  protected getParticipantId(channelId: string): string | null {
    const row = this.sql.exec(
      `SELECT participant_id FROM subscriptions WHERE channel_id = ?`, channelId
    ).toArray();
    return row.length > 0 ? (row[0]!["participant_id"] as string | null) : null;
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

  /** Entry point called by server when a method-call result arrives. */
  async onCallResult(
    callId: string, result: unknown, isError: boolean,
  ): Promise<WorkerActions> {
    const pending = this.consumePendingCall(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError}) — may have been consumed already or callId mismatch`);
      return { actions: [] };
    }
    console.log(`[AgentWorkerBase] onCallResult: processing ${pending.type} result for callId=${callId} (isError=${isError})`);
    return this.handleCallResult(pending.type, pending.context, pending.channelId, result, isError);
  }

  /** Override in subclasses to handle different continuation types. */
  protected handleCallResult(
    _type: string, _context: Record<string, unknown>,
    _channelId: string, _result: unknown, _isError: boolean,
  ): WorkerActions | Promise<WorkerActions> {
    return { actions: [] };
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
  abstract onChannelEvent(channelId: string, event: ChannelEvent): Promise<WorkerActions>;
  abstract onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<WorkerActions>;

  /**
   * Middleware hook for harness-originated outbound method calls.
   *
   * The default behavior is a direct pass-through to the target participant.
   * Subclasses can override to short-circuit, rewrite, or persist their own
   * continuations before issuing the external call.
   */
  async onOutgoingMethodCall(
    channelId: string,
    callId: string,
    participantId: string,
    methodName: string,
    args: unknown,
  ): Promise<WorkerActions> {
    const $ = this.actions();
    $.channel(channelId).callMethod(callId, participantId, methodName, args);
    return $.result();
  }

  async onMethodCall(_channelId: string, callId: string, _methodName: string, _args: unknown): Promise<WorkerActions> {
    const $ = this.actions();
    $.channel(_channelId).methodResult(callId, { error: 'not implemented' }, true);
    return $.result();
  }

  // --- Optional event hooks (subclasses may override) ---

  /** Called when a channel fork completes. Override to subscribe to the new channel. */
  async onChannelForked(_sourceChannel: string, _forkedChannelId: string, _forkPointId: number): Promise<WorkerActions> {
    return { actions: [] };
  }

  /** Called when a set-alarm timer fires. Override for deferred work (e.g., GC). */
  async onAlarm(): Promise<WorkerActions> {
    return { actions: [] };
  }

  async getState(): Promise<Record<string, unknown>> {
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const harnesses = this.sql.exec(`SELECT * FROM harnesses`).toArray();
    const activeTurns = this.sql.exec(`SELECT * FROM active_turns`).toArray();
    const checkpoints = this.sql.exec(`SELECT * FROM checkpoints`).toArray();
    const inFlightTurns = this.sql.exec(`SELECT * FROM in_flight_turns`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    return { subscriptions, harnesses, activeTurns, checkpoints, inFlightTurns, pendingCalls };
  }

  /**
   * HTTP fetch handler — routes /{method} POST requests to DO methods.
   * Called by workerd when the router worker proxies to this DO via stub.fetch().
   * The server dispatches DO calls via HTTP POST to /_do/{className}/{objectKey}/{method}.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.replace(/^\/+/, "") || "getState";

    try {
      // Parse args from request body (POST with JSON array) or empty
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const parsed = JSON.parse(body);
          args = Array.isArray(parsed) ? parsed : [parsed];
        }
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
