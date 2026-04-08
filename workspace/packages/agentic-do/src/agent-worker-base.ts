/**
 * AgentWorkerBase — Pi-native agent DO base.
 *
 * Embeds `@mariozechner/pi-coding-agent` in-process. One Pi `AgentSession`
 * per channel, owned by the DO for the lifetime of the chat. Pi tracks its
 * own state (messages, sessions, branching, compaction, retries); the DO
 * forwards Pi state to the channel as ephemeral events.
 *
 * Composes:
 * - `DOIdentity`: stable DO ref + workerd session id
 * - `SubscriptionManager`: channel membership + replay state
 * - `ContinuationStore`: pending callId continuations for tool callMethod
 *   and feedback_form / inline UI awaits (Promise resolution from onCallResult)
 * - `ChannelClient`: typed wrapper around channel DO RPC
 *
 * Forwards Pi events as two ephemeral channel streams:
 * - `natstack-state-snapshot` (full session.state.messages snapshot after
 *   every meaningful state change)
 * - `natstack-text-delta` (cosmetic typing-indicator stream)
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType } from "@natstack/pubsub";
import {
  PiRunner,
  type ChannelToolMethod,
  type NatStackUIBridgeCallbacks,
  type AskUserParams,
  type ApprovalLevel,
  type ThinkingLevel,
} from "@natstack/harness";
import { resolveModelToPi } from "@natstack/shared/ai/resolve-model.js";
import { AuthStorage, type AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ContinuationStore } from "./continuation-store.js";
import { ChannelClient } from "./channel-client.js";

const SAFE_TOOL_NAMES_DEFAULT: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "find",
]);

interface RunnerEntry {
  runner: PiRunner;
  contextFolderPath: string;
}

/** Resolves at the channel boundary when `onCallResult` arrives. */
interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export abstract class AgentWorkerBase extends DurableObjectBase {
  static override schemaVersion = 6;

  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected continuations: ContinuationStore;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();

  /** In-flight Promise resolvers keyed by callId. Used for tool callMethod
   *  and UI feedback_form awaits — when the channel routes the result via
   *  onCallResult, we resolve the corresponding Promise. */
  private pendingResolvers = new Map<string, PendingResolver>();

  /** Phase 0D: Transient poison message tracker. Resets on hibernation. */
  private failedEvents = new Map<number, number>();
  private static readonly POISON_MAX_ATTEMPTS = 3;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    const lazyRpc = {
      call: <T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> => {
        return this.rpc.call<T>(targetId, method, ...args);
      },
    };

    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => new ChannelClient(lazyRpc, channelId),
      this.identity,
    );
    this.continuations = new ContinuationStore(this.sql);

    this.ensureReady();
    this.identity.restore();
  }

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    this.continuations.createTables();
    // Delivery cursor for event dedup + gap repair.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
    // Per-channel Pi session file path for resume after DO restart.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_sessions (
        channel_id TEXT PRIMARY KEY,
        session_file TEXT NOT NULL,
        context_folder_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // ── Identity bootstrap ──────────────────────────────────────────────────

  private _bootstrapped = false;

  private ensureBootstrapped(): void {
    if (this._bootstrapped) return;
    try {
      const key = this.objectKey;
      const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
      const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
      const sessionId = (this.env as Record<string, string>)["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        this.identity.bootstrap(doRef, sessionId);
        this._bootstrapped = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("objectKey not available")) {
        console.error("[AgentWorkerBase] ensureBootstrapped failed:", err);
      }
    }
  }

  protected get doRef(): DORef {
    return this.identity.ref;
  }

  protected createChannelClient(channelId: string): ChannelClient {
    return new ChannelClient(this.rpc, channelId);
  }

  // ── Customization hooks (Pi-native) ─────────────────────────────────────

  /** Model id in `provider:model` format (e.g. `anthropic:claude-sonnet-4-20250514`). */
  protected getModel(): string {
    return "anthropic:claude-sonnet-4-20250514";
  }

  protected getThinkingLevel(): ThinkingLevel {
    return "medium";
  }

  protected getApprovalLevel(channelId: string): ApprovalLevel {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    if (!value) return 2; // Default: full auto
    const parsed = parseInt(value, 10);
    if (parsed === 0 || parsed === 1 || parsed === 2) return parsed;
    return 2;
  }

  protected setApprovalLevel(channelId: string, level: ApprovalLevel): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
    const entry = this.runners.get(channelId);
    if (entry) entry.runner.setApprovalLevel(level);
  }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== "message") return false;
    if (event.contentType) return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? "", senderId: event.senderId, attachments: event.attachments };
  }

  protected getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "agent",
      name: "AI Agent",
      type: "agent",
      metadata: {},
      methods: [],
    };
  }

  /**
   * Resolve the contextFolder absolute path for a given channel. Subclasses
   * can override; the default queries the server's contextFolderManager via
   * RPC using the subscription's contextId.
   */
  protected async resolveContextFolderPath(channelId: string): Promise<string> {
    const contextId = this.subscriptions.getContextId(channelId);
    return this.rpc.call<string>("main", "contextFolder.ensureContextFolder", contextId);
  }

  /**
   * Resolve the Pi agent dir (sandbox config root). Defaults to a hidden
   * directory under the natstack app root. Subclasses can override.
   */
  protected async resolvePiAgentDir(): Promise<string> {
    return this.rpc.call<string>("main", "contextFolder.getPiAgentDir");
  }

  /** API keys to bridge into Pi via setRuntimeApiKey. Default: read from env. */
  protected async getApiKeys(): Promise<Record<string, string>> {
    return this.rpc.call<Record<string, string>>("main", "secrets.getProviderApiKeys");
  }

  // ── Subscription lifecycle ──────────────────────────────────────────────

  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });

    if (result.channelConfig?.["approvalLevel"] != null) {
      const level = result.channelConfig["approvalLevel"] as number;
      if (level === 0 || level === 1 || level === 2) {
        this.setApprovalLevel(opts.channelId, level);
      }
    }

    if (result.replay) {
      try {
        for (const event of result.replay) {
          await this.onChannelEvent(opts.channelId, event);
        }
      } catch (err) {
        console.warn(`[AgentWorkerBase] Replay processing stopped:`, err);
      }
    }

    return { ok: result.ok, participantId: result.participantId };
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    await this.subscriptions.unsubscribeFromChannel(channelId);

    const entry = this.runners.get(channelId);
    if (entry) {
      entry.runner.dispose();
      this.runners.delete(channelId);
    }

    this.continuations.deleteForChannel(channelId);
    this.subscriptions.deleteSubscription(channelId);
    this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, channelId);

    return { ok: true };
  }

  // ── Channel event pipeline (dedup → gap repair → dispatch) ──────────────

  private async handleIncomingChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    const eventId = event.id;

    if (eventId !== undefined && eventId > 0) {
      const lastSeq = this.getDeliveryCursor(channelId);
      if (eventId <= lastSeq) return;

      if (eventId > lastSeq + 1) {
        await this.repairGap(channelId, lastSeq, eventId);
      }

      const attempts = this.failedEvents.get(eventId) ?? 0;
      if (attempts >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
        console.error(`[AgentWorkerBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`);
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
        return;
      }
    }

    try {
      await this.dispatchChannelEvent(channelId, event);
      if (eventId !== undefined && eventId > 0) {
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
      }
    } catch (err) {
      if (eventId !== undefined && eventId > 0) {
        const count = (this.failedEvents.get(eventId) ?? 0) + 1;
        this.failedEvents.set(eventId, count);
        if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
          console.error(`[AgentWorkerBase] Poison event id=${eventId} failed ${count} times, will skip on next delivery:`, err);
        } else {
          console.warn(`[AgentWorkerBase] onChannelEvent failed for id=${eventId} (attempt ${count}/${AgentWorkerBase.POISON_MAX_ATTEMPTS}):`, err);
        }
      } else {
        console.error("[AgentWorkerBase] onChannelEvent failed for ephemeral event:", err);
      }
    }
  }

  private getDeliveryCursor(channelId: string): number {
    const cursor = this.sql.exec(
      `SELECT last_delivered_seq FROM delivery_cursor WHERE channel_id = ?`, channelId,
    ).toArray();
    return cursor.length > 0 ? (cursor[0]!["last_delivered_seq"] as number) : 0;
  }

  private advanceDeliveryCursor(channelId: string, seq: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      channelId, seq,
    );
  }

  private async repairGap(channelId: string, lastSeq: number, eventId: number): Promise<void> {
    const gap = eventId - lastSeq - 1;
    if (gap > 1000) {
      console.error(`[AgentWorkerBase] Gap too large (${gap} events) in channel=${channelId}, skipping repair`);
      return;
    }
    try {
      const channel = this.createChannelClient(channelId);
      const missed = await channel.getEventRange(lastSeq, eventId - 1);
      if (!missed || !Array.isArray(missed)) return;

      for (const missedEvent of missed) {
        try {
          await this.dispatchChannelEvent(channelId, missedEvent);
          if (missedEvent.id !== undefined && missedEvent.id > 0) {
            this.advanceDeliveryCursor(channelId, missedEvent.id);
          }
        } catch (missedErr) {
          const missedId = missedEvent.id;
          if (missedId !== undefined && missedId > 0) {
            const count = (this.failedEvents.get(missedId) ?? 0) + 1;
            this.failedEvents.set(missedId, count);
            if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
              console.error(`[AgentWorkerBase] Poison event id=${missedId} in gap repair, skipping:`, missedErr);
              this.advanceDeliveryCursor(channelId, missedId);
            } else {
              console.warn(`[AgentWorkerBase] Gap repair event id=${missedId} failed (attempt ${count}):`, missedErr);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[AgentWorkerBase] Gap repair failed for channel=${channelId} gap=${lastSeq+1}..${eventId-1}:`, err);
    }
  }

  private async dispatchChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    if (event.type === "config-update") {
      let newLevel: number | undefined;
      try {
        const config = typeof event.payload === "object" && event.payload !== null
          ? event.payload as Record<string, unknown>
          : {};
        if ("approvalLevel" in config) {
          newLevel = config["approvalLevel"] as number;
        }
      } catch { /* ignore parse errors */ }
      if (newLevel !== undefined && (newLevel === 0 || newLevel === 1 || newLevel === 2)) {
        this.setApprovalLevel(channelId, newLevel);
      }
      return;
    }

    await this.onChannelEvent(channelId, event);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    const contextFolderPath = await this.resolveContextFolderPath(channelId);
    const piAgentDir = await this.resolvePiAgentDir();
    const apiKeys = await this.getApiKeys();

    const authStorage = AuthStorage.create();
    for (const [provider, key] of Object.entries(apiKeys)) {
      if (key) authStorage.setRuntimeApiKey(provider, key);
    }
    const { model } = resolveModelToPi(this.getModel(), authStorage);

    // Resume from a previously persisted Pi session file for this channel,
    // if one exists. New chats start fresh.
    const sessionRow = this.sql.exec(
      `SELECT session_file FROM pi_sessions WHERE channel_id = ?`, channelId,
    ).toArray();
    const resumeSessionFile = sessionRow.length > 0
      ? (sessionRow[0]!["session_file"] as string)
      : undefined;

    const runner = new PiRunner({
      contextFolderPath,
      piAgentDir,
      apiKeys,
      model,
      thinkingLevel: this.getThinkingLevel(),
      approvalLevel: this.getApprovalLevel(channelId),
      uiCallbacks: this.buildUICallbacks(channelId),
      rosterCallback: () => this.buildRoster(channelId),
      callMethodCallback: (handle, method, args, signal) =>
        this.invokeChannelMethod(channelId, handle, method, args, signal),
      askUserCallback: (params, signal) => this.askUser(channelId, params, signal),
      ...(resumeSessionFile ? { resumeSessionFile } : {}),
    });

    await runner.init();

    runner.subscribe((event) => this.forwardPiEvent(channelId, event));

    // Persist the session file path for restart recovery.
    const sessionFile = runner.sessionFile;
    if (sessionFile) {
      this.sql.exec(
        `INSERT OR REPLACE INTO pi_sessions (channel_id, session_file, context_folder_path, updated_at) VALUES (?, ?, ?, ?)`,
        channelId, sessionFile, contextFolderPath, Date.now(),
      );
    }

    this.runners.set(channelId, { runner, contextFolderPath });
    return runner;
  }

  // ── Pi event → channel ephemeral forwarding ─────────────────────────────

  private forwardPiEvent(channelId: string, event: AgentSessionEvent): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);

    switch (event.type) {
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame && ame.type === "text_delta" && ame.delta) {
          const messageId = (event.message as { id?: string } | undefined)?.id ?? "current";
          void channel.sendEphemeralEvent(participantId, "natstack-text-delta", {
            messageId,
            delta: ame.delta,
          });
        }
        break;
      }
      case "message_end":
      case "tool_execution_end":
      case "auto_compaction_end":
      case "auto_retry_end":
      case "turn_end": {
        const entry = this.runners.get(channelId);
        if (!entry) break;
        const snapshot = entry.runner.getStateSnapshot();
        void channel.sendEphemeralEvent(participantId, "natstack-state-snapshot", snapshot);
        break;
      }
      default:
        // No forwarding for other events.
        break;
    }
  }

  // ── Channel-tools extension wiring ──────────────────────────────────────

  /** Sync getter for the channel-tools extension. The extension expects a
   *  sync callback; we serve from the most-recently-cached roster. Refresh
   *  happens before each turn via `refreshRoster`. */
  private buildRoster(channelId: string): ChannelToolMethod[] {
    return this.cachedRoster.get(channelId) ?? [];
  }

  private cachedRoster = new Map<string, ChannelToolMethod[]>();

  /** Refresh the cached roster for a channel. Called before each turn. */
  protected async refreshRoster(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const selfId = this.subscriptions.getParticipantId(channelId);
    const roster: ChannelToolMethod[] = [];
    for (const p of participants) {
      if (p.participantId === selfId) continue;
      const handle = p.metadata["handle"] as string | undefined;
      if (!handle) continue;
      const advertised = p.metadata["methods"];
      if (!Array.isArray(advertised)) continue;
      for (const m of advertised) {
        const method = m as Record<string, unknown>;
        const name = method["name"] as string | undefined;
        if (!name) continue;
        roster.push({
          participantHandle: handle,
          name,
          description: (method["description"] as string) ?? "",
          parameters: method["parameters"] ?? { type: "object" },
        });
      }
    }
    this.cachedRoster.set(channelId, roster);
  }

  private async invokeChannelMethod(
    channelId: string,
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const target = participants.find((p) => p.metadata["handle"] === participantHandle);
    if (!target) {
      throw new Error(`No participant with handle "${participantHandle}" in channel ${channelId}`);
    }
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);

    const callId = crypto.randomUUID();
    const promise = this.awaitContinuation(callId, signal);
    this.continuations.store(callId, channelId, "tool-call", { handle: participantHandle, method });
    await channel.callMethod(callerId, target.participantId, callId, method, args);
    return promise;
  }

  private async askUser(
    channelId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    // Find a panel-type participant to ask.
    const participants = await channel.getParticipants();
    const panel = participants.find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    if (!panel) {
      throw new Error(`No panel participant in channel ${channelId} to ask`);
    }

    const callId = crypto.randomUUID();
    const promise = this.awaitContinuation(callId, signal);
    this.continuations.store(callId, channelId, "ask-user", {});
    await channel.callMethod(callerId, panel.participantId, callId, "feedback_form", params);
    const result = await promise;
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  private buildUICallbacks(channelId: string): NatStackUIBridgeCallbacks {
    const askPanel = async (
      kind: "select" | "confirm" | "input" | "editor",
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const callerId = this.subscriptions.getParticipantId(channelId);
      if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
      const channel = this.createChannelClient(channelId);
      const participants = await channel.getParticipants();
      const panel = participants.find((p) => {
        const t = p.metadata["type"] as string | undefined;
        return t === "panel" || t === "client";
      });
      if (!panel) throw new Error(`No panel participant in channel ${channelId}`);

      const callId = crypto.randomUUID();
      const promise = this.awaitContinuation(callId, signal);
      this.continuations.store(callId, channelId, "ui-prompt", { kind });
      await channel.callMethod(callerId, panel.participantId, callId, "ui_prompt", { kind, ...params });
      return promise;
    };

    return {
      showSelect: async (title, options, opts) => {
        const result = await askPanel("select", { title, options }, opts?.signal);
        return typeof result === "string" ? result : undefined;
      },
      showConfirm: async (title, message, opts) => {
        const result = await askPanel("confirm", { title, message }, opts?.signal);
        return result === true || result === "true" || result === "yes";
      },
      showInput: async (title, placeholder, opts) => {
        const result = await askPanel("input", { title, placeholder }, opts?.signal);
        return typeof result === "string" ? result : undefined;
      },
      showEditor: async (title, prefill) => {
        const result = await askPanel("editor", { title, prefill });
        return typeof result === "string" ? result : undefined;
      },
      notify: (message, type) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeral(participantId, message, `notify:${type ?? "info"}`);
      },
      setStatus: (key, text) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-status", { key, text });
      },
      setWidget: (key, content, options) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-widget", { key, content, options });
      },
      setWorkingMessage: (message) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-working", { message: message ?? null });
      },
    };
  }

  // ── Continuation Promise plumbing ───────────────────────────────────────

  private awaitContinuation(callId: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pendingResolvers.set(callId, { resolve, reject });
      if (signal) {
        const onAbort = () => {
          this.pendingResolvers.delete(callId);
          this.continuations.deleteOne(callId);
          reject(new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async onCallResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    const pending = this.continuations.consume(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError})`);
      return;
    }
    const resolver = this.pendingResolvers.get(callId);
    if (resolver) {
      this.pendingResolvers.delete(callId);
      if (isError) {
        const err = new Error(typeof result === "string" ? result : JSON.stringify(result));
        resolver.reject(err);
      } else {
        resolver.resolve(result);
      }
    }
  }

  // ── Default channel event handler ────────────────────────────────────────
  //
  // Subclasses MAY override this for custom routing, but the default behavior
  // covers the common case: incoming user messages are forwarded to Pi via the
  // per-channel runner. Pi handles the rest.

  async onChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    if (!this.shouldProcess(event)) return;

    const input = this.buildTurnInput(event);
    await this.refreshRoster(channelId);
    const runner = await this.getOrCreateRunner(channelId);
    const images: ImageContent[] | undefined = input.attachments
      ? input.attachments
          .filter((a) => a.mimeType?.startsWith("image/"))
          .map((a) => ({ type: "image" as const, mimeType: a.mimeType, data: a.data }))
      : undefined;
    if (runner.isStreaming) {
      await runner.steer(input.content, images);
    } else {
      await runner.runTurn(input.content, images);
    }
  }

  // ── Method calls (subclass hook) ─────────────────────────────────────────

  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: "not implemented" }, isError: true };
  }

  /** Interrupt the in-flight Pi turn for every active channel runner. */
  protected async interruptAllRunners(): Promise<void> {
    for (const entry of this.runners.values()) {
      await entry.runner.interrupt();
    }
  }

  /** Interrupt the in-flight Pi turn for a specific channel. */
  protected async interruptRunner(channelId: string): Promise<void> {
    const entry = this.runners.get(channelId);
    if (entry) await entry.runner.interrupt();
  }

  // ── Fork support (Pi-native) ────────────────────────────────────────────

  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
    const count = this.sql.exec(`SELECT COUNT(*) as cnt FROM subscriptions`).toArray();
    const n = (count[0]?.["cnt"] as number) ?? 0;
    if (n > 1) {
      return { ok: false, subscriptionCount: n, reason: "multi-channel" };
    }
    return { ok: true, subscriptionCount: n };
  }

  /**
   * Called on the newly cloned agent DO after cloneDO copies parent's SQLite.
   * Rewrites identity, clears ephemeral state, resubscribes to forked channel.
   * The cloned worker boots its own PiRunner pointing at the parent's session
   * file (or a forked one) on first message.
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkPointMessageId: string | null,
  ): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );

    this.setStateValue("forkedFrom", parentObjectKey);
    if (forkPointMessageId) {
      this.setStateValue("forkPointMessageId", forkPointMessageId);
    }
    this.setStateValue("forkSourceChannel", oldChannelId);

    // Clear ephemeral state copied from parent.
    this.sql.exec(`DELETE FROM delivery_cursor`);
    this.sql.exec(`DELETE FROM pending_calls`);

    // Migrate the parent's pi_sessions row from oldChannelId to newChannelId.
    // The fork point handling: if the parent's session file is at PATH and we
    // need to fork at forkPointMessageId, we'll need to call the runner's
    // fork() — but the cloned DO has no live runner yet. Defer fork until
    // the next user message arrives: when getOrCreateRunner sees a forkPointMessageId
    // in state, it forks via PiRunner.fork() before forwarding the user message.
    const parentSession = this.sql.exec(
      `SELECT session_file, context_folder_path FROM pi_sessions WHERE channel_id = ?`,
      oldChannelId,
    ).toArray();
    if (parentSession.length > 0) {
      this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, oldChannelId);
      this.sql.exec(
        `INSERT OR REPLACE INTO pi_sessions (channel_id, session_file, context_folder_path, updated_at) VALUES (?, ?, ?, ?)`,
        newChannelId,
        parentSession[0]!["session_file"] as string,
        parentSession[0]!["context_folder_path"] as string,
        Date.now(),
      );
    }

    // Rename approvalLevel state key.
    const oldApprovalKey = `approvalLevel:${oldChannelId}`;
    const newApprovalKey = `approvalLevel:${newChannelId}`;
    const approvalValue = this.getStateValue(oldApprovalKey);
    if (approvalValue) {
      this.setStateValue(newApprovalKey, approvalValue);
      this.deleteStateValue(oldApprovalKey);
    }

    // Resubscribe to the forked channel.
    const subRow = this.sql.exec(
      `SELECT context_id, config FROM subscriptions WHERE channel_id = ?`, oldChannelId,
    ).toArray();
    const contextId = subRow.length > 0 ? (subRow[0]!["context_id"] as string) : undefined;
    const configRaw = subRow.length > 0 ? (subRow[0]!["config"] as string | null) : null;
    const config = configRaw ? JSON.parse(configRaw) : undefined;

    this.sql.exec(`DELETE FROM subscriptions`);
    this.runners.clear(); // No live runners on a fresh clone.

    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config });
    }

    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkPointMessageId);
  }

  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkPointMessageId: string | null,
  ): Promise<void> {
    // Default: no-op
  }

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureBootstrapped();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    if (method === "__rpc") {
      const body = await request.json();
      const result = await this.rpc.handleIncomingPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "__event") {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }
      if (args.length < 2) {
        return new Response(JSON.stringify({ error: "__event requires at least [event, payload]" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const [event, payload, fromId] = args as [string, unknown, string | undefined];
      await this.rpc.handleIncomingPost({ type: "emit", event, payload, fromId: fromId ?? "" });
      return new Response(JSON.stringify({ result: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }

      if (method === "onChannelEvent" && args.length === 2) {
        await this.handleIncomingChannelEvent(args[0] as string, args[1] as ChannelEvent);
        return new Response(JSON.stringify(null), {
          headers: { "Content-Type": "application/json" },
        });
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
    const piSessions = this.sql.exec(`SELECT * FROM pi_sessions`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, piSessions, pendingCalls, deliveryCursors };
  }

  // Reference SAFE_TOOL_NAMES_DEFAULT to suppress unused-import warnings;
  // it's exported from the harness package via DEFAULT_SAFE_TOOL_NAMES, but
  // we keep a local reference here for documentation/symmetry.
  protected static readonly _SAFE_TOOL_NAMES_REFERENCE = SAFE_TOOL_NAMES_DEFAULT;
}
