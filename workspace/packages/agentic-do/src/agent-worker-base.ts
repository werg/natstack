/**
 * AgentWorkerBase — Pi-native agent DO base.
 *
 * Embeds `@mariozechner/pi-agent-core`'s `Agent` in-process via `PiRunner`
 * from `@natstack/harness`. One PiRunner per channel, owned by the DO for
 * the lifetime of the chat. The runner drives agent state (messages,
 * streaming, tool calls); the DO persists `AgentMessage[]` snapshots to
 * its SQL storage and forwards runner events to the channel as ephemeral
 * events.
 *
 * Composes:
 * - `DOIdentity`: stable DO ref + workerd session id
 * - `SubscriptionManager`: channel membership + replay state
 * - `ContinuationStore`: pending callId continuations for tool callMethod
 *   and feedback_form / inline UI awaits (Promise resolution from onCallResult)
 * - `ChannelClient`: typed wrapper around channel DO RPC
 *
 * Publishes Pi events as real channel messages (persisted, streamable):
 * - Text blocks stream via send → per-token delta updates → complete
 * - Thinking blocks publish all-at-once from finalized message_end
 * - Tool calls publish as contentType "action" (ActionData JSON)
 * - Image tool results publish as contentType "image" with attachments
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType, getDetailedActionDescription } from "@natstack/pubsub";
import {
  PiRunner,
  type ChannelToolMethod,
  type NatStackUIBridgeCallbacks,
  type AskUserParams,
  type ApprovalLevel,
  type ThinkingLevel,
} from "@natstack/harness";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ContinuationStore } from "./continuation-store.js";
import { ChannelClient } from "./channel-client.js";
import {
  truncateResult,
} from "./action-data.js";

const SAFE_TOOL_NAMES_DEFAULT: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "find",
]);

/**
 * TSX source for the OAuth Connect card pushed into the chat as an inline_ui
 * message when the model provider is not yet logged in. The chat panel's
 * `useInlineUi` hook compiles this via `compileComponent`/`transformCode` and
 * renders the resulting React component inside `<InlineUiMessage>`.
 *
 * Available imports inside the inline_ui sandbox: see
 * `workspace/skills/sandbox/INLINE_UI.md`. The component receives
 * `{ props, chat }` where `chat.rpc.call` is the panel's runtime RPC.
 *
 * The button calls `auth.startOAuthLogin(providerId)` directly. Server-side
 * idempotency in the auth service handles concurrent / repeated clicks:
 *   - First click → starts the OAuth flow, returns success on completion.
 *   - Concurrent clicks → return the same in-flight Promise.
 *   - Clicks after success → fast path returns success immediately.
 */
const OAUTH_CONNECT_CARD_TSX = `
import { useState } from "react";
import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";

export default function OAuthConnectCard({ props, chat }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const providerId = props.providerId;
  const displayName = props.displayName;

  const handleConnect = async () => {
    setStatus("connecting");
    setError(null);
    try {
      const result = await chat.rpc.call("main", "auth.startOAuthLogin", providerId);
      if (result && result.success) {
        setStatus("connected");
        // Auto-retry: publish a message so the agent's turn restarts with
        // valid credentials. The agent worker's onChannelEvent picks this up
        // and calls runner.runTurn, which calls getApiKey — this time it
        // succeeds because the auth service now has fresh OAuth credentials.
        chat.publish("message", {
          content: "Connected to " + displayName + ". Please continue where you left off."
        });
      } else {
        setStatus("error");
        setError((result && result.error) || "Login failed");
      }
    } catch (err) {
      setStatus("error");
      setError(err && err.message ? err.message : String(err));
    }
  };

  return (
    <Card variant="surface" size="2">
      <Flex direction="column" gap="3">
        <Box>
          <Text as="div" size="2" weight="medium">Sign in to {displayName}</Text>
          <Text as="div" size="1" color="gray" mt="1">
            To continue, this workspace needs to connect your {displayName} account.
            Click below to open the sign-in page in your browser.
          </Text>
        </Box>
        {status === "idle" && (
          <Button onClick={handleConnect}>Connect to {displayName}</Button>
        )}
        {status === "connecting" && (
          <Button disabled>Waiting for browser\\u2026</Button>
        )}
        {status === "connected" && (
          <Text size="2" color="green" weight="medium">Connected to {displayName}</Text>
        )}
        {status === "error" && (
          <Flex direction="column" gap="2">
            <Text size="1" color="red">{error}</Text>
            <Button onClick={handleConnect} variant="soft">Try again</Button>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
`.trim();

interface RunnerEntry {
  runner: PiRunner;
}

/** Resolves at the channel boundary when `onCallResult` arrives. */
interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Per-tool-call state stashed between message_start and tool_execution_end. */
interface ToolCallState {
  /** Channel message UUID for this action message. */
  channelMsgId: string;
  /** Tool name (e.g. "Read", "eval"). */
  toolName: string;
  /** Human-readable description from getDetailedActionDescription. */
  description: string;
  /** Tool arguments. */
  args: Record<string, unknown>;
  /** Accumulated console output from streaming updates. */
  consoleOutput: string;
}

export abstract class AgentWorkerBase extends DurableObjectBase {
  static override schemaVersion = 7;

  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected continuations: ContinuationStore;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();

  /** Channels whose `fs.bindContext` has been called at least once per DO
   *  lifetime. The FsService caller→context map is process-scoped, so we
   *  only need to bind once per DO startup per context. */
  private _fsContextBound = new Set<string>();

  /** In-flight Promise resolvers keyed by callId. Used for tool callMethod
   *  and UI feedback_form awaits — when the channel routes the result via
   *  onCallResult, we resolve the corresponding Promise. */
  private pendingResolvers = new Map<string, PendingResolver>();

  /** Streaming callbacks keyed by method callId. When a method-result event
   *  arrives with complete:false, the callback is invoked with the content.
   *  This bridges ctx.stream() from method providers to Pi's onUpdate. */
  private streamCallbacks = new Map<string, (content: unknown) => void>();

  /** OAuth Connect cards already emitted into a channel for a given provider.
   *  Keys are `${channelId}::${providerId}`. Process-scoped — resets on DO
   *  hibernation, which is fine because the next agent run will re-emit if
   *  the user hasn't connected yet. */
  private oauthCardsEmitted = new Set<string>();

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
    // Per-channel Pi agent message history for warm restore after DO hibernation.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_sessions (
        channel_id TEXT PRIMARY KEY,
        messages_blob TEXT NOT NULL,
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

  /**
   * Model id in `provider:model` format (e.g. `anthropic:claude-sonnet-4-20250514`,
   * `openai-codex:gpt-5`). Subclasses override to pick a different default.
   * PiRunner passes this directly to `pi-ai.getModel(provider, modelId)`.
   */
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

    // Bind this DO's caller identity to the context folder in FsService's
    // caller→context map. Required before `runtime.fs.*` calls can resolve
    // paths. Idempotent; guarded by _fsContextBound so we don't re-call
    // across repeated subscribes to the same context.
    if (!this._fsContextBound.has(opts.contextId)) {
      try {
        await this.rpc.call<void>("main", "fs.bindContext", opts.contextId);
        this._fsContextBound.add(opts.contextId);
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] fs.bindContext failed for contextId=${opts.contextId}:`,
          err,
        );
      }
    }

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

    // Complete any active typing indicator before tearing down.
    this.completeTypingIndicator(channelId);

    const entry = this.runners.get(channelId);
    if (entry) {
      entry.runner.dispose();
      this.runners.delete(channelId);
    }

    // Clean up per-channel streaming state (tool-call ID map, text msg tracking).
    this.channelStreamState.delete(channelId);

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

    // Intercept streaming method-result events (complete: false) and forward
    // to the registered stream callback. This bridges ctx.stream() from method
    // providers through to Pi's tool_execution_update event system.
    if (event.type === "method-result") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && payload["complete"] === false) {
        const callId = payload["callId"] as string | undefined;
        if (callId) {
          const cb = this.streamCallbacks.get(callId);
          if (cb) cb(payload["content"]);
        }
      }
      return;
    }

    await this.onChannelEvent(channelId, event);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    // Restore prior messages from SQL (warm-restart after DO hibernation,
    // or freshly cloned DO whose parent's blob was copied in postClone).
    const sessionRow = this.sql.exec(
      `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`,
      channelId,
    ).toArray();
    let initialMessages: AgentMessage[] = [];
    if (sessionRow.length > 0 && sessionRow[0]!["messages_blob"]) {
      try {
        initialMessages = JSON.parse(sessionRow[0]!["messages_blob"] as string) as AgentMessage[];
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] failed to parse persisted messages for channel=${channelId}:`,
          err,
        );
        initialMessages = [];
      }
    }

    const runner = new PiRunner({
      rpc: {
        call: <T = unknown>(target: string, method: string, ...args: unknown[]): Promise<T> =>
          this.rpc.call<T>(target, method, ...args),
      },
      fs: this.fs,
      uiCallbacks: this.buildUICallbacks(channelId),
      rosterCallback: () => this.buildRoster(channelId),
      callMethodCallback: (handle, method, args, signal, onStreamUpdate) =>
        this.invokeChannelMethod(channelId, handle, method, args, signal, onStreamUpdate),
      askUserCallback: (params, signal) => this.askUser(channelId, params, signal),
      model: this.getModel(),
      thinkingLevel: this.getThinkingLevel(),
      approvalLevel: this.getApprovalLevel(channelId),
      initialMessages,
      onPersist: (messages) => this.persistMessages(channelId, messages),
    });

    await runner.init();

    // Warm-restore: no synthetic snapshot needed — the channel already has
    // persisted messages that replay on panel connect.

    runner.subscribe((event) => this.publishPiEvent(channelId, event));

    this.runners.set(channelId, { runner });
    return runner;
  }

  /** Persist the current `AgentMessage[]` snapshot for warm restart. Called
   *  by PiRunner's `onPersist` hook on every `message_end` / `agent_end`. */
  private persistMessages(channelId: string, messages: AgentMessage[]): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pi_sessions (channel_id, updated_at, messages_blob) VALUES (?, ?, ?)`,
      channelId,
      Date.now(),
      JSON.stringify(messages),
    );
  }

  // ── Pi event → channel message publishing ──────────────────────────────

  /** Per-tool-call state stashed between message_start and tool_execution_end. */
  private static serializeActionData(
    toolCall: ToolCallState,
    overrides: {
      status: "pending" | "complete";
      result?: unknown;
      isError?: boolean;
      resultTruncated?: boolean;
    },
  ): string {
    return JSON.stringify({
      type: toolCall.toolName,
      description: toolCall.description,
      status: overrides.status,
      args: toolCall.args,
      consoleOutput: toolCall.consoleOutput || undefined,
      result: overrides.result,
      isError: overrides.isError,
      resultTruncated: overrides.resultTruncated,
    });
  }

  /** Per-channel streaming state for message ID tracking. */
  private channelStreamState = new Map<string, {
    /** Channel message UUID for the current streaming text block. */
    textMsgId: string | null;
    /** Channel message UUID for the active "typing" indicator (contentType: "typing").
     *  Created in onChannelEvent BEFORE the runner turn starts so the user sees
     *  immediate "Agent typing" feedback. Completed on first assistant message_start
     *  (when text actually begins streaming) or on agent_end / error. */
    typingMsgId: string | null;
    /** Per-tool-call state keyed by pi-agent-core toolCallId (e.g. "call_abc123"). */
    toolCalls: Map<string, ToolCallState>;
  }>();

  private getStreamState(channelId: string) {
    let state = this.channelStreamState.get(channelId);
    if (!state) {
      state = { textMsgId: null, typingMsgId: null, toolCalls: new Map() };
      this.channelStreamState.set(channelId, state);
    }
    return state;
  }

  /** Send a "typing" channel message so the chat UI shows "Agent typing" immediately.
   *  The message is persisted so it survives reconnects/replays and stays visible
   *  until we call completeTyping(). */
  private sendTypingIndicator(channelId: string): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    const state = this.getStreamState(channelId);

    // Don't double-send if one is already active.
    if (state.typingMsgId) return;

    const info = this.getParticipantInfo(channelId);
    const typingData = JSON.stringify({
      senderId: participantId,
      senderName: info.name,
      senderType: info.type,
    });
    const msgId = crypto.randomUUID();
    state.typingMsgId = msgId;
    void channel.send(participantId, msgId, typingData, {
      contentType: "typing",
      persist: true,
    });
  }

  /** Complete the active typing indicator for a channel (hides the "Agent typing" pill). */
  private completeTypingIndicator(channelId: string): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const state = this.channelStreamState.get(channelId);
    if (!state?.typingMsgId) return;

    const channel = this.createChannelClient(channelId);
    void channel.complete(participantId, state.typingMsgId);
    state.typingMsgId = null;
  }

  private publishPiEvent(channelId: string, event: AgentEvent): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    const state = this.getStreamState(channelId);

    switch (event.type) {
      case "message_start": {
        const msg = event.message as { role?: string; content?: unknown[] };
        if (msg.role !== "assistant") break;

        // The agent is producing output — complete the typing indicator.
        // This transitions the UI from "Agent typing" → actual streaming content.
        this.completeTypingIndicator(channelId);

        const blocks = Array.isArray(msg.content) ? msg.content : [];

        // Create streaming channel message for the first text block.
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i] as { type?: string; text?: string };
          if (block?.type === "text") {
            const msgId = crypto.randomUUID();
            state.textMsgId = msgId;
            void channel.send(participantId, msgId, block.text ?? "", { persist: true });
            break;
          }
        }

        // Create action messages for any toolCall blocks visible at start.
        for (const block of blocks) {
          const b = block as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
          if (b?.type === "toolCall" && b.id) {
            const toolCall: ToolCallState = {
              channelMsgId: crypto.randomUUID(),
              toolName: b.name ?? "tool",
              description: getDetailedActionDescription(b.name ?? "tool", b.arguments ?? {}),
              args: b.arguments ?? {},
              consoleOutput: "",
            };
            state.toolCalls.set(b.id, toolCall);
            void channel.send(participantId, toolCall.channelMsgId,
              AgentWorkerBase.serializeActionData(toolCall, { status: "pending" }),
              { contentType: "action", persist: true },
            );
          }
        }
        break;
      }

      case "message_update": {
        const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
          .assistantMessageEvent;
        if (ame?.type !== "text_delta" || !ame.delta) break;

        // If a text block hasn't been created yet (model started with tool calls
        // and then added text), create one now.
        if (!state.textMsgId) {
          const msgId = crypto.randomUUID();
          state.textMsgId = msgId;
          void channel.send(participantId, msgId, "", { persist: true });
        }

        // Send delta directly — the PubSub protocol appends update content.
        if (state.textMsgId) {
          void channel.update(participantId, state.textMsgId, ame.delta);
        }
        break;
      }

      case "message_end": {
        // Complete text message.
        if (state.textMsgId) {
          const textId = state.textMsgId;
          void channel.complete(participantId, textId);
          state.textMsgId = null;
        }

        // Walk ALL finalized content blocks: thinking, toolCall, extra text, images.
        const msg = event.message as { content?: unknown[] };
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        let textBlocksSeen = 0;

        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i] as {
            type?: string; text?: string; thinking?: string; id?: string; name?: string;
            arguments?: Record<string, unknown>; mimeType?: string; data?: string;
          };

          if (block?.type === "thinking" && typeof block.thinking === "string") {
            const thinkId = crypto.randomUUID();
            void channel.send(participantId, thinkId, block.thinking, {
              contentType: "thinking",
              persist: true,
            }).then(() => channel.complete(participantId, thinkId));
          }

          // Additional text blocks beyond the first (which was streamed).
          if (block?.type === "text" && typeof block.text === "string") {
            textBlocksSeen++;
            if (textBlocksSeen > 1) {
              // The first text block was streamed live; publish additional ones all-at-once.
              const extraId = crypto.randomUUID();
              void channel.send(participantId, extraId, block.text, { persist: true })
                .then(() => channel.complete(participantId, extraId));
            }
          }

          // Assistant-side image blocks (uncommon but supported by pi-ai).
          if (block?.type === "image" && block.mimeType && block.data) {
            const imgId = crypto.randomUUID();
            void channel.send(participantId, imgId, "", {
              contentType: "image",
              persist: true,
              attachments: [{ data: block.data, mimeType: block.mimeType }],
            }).then(() => channel.complete(participantId, imgId));
          }

          // Create action messages for toolCall blocks not yet created at message_start.
          if (block?.type === "toolCall" && block.id && !state.toolCalls.has(block.id)) {
            const args = (block.arguments ?? {}) as Record<string, unknown>;
            const toolCall: ToolCallState = {
              channelMsgId: crypto.randomUUID(),
              toolName: block.name ?? "tool",
              description: getDetailedActionDescription(block.name ?? "tool", args),
              args,
              consoleOutput: "",
            };
            state.toolCalls.set(block.id, toolCall);
            void channel.send(participantId, toolCall.channelMsgId,
              AgentWorkerBase.serializeActionData(toolCall, { status: "pending" }),
              { contentType: "action", persist: true },
            );
          }
        }

        break;
      }

      case "tool_execution_start": {
        // Status stays "pending" until tool_execution_end flips to "complete".
        break;
      }

      case "tool_execution_update": {
        const { toolCallId } = event;
        const toolCall = state.toolCalls.get(toolCallId);
        if (toolCall) {
          const details = (event as { partialResult?: { details?: unknown } }).partialResult?.details;
          const content = details as { type?: string; content?: string } | undefined;
          if (content?.type === "console" && typeof content.content === "string") {
            toolCall.consoleOutput = toolCall.consoleOutput
              ? `${toolCall.consoleOutput}\n${content.content}`
              : content.content;
            void channel.update(participantId, toolCall.channelMsgId,
              AgentWorkerBase.serializeActionData(toolCall, { status: "pending" }),
            );
          }
        }
        break;
      }

      case "tool_execution_end": {
        const { toolCallId, result, isError } = event;
        const toolCall = state.toolCalls.get(toolCallId);
        if (toolCall) {
          const { value: truncatedResult, truncated } = truncateResult(result);
          void channel.update(participantId, toolCall.channelMsgId,
            AgentWorkerBase.serializeActionData(toolCall, {
              status: "complete",
              result: truncatedResult,
              isError: isError || false,
              resultTruncated: truncated,
            }),
          ).then(() => channel.complete(participantId, toolCall.channelMsgId));
          state.toolCalls.delete(toolCallId);
        }

        // Publish image content from tool results.
        if (!isError && result != null) {
          this.publishToolResultImages(channelId, participantId, channel, result);
        }

        // After a tool completes, the agent will either call another tool or
        // produce an assistant message. Re-show the typing indicator to cover
        // the gap between tool-end and the next message_start. If the agent
        // immediately starts a new message, message_start will complete it
        // within milliseconds — the flicker is imperceptible.
        this.sendTypingIndicator(channelId);
        break;
      }

      case "agent_end":
      case "turn_end":
        // Cleanup: if the typing indicator is still active (e.g., the agent
        // finished without producing an assistant message, or an error occurred
        // before message_start), complete it now so the UI doesn't show a
        // stale "Agent typing" pill.
        this.completeTypingIndicator(channelId);
        break;

      default:
        // No channel message needed for agent_start, turn_start.
        break;
    }
  }


  /** Check a tool result for ImageContent blocks and publish them as image channel messages.
   *  Pi-agent-core wraps tool results as `{ content: [{type, ...}], details }`.
   *  We check both the top-level result AND the `.content` array. */
  private publishToolResultImages(
    _channelId: string,
    participantId: string,
    channel: ChannelClient,
    result: unknown,
  ): void {
    const candidates: unknown[] = [];
    // Direct array of content items
    if (Array.isArray(result)) {
      candidates.push(...result);
    } else if (result && typeof result === "object") {
      // Pi-agent-core AgentToolResult shape: { content: [...], details: {...} }
      const r = result as { content?: unknown[] };
      if (Array.isArray(r.content)) {
        candidates.push(...r.content);
      } else {
        candidates.push(result);
      }
    }
    for (const item of candidates) {
      const img = item as { type?: string; mimeType?: string; data?: string };
      if (img?.type === "image" && img.mimeType && img.data) {
        const imgId = crypto.randomUUID();
        void channel.send(participantId, imgId, "", {
          contentType: "image",
          persist: true,
          attachments: [{ data: img.data, mimeType: img.mimeType }],
        }).then(() => channel.complete(participantId, imgId));
      }
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
    onStreamUpdate?: (content: unknown) => void,
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
    if (onStreamUpdate) this.streamCallbacks.set(callId, onStreamUpdate);
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
      requestProviderOAuth: (providerId, displayName) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const key = `${channelId}::${providerId}`;
        if (this.oauthCardsEmitted.has(key)) return;
        this.oauthCardsEmitted.add(key);

        const channel = this.createChannelClient(channelId);
        const messageId = crypto.randomUUID();
        const content = JSON.stringify({
          id: `oauth-connect-${providerId}-${messageId}`,
          code: OAUTH_CONNECT_CARD_TSX,
          props: { providerId, displayName },
        });
        void channel
          .send(participantId, messageId, content, {
            contentType: "inline_ui",
            persist: true,
          })
          .catch((err) => {
            console.error(`[AgentWorkerBase] Failed to emit OAuth Connect card for ${providerId}:`, err);
            this.oauthCardsEmitted.delete(key);
          });
      },
    };
  }

  // ── Continuation Promise plumbing ───────────────────────────────────────

  /** Watchdog alarm interval for orphaned continuations (ms). */
  private static readonly CONTINUATION_WATCHDOG_MS = 60_000;

  private awaitContinuation(callId: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pendingResolvers.set(callId, { resolve, reject });

      // Set a watchdog alarm so that if the DO hibernates (losing in-memory
      // resolvers), the alarm wakes us and we can detect orphaned continuations.
      this.setAlarm(AgentWorkerBase.CONTINUATION_WATCHDOG_MS);

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
    this.streamCallbacks.delete(callId);
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
    } else {
      // Resolver lost — DO restarted while waiting for this result.
      // The agent turn that was awaiting this is gone. Notify the channel.
      console.warn(
        `[AgentWorkerBase] onCallResult: orphaned continuation callId=${callId} channel=${pending.channelId} — DO restarted while waiting`,
      );
      this.notifyOrphanedContinuation(pending.channelId);
    }
  }

  // ── Orphaned continuation recovery ─────────────────────────────────────

  override async alarm(): Promise<void> {
    await super.alarm();
    this.recoverOrphanedContinuations();
  }

  /**
   * Detect SQL-persisted continuations that have no in-memory resolver.
   * This happens when the DO hibernated/restarted while the agent was
   * waiting for a panel response. The agent turn is gone; clean up and
   * notify.
   */
  private recoverOrphanedContinuations(): void {
    // Query all pending continuations from SQL.
    const rows = this.sql.exec(
      `SELECT call_id, channel_id FROM pending_calls`,
    ).toArray();

    const notifiedChannels = new Set<string>();
    for (const row of rows) {
      const callId = row["call_id"] as string;
      const channelId = row["channel_id"] as string;

      if (!this.pendingResolvers.has(callId)) {
        // Orphaned: SQL row exists but no in-memory resolver.
        console.warn(
          `[AgentWorkerBase] alarm: cleaning orphaned continuation callId=${callId} channel=${channelId}`,
        );
        this.continuations.deleteOne(callId);
        if (!notifiedChannels.has(channelId)) {
          notifiedChannels.add(channelId);
          this.notifyOrphanedContinuation(channelId);
        }
      }
    }
  }

  /** Send a system message to the channel that the agent was interrupted. */
  private notifyOrphanedContinuation(channelId: string): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    const msgId = `interrupted-${crypto.randomUUID()}`;
    void channel.send(
      participantId,
      msgId,
      "The agent was interrupted while waiting for a response. Please resend your message to continue.",
      { persist: true },
    ).then(() => channel.complete(participantId, msgId));
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

    // Resize user-pasted image attachments via the server-side image service
    // (W1k). Most providers will happily accept oversize images but at
    // noticeable token/latency cost. Best-effort: on failure fall through to
    // the original bytes.
    const images: ImageContent[] = [];
    for (const att of input.attachments ?? []) {
      if (!att.mimeType?.startsWith("image/")) continue;
      try {
        const bytes = Buffer.from(att.data, "base64");
        const resized = await this.rpc.call<{
          data: Uint8Array;
          mimeType: string;
          wasResized: boolean;
        }>(
          "main",
          "image.resize",
          bytes,
          att.mimeType,
          { maxWidth: 2000, maxHeight: 2000 },
        );
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: Buffer.from(resized.data).toString("base64"),
        });
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] image.resize failed for channel=${channelId}; passing original:`,
          err,
        );
        images.push({ type: "image", mimeType: att.mimeType, data: att.data });
      }
    }

    const imagesArg = images.length > 0 ? images : undefined;

    // Send a typing indicator BEFORE the runner starts so the user sees
    // immediate "Agent typing" feedback. The indicator will be completed
    // when the first assistant message arrives (message_start in publishPiEvent),
    // or on agent_end/error as cleanup.
    if (!runner.isStreaming) {
      this.sendTypingIndicator(channelId);
    }

    if (runner.isStreaming) {
      await runner.steer(input.content, imagesArg);
    } else {
      await runner.runTurn(input.content, imagesArg);
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
    if (entry) {
      // Clear the typing indicator immediately on interrupt so the UI
      // doesn't show a stale "Agent typing" pill after the user cancelled.
      this.completeTypingIndicator(channelId);
      await entry.runner.interrupt();
    }
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
   * The cloned worker boots its own PiRunner from the persisted
   * `messages_blob` on first user message (optionally truncated to
   * `forkAtMessageIndex` messages if the caller forked mid-history).
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkAtMessageIndex: number | null,
  ): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );

    this.setStateValue("forkedFrom", parentObjectKey);
    if (forkAtMessageIndex != null) {
      this.setStateValue("forkAtMessageIndex", String(forkAtMessageIndex));
    }
    this.setStateValue("forkSourceChannel", oldChannelId);

    // Clear ephemeral state copied from parent.
    this.sql.exec(`DELETE FROM delivery_cursor`);
    this.sql.exec(`DELETE FROM pending_calls`);

    // Migrate the parent's pi_sessions row from oldChannelId → newChannelId.
    // If forking mid-history, slice the parent's messages_blob to the desired
    // length so the cloned runner starts with the truncated history.
    const parentSession = this.sql.exec(
      `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`,
      oldChannelId,
    ).toArray();
    if (parentSession.length > 0) {
      let messagesBlob = parentSession[0]!["messages_blob"] as string;
      if (forkAtMessageIndex != null) {
        try {
          const parsed = JSON.parse(messagesBlob) as AgentMessage[];
          const truncated = parsed.slice(0, forkAtMessageIndex);
          messagesBlob = JSON.stringify(truncated);
        } catch (err) {
          console.warn(
            `[AgentWorkerBase] failed to truncate parent messages_blob at index=${forkAtMessageIndex}:`,
            err,
          );
        }
      }
      this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, oldChannelId);
      this.sql.exec(
        `INSERT OR REPLACE INTO pi_sessions (channel_id, updated_at, messages_blob) VALUES (?, ?, ?)`,
        newChannelId,
        Date.now(),
        messagesBlob,
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
    this._fsContextBound.clear(); // Re-bind fs context on first resubscribe.

    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config });
    }

    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkAtMessageIndex);
  }

  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkAtMessageIndex: number | null,
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
