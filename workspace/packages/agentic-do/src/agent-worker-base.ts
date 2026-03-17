/**
 * AgentWorkerBase — Thin composition shell for agentic Durable Objects.
 *
 * Extends DurableObjectBase and composes agent-specific modules:
 * DOIdentity, SubscriptionManager, HarnessManager, TurnManager,
 * ContinuationStore, and StreamWriter.
 *
 * Non-agent DOs extend DurableObjectBase directly.
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import { ServerDOClient } from "@workspace/runtime/worker";
import type { ChannelEvent, HarnessConfig, HarnessOutput, TurnInput, ParticipantDescriptor, UnsubscribeResult, Attachment } from "@natstack/harness/types";
import { needsApprovalForTool } from "@natstack/pubsub";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { HarnessManager } from "./harness-manager.js";
import { TurnManager, type ActiveTurn, type InFlightTurn } from "./turn-manager.js";
import { ContinuationStore } from "./continuation-store.js";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";
import { ChannelClient } from "./channel-client.js";

export abstract class AgentWorkerBase extends DurableObjectBase {
  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected harnesses: HarnessManager;
  protected turns: TurnManager;
  protected continuations: ContinuationStore;
  protected server: ServerDOClient;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    const e = env as Record<string, string>;
    const serverUrl = e["SERVER_URL"];
    const authToken = e["RPC_AUTH_TOKEN"];

    if (!serverUrl || !authToken) {
      throw new Error(
        `AgentWorkerBase requires SERVER_URL and RPC_AUTH_TOKEN env bindings. ` +
        `Missing: ${[!serverUrl && "SERVER_URL", !authToken && "RPC_AUTH_TOKEN"].filter(Boolean).join(", ")}`,
      );
    }

    this.server = new ServerDOClient(serverUrl, authToken);

    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => new ChannelClient(this.postToDO.bind(this), channelId),
      this.identity,
    );
    this.harnesses = new HarnessManager(this.sql, this.server);
    this.turns = new TurnManager(this.sql);
    this.continuations = new ContinuationStore(this.sql);

    // Eager schema init — safe because all modules exist.
    this.ensureReady();

    // Restore identity from SQLite if previously bootstrapped
    this.identity.restore();
  }

  static override schemaVersion = 3;

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    this.harnesses.createTables();
    this.turns.createTables();
    this.continuations.createTables();
  }

  // --- Identity bootstrap ---
  // Self-bootstraps from env bindings (WORKER_SOURCE, WORKER_CLASS_NAME, WORKERD_SESSION_ID)
  // and objectKey (parsed from request URL by DurableObjectBase.fetch()).
  // Also callable externally for backward compatibility.

  private _bootstrapped = false;

  /** Ensure identity is bootstrapped. Called automatically on first fetch(). */
  private ensureBootstrapped(): void {
    if (this._bootstrapped) return;
    // objectKey may not be available yet (before first fetch)
    try {
      const key = this.objectKey;
      const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
      const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
      const sessionId = (this.env as Record<string, string>)["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        const { isRestart } = this.identity.bootstrap(doRef, sessionId);
        if (isRestart) {
          this.harnesses.markCrashedOnRestart();
          this.turns.clearAllActive();
          this.turns.clearAllInFlight();
          this.continuations.deleteAll();
        }
        this._bootstrapped = true;
      }
    } catch (err) {
      // objectKey not yet available (before first fetch) — will bootstrap on next call.
      // Log unexpected errors so they don't get silently swallowed.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("objectKey not available")) {
        console.error("[AgentWorkerBase] ensureBootstrapped failed:", err);
      }
    }
  }

  async bootstrap(doRef: DORef, sessionId: string): Promise<void> {
    const { isRestart } = this.identity.bootstrap(doRef, sessionId);
    if (isRestart) {
      this.harnesses.markCrashedOnRestart();
      this.turns.clearAllActive();
      this.turns.clearAllInFlight();
      this.continuations.deleteAll();
    }
    this._bootstrapped = true;
  }

  // --- Convenience accessors (delegate to identity) ---

  protected get doRef(): DORef {
    return this.identity.ref;
  }

  // --- ChannelClient factory ---

  protected createChannelClient(channelId: string): ChannelClient {
    return new ChannelClient(this.postToDO.bind(this), channelId);
  }

  // --- 5 Customization Hooks ---

  protected getHarnessType(): string { return 'claude-sdk'; }
  protected getHarnessConfig(): HarnessConfig { return {}; }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.senderType !== 'panel' || event.type !== 'message') return false;
    if (event.contentType) return false;
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? '', senderId: event.senderId, attachments: event.attachments };
  }

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
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`No participant ID for channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    return new StreamWriter(channel, participantId, channelId, turn.replyToId, turn.typingContent, turn.streamState);
  }

  // --- Subscription lifecycle ---

  async subscribeChannel(opts: { channelId: string; contextId: string; config?: unknown }): Promise<{ ok: boolean; participantId: string }> {
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
    });

    if (result.channelConfig?.["approvalLevel"] != null) {
      this.setApprovalLevel(opts.channelId, result.channelConfig["approvalLevel"] as number);
    }

    return { ok: result.ok, participantId: result.participantId };
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    const harnessIds = this.harnesses.listForChannel(channelId);

    // Unsubscribe from channel DO
    await this.subscriptions.unsubscribeFromChannel(channelId);

    // Stop harnesses via server API
    for (const hid of harnessIds) {
      await this.harnesses.stop(hid);
      this.turns.deleteForHarness(hid);
    }

    // Clean up all tables for this channel
    this.harnesses.deleteForChannel(channelId);
    this.turns.deleteCheckpointsForChannel(channelId);
    this.continuations.deleteForChannel(channelId);
    this.subscriptions.deleteSubscription(channelId);

    return { harnessIds };
  }

  // --- Delegated helpers (backward-compatible API for subclasses) ---

  protected getHarnessForChannel(channelId: string): string | null {
    return this.harnesses.getForChannel(channelId);
  }

  protected getChannelForHarness(harnessId: string): string | null {
    return this.harnesses.getChannelFor(harnessId);
  }

  protected getContextId(channelId: string): string {
    return this.subscriptions.getContextId(channelId);
  }

  protected getSubscriptionConfig(channelId: string): Record<string, unknown> | null {
    return this.subscriptions.getConfig(channelId);
  }

  protected getParticipantId(channelId: string): string | null {
    return this.subscriptions.getParticipantId(channelId);
  }

  // --- Turn management delegates ---

  protected setActiveTurn(harnessId: string, channelId: string, replyToId: string, turnMessageId?: string, senderParticipantId?: string, typingContent?: string): void {
    this.turns.setActive(harnessId, channelId, replyToId, turnMessageId, senderParticipantId, typingContent);
  }

  protected getActiveTurn(harnessId: string): ActiveTurn | null {
    return this.turns.getActive(harnessId);
  }

  protected updateActiveTurnMessageId(harnessId: string, turnMessageId: string): void {
    this.turns.updateActiveMessageId(harnessId, turnMessageId);
  }

  protected clearActiveTurn(harnessId: string): void {
    this.turns.clearActive(harnessId);
  }

  protected setInFlightTurn(channelId: string, harnessId: string, messageId: string, pubsubId: number, input: TurnInput): void {
    this.turns.setInFlight(channelId, harnessId, messageId, pubsubId, input);
  }

  protected getInFlightTurn(channelId: string, harnessId: string): InFlightTurn | null {
    return this.turns.getInFlight(channelId, harnessId);
  }

  protected clearInFlightTurn(channelId: string, harnessId: string): void {
    this.turns.clearInFlight(channelId, harnessId);
  }

  protected advanceCheckpoint(channelId: string, harnessId: string | null, pubsubId: number): void {
    this.turns.advanceCheckpoint(channelId, harnessId, pubsubId);
  }

  protected getCheckpoint(channelId: string, harnessId: string | null): number | null {
    return this.turns.getCheckpoint(channelId, harnessId);
  }

  protected recordTurn(harnessId: string, messageId: string, triggerPubsubId: number, sessionId: string): void {
    this.turns.recordTurn(harnessId, messageId, triggerPubsubId, sessionId);
    this.harnesses.setSessionId(harnessId, sessionId);
  }

  protected getTurnAtOrBefore(harnessId: string, pubsubId: number) {
    return this.turns.getTurnAtOrBefore(harnessId, pubsubId);
  }

  protected getLatestTurn(harnessId: string) {
    return this.turns.getLatestTurn(harnessId);
  }

  protected getResumeSessionId(harnessId: string): string | undefined {
    return this.turns.getResumeSessionId(harnessId);
  }

  protected getResumeSessionIdForChannel(channelId: string): string | undefined {
    const harnessIds = this.harnesses.listForChannel(channelId);
    return this.turns.getResumeSessionIdForHarnesses(harnessIds);
  }

  protected persistStreamState(harnessId: string, writer: StreamWriter): void {
    this.turns.persistStreamState(harnessId, writer.getState());
  }

  // --- Harness registration (called by server during bootstrap) ---

  registerHarness(harnessId: string, channelId: string, type: string): void {
    this.harnesses.register(harnessId, channelId, type);
  }

  reactivateHarness(harnessId: string): void {
    this.harnesses.reactivate(harnessId);
  }

  recordTurnStart(harnessId: string, channelId: string, input: TurnInput, triggerMessageId: string, triggerPubsubId: number, senderParticipantId?: string): void {
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: input.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });
    this.setActiveTurn(harnessId, channelId, triggerMessageId, undefined, senderParticipantId, typingContent);

    // Adopt any bootstrap typing message
    const bootstrapKey = `bootstrap_typing:${channelId}`;
    const bootstrapRow = this.getStateValue(bootstrapKey);
    if (bootstrapRow) {
      this.deleteStateValue(bootstrapKey);
      const turn = this.getActiveTurn(harnessId);
      if (turn) {
        const state = { ...turn.streamState, typingMessageId: bootstrapRow };
        this.turns.persistStreamState(harnessId, state);
      }
    }

    this.setInFlightTurn(channelId, harnessId, triggerMessageId, triggerPubsubId, input);
    this.advanceCheckpoint(channelId, harnessId, triggerPubsubId);
  }

  // --- Approval level caching ---

  protected setApprovalLevel(channelId: string, level: number): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
  }

  protected getApprovalLevel(channelId: string): number {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    if (!value) return 2; // Default: Full Auto
    return parseInt(value, 10);
  }

  protected shouldAutoApprove(channelId: string, toolName: string): boolean {
    return !needsApprovalForTool(toolName, this.getApprovalLevel(channelId));
  }

  protected async reevaluatePendingApprovals(channelId: string): Promise<void> {
    const pending = this.continuations.listForChannel(channelId, 'approval');

    for (const call of pending) {
      const context = call.context as { harnessId: string; toolUseId: string };
      const activeHarnessId = this.getHarnessForChannel(channelId);
      if (activeHarnessId === context.harnessId) {
        this.continuations.deleteOne(call.callId);
        await this.server.sendHarnessCommand(context.harnessId, {
          type: "approve-tool",
          toolUseId: context.toolUseId,
          allow: true,
        });
        try {
          const channel = this.createChannelClient(channelId);
          await channel.cancelCall(call.callId);
        } catch { /* best-effort */ }
      }
    }
  }

  // --- Pending call continuations ---

  protected pendingCall(callId: string, channelId: string, type: string, context: Record<string, unknown>): void {
    this.continuations.store(callId, channelId, type, context);
  }

  protected consumePendingCall(callId: string) {
    return this.continuations.consume(callId);
  }

  async onCallResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    const pending = this.consumePendingCall(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError})`);
      return;
    }
    await this.handleCallResult(pending.type, pending.context, pending.channelId, result, isError);
  }

  protected async handleCallResult(
    _type: string, _context: Record<string, unknown>,
    _channelId: string, _result: unknown, _isError: boolean,
  ): Promise<void> {
    // Default: no-op
  }

  // --- Abstract methods ---

  abstract onChannelEvent(channelId: string, event: ChannelEvent): Promise<void>;
  abstract onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void>;

  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: 'not implemented' }, isError: true };
  }

  async onChannelForked(_sourceChannel: string, _forkedChannelId: string, _forkPointId: number): Promise<void> {}

  // --- Fetch override for agent-specific event handling ---

  override async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    // Parse /{objectKey}/{method} from URL (same as base class)
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as any)._objectKey) {
      (this as any)._objectKey = decodeURIComponent(segments[0]!);
    }

    // Self-bootstrap from env bindings now that objectKey is available
    this.ensureBootstrapped();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    try {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const parsed = JSON.parse(body);
          args = Array.isArray(parsed) ? parsed : [parsed];
        }
      }

      // Channel DO sends proper ChannelEvent objects — intercept config-update events
      if (method === "onChannelEvent" && args.length === 2) {
        const event = args[1] as ChannelEvent;
        if (event.type === "config-update") {
          const channelId = args[0] as string;
          try {
            const config = typeof event.payload === "object" && event.payload !== null
              ? event.payload as Record<string, unknown>
              : {};
            if ("approvalLevel" in config) {
              const newLevel = config["approvalLevel"] as number;
              this.setApprovalLevel(channelId, newLevel);
              if (newLevel >= 2) {
                await this.reevaluatePendingApprovals(channelId);
              }
            }
          } catch { /* ignore parse errors */ }
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

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

  override async getState(): Promise<Record<string, unknown>> {
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const harnesses = this.sql.exec(`SELECT * FROM harnesses`).toArray();
    const activeTurns = this.sql.exec(`SELECT * FROM active_turns`).toArray();
    const checkpoints = this.sql.exec(`SELECT * FROM checkpoints`).toArray();
    const inFlightTurns = this.sql.exec(`SELECT * FROM in_flight_turns`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    return { subscriptions, harnesses, activeTurns, checkpoints, inFlightTurns, pendingCalls };
  }
}
