/**
 * AgentVesselBase (WS1 §2.7) — the thin, event-sourced agent vessel.
 *
 * Replaces TrajectoryVesselBase (8,662 lines). Composition only:
 *
 *   DOIdentity + SubscriptionManager + ChannelClient   — transport plumbing
 *   FeedbackIngest + CardManager                       — UX surfaces (unchanged)
 *   AgentLoopDriver (+ pure @workspace/agent-loop)     — ALL turn semantics
 *
 * Every durable decision lives in the trajectory log; this class only wires
 * ports (blobstore, credentials, local tools, channel calls) and translates
 * the DO surface (subscribe/envelope/methodCall/fork/alarm) into commands.
 */

import { DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@workspace/runtime/workerd-client";
import type { ChannelReplayEnvelope, RpcChannelMessage } from "@workspace/pubsub";
import {
  composeSystemPrompt,
  type ChannelEvent,
  type ParticipantDescriptor,
  type SystemPromptMode,
} from "@workspace/harness";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  hydrateStoredValueRefs,
  isRespondPolicy,
  resolveShouldRespond,
  stableSha256Hex,
  type AgenticEvent,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { AgentTool } from "@workspace/pi-core";
import { serializeByKey } from "@natstack/shared/keyedSerializer";
import {
  defaultPolicies,
  derivedTurnStatus,
  ids,
  silentPolicy,
  type AgentLoopConfig,
  type AgentState,
  type EffectOutcome,
  type RespondPolicy,
  type RosterEntry,
  type StepPolicy,
  type ThinkingLevel,
} from "@workspace/agent-loop";
import {
  createModelCredentialSentinel,
  installUrlBoundModelFetchProxy,
} from "./model-fetch-proxy.js";
import type { StoredCredentialSummary as ModelCredentialSummary } from "@workspace/runtime/credentials";
import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ChannelClient } from "./channel-client.js";
import { FeedbackIngest } from "./feedback-ingest.js";
import { CardManager } from "./custom-cards.js";
import { AgentLoopDriver, type DriverDeps } from "./agent-loop-driver.js";
import {
  CredentialApprovalDeferredError,
  CredentialPendingError,
  type EphemeralEmit,
  type ExecutorDeps,
} from "./effect-executors/index.js";

const DELTA_BATCH_MS = 100;
const CHANNEL_STATE_CACHE_MS = 5_000;
const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const BLOB_TEXT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** ~256KB of serialized session entries before compaction — comfortably
 *  under modern model context windows while keeping plenty of recent
 *  history. Subclasses override getCompactionTriggerBytes for a tighter or
 *  model-sized budget. */
const DEFAULT_COMPACTION_TRIGGER_BYTES = 256 * 1024;

export type ApprovalLevel = 0 | 1 | 2;

export type CustomMessageReducer = (state: unknown, update: unknown) => unknown;

export interface AgentSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
  approvalLevel: ApprovalLevel;
  respondPolicy: RespondPolicy;
  respondFrom: string[];
  /** Optional cap for model rounds in one turn. `null` means unlimited. */
  maxModelCallsPerTurn: number | null;
  /** Idle watchdog for model streams. `null` intentionally disables it. */
  modelStreamIdleTimeoutMs: number | null;
}

/** Per-channel settings — a Ref-kind KV value; every model call journals the
 *  values it actually used in its request descriptor, so the audit trail is
 *  the log, not this pointer. */
interface StoredSettings extends Partial<AgentSettings> {}

export interface AgentPromptResources {
  workspacePrompt?: string;
  skillIndex?: string;
}

export interface AgentPromptOverride {
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
}

function isSystemPromptMode(value: unknown): value is SystemPromptMode {
  return value === "append" || value === "replace" || value === "replace-natstack";
}

/** Context handed to {@link AgentVesselBase.onChannelForked} after a clone. */
export interface ClonedChannelContext {
  /** Channel id the parent was subscribed to (the clone is NOT subscribed to it). */
  oldChannelId: string;
  /** Channel id the clone is about to be subscribed to. */
  newChannelId: string;
  forkPointPubsubId: number;
}

export abstract class AgentVesselBase extends DurableObjectBase {
  protected readonly identity: DOIdentity;
  protected readonly subscriptions: SubscriptionManager;
  protected readonly feedback: FeedbackIngest;
  protected readonly cards: CardManager;
  private _driver: AgentLoopDriver | null = null;
  private readonly localTools = new Map<string, Map<string, AgentTool>>();
  private readonly deltaBuffers = new Map<string, { events: AgenticEvent[]; timer: unknown }>();
  private readonly channelClients = new Map<string, ChannelClient>();
  private readonly channelConfigCache = new Map<
    string,
    { expiresAt: number; value: Record<string, unknown> | null }
  >();
  private readonly participantCache = new Map<
    string,
    {
      expiresAt: number;
      value: Array<{ participantId: string; metadata: Record<string, unknown> }>;
    }
  >();
  private readonly blobTextCache = new Map<string, { value: string; bytes: number }>();
  private blobTextCacheBytes = 0;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
    // Module tables are owned by the composed managers (constructed below);
    // driver tables (effect_outbox, fold_cache) are created lazily on first
    // driver use. createTables() itself is therefore a no-op hook.
    this.identity = new DOIdentity(this.sql);
    this.identity.createTables();
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => this.createChannelClient(channelId),
      this.identity,
      () => this.participantId()
    );
    this.subscriptions.createTables();
    this.feedback = new FeedbackIngest(this.sql);
    this.cards = new CardManager({
      sql: this.sql,
      createChannelClient: (channelId) => this.createChannelClient(channelId),
      getParticipantId: (channelId) => this.subscriptions.getParticipantId(channelId),
      getActor: () => ({ kind: "agent", id: this.participantId() }),
      getAgentId: () => this.objectKey,
    });
  }

  protected createTables(): void {
    // Composed managers create their own tables; nothing to do here.
  }

  // ── Subclass surface (WS1 §3.2 — names preserved where semantics survive) ─

  protected getDefaultModel(): string {
    return "anthropic:claude-sonnet-4-6";
  }
  protected getDefaultThinkingLevel(): ThinkingLevel {
    return "medium";
  }
  protected getDefaultApprovalLevel(): ApprovalLevel {
    return 2;
  }
  protected getDefaultRespondPolicy(): RespondPolicy {
    return "mentioned-or-followup";
  }
  protected getDefaultRespondFrom(): string[] {
    return [];
  }
  protected getDefaultModelStreamIdleTimeoutMs(): number | null {
    return DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
  }

  /** Idle-history byte budget that triggers compaction. Subclasses with a
   *  known model context window should override this to ~0.7× the window
   *  (in serialized-entry bytes). */
  protected getCompactionTriggerBytes(): number {
    return DEFAULT_COMPACTION_TRIGGER_BYTES;
  }

  protected abstract getParticipantInfo(
    channelId: string,
    config?: unknown
  ): ParticipantDescriptor;

  /** Workspace-level prompt resources. Workspace agents load AGENTS.md and the
   *  skill index here; non-workspace agents may return nothing. */
  protected loadPromptResources(
    _channelId: string
  ): AgentPromptResources | Promise<AgentPromptResources> {
    return {};
  }

  /** Clears any prompt resource cache owned by a subclass. */
  protected invalidatePromptResources(_channelId?: string): void {}

  /** Agent-class behavior prompt, such as a Gmail-specific role. */
  protected getAgentPrompt(_channelId: string): string | undefined {
    return undefined;
  }

  /** Per-subscription user/workspace override. */
  protected getPromptOverride(channelId: string): AgentPromptOverride {
    const config = this.subscriptions.getConfig(channelId);
    const override: AgentPromptOverride = {};
    if (typeof config?.systemPrompt === "string") {
      override.systemPrompt = config.systemPrompt;
    }
    if (isSystemPromptMode(config?.systemPromptMode)) {
      override.systemPromptMode = config.systemPromptMode;
    }
    return override;
  }

  /** Final system prompt text for a channel (blob-spilled; its hash rides every
   *  model request descriptor). */
  protected async composePrompt(channelId: string): Promise<string> {
    const resources = await this.loadPromptResources(channelId);
    const agentPrompt = this.getAgentPrompt(channelId);
    const override = this.getPromptOverride(channelId);
    return composeSystemPrompt({
      ...(resources.workspacePrompt !== undefined
        ? { workspacePrompt: resources.workspacePrompt }
        : {}),
      ...(resources.skillIndex !== undefined ? { skillIndex: resources.skillIndex } : {}),
      ...(agentPrompt !== undefined ? { agentPrompt } : {}),
      ...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
      ...(override.systemPromptMode !== undefined
        ? { systemPromptMode: override.systemPromptMode }
        : {}),
    });
  }

  /** Local tools registered with the local-tool executor. */
  protected getLoopTools(_channelId: string): AgentTool[] {
    return [];
  }

  /** Step policies composed onto the pure loop (silent agents, card flows…). */
  protected getStepPolicies(_channelId: string): StepPolicy[] {
    return defaultPolicies();
  }

  /** Test seam: replace effect executors (e.g. inject a scripted model so a
   *  full turn can be driven without a live model). Production returns
   *  undefined — the real executors run. */
  protected getDriverExecutorOverride(): DriverDeps["executorOverride"] {
    return undefined;
  }

  /** Roster method names this agent expects (warning surface only). */
  protected getExpectedChannelToolNames(_channelId: string): readonly string[] {
    return [];
  }

  /** Hook before addressing — return true to swallow the event. */
  protected async onChannelEvent(_channelId: string, _event: ChannelEvent): Promise<boolean> {
    return false;
  }

  protected getModelCredentialSetupProps(_providerId: string): Record<string, unknown> | null {
    return null;
  }

  /** Provider claims baked into the JWT-shaped sentinel apiKey (e.g.
   *  openai-codex's chatgpt_account_id). Subclass hook; default none. */
  protected getModelCredentialTokenClaims(
    _providerId: string,
    _credential: ModelCredentialSummary
  ): Record<string, unknown> {
    return {};
  }

  /** Fork hook. The clone has been re-identified and its subscription renamed
   *  old→new, but the new channel is not yet (re)subscribed. Subclasses purge
   *  or migrate the per-channel state the clone copied wholesale from the
   *  parent here — and may set flags that the subsequent subscribeChannel
   *  reads. Without this, any agent that keys SQLite by channelId or runs a
   *  per-channel scheduler would have the clone act on a channel it no longer
   *  holds a subscription on. */
  protected async onChannelForked(_ctx: ClonedChannelContext): Promise<void> {}

  // ── Wiring ────────────────────────────────────────────────────────────────

  protected createChannelClient(channelId: string): ChannelClient {
    let client = this.channelClients.get(channelId);
    if (!client) {
      client = new ChannelClient(this.rpc, channelId);
      this.channelClients.set(channelId, client);
    }
    return client;
  }

  private _identityBootstrapped = false;

  /** Bootstrap identity from the workerd env (idempotent, best-effort). */
  protected ensureIdentity(): void {
    if (this._identityBootstrapped) return;
    try {
      const env = this.env as Record<string, string>;
      const source = env["WORKER_SOURCE"];
      const className = env["WORKER_CLASS_NAME"];
      const sessionId = env["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const generationRaw = env["WORKERD_BOOT_GENERATION"];
        const generation =
          typeof generationRaw === "string" && generationRaw.length > 0
            ? Number.parseInt(generationRaw, 10)
            : null;
        this.identity.bootstrap(
          { source, className, objectKey: this.objectKey },
          sessionId,
          Number.isFinite(generation) ? generation : null
        );
        this._identityBootstrapped = true;
      }
    } catch {
      /* objectKey not assigned yet — retried on next use */
    }
  }

  protected participantId(): string {
    this.ensureIdentity();
    try {
      const ref = this.identity.ref;
      return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
    } catch {
      // Pre-bootstrap (constructor-time / unit tests): fall back to the
      // object key, which is stable for a given DO instance.
      return `do:unknown:unknown:${this.objectKey}`;
    }
  }

  protected selfRef(channelId: string): ParticipantRef {
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    return {
      kind: "agent",
      id: this.participantId(),
      participantId: this.participantId(),
      displayName: descriptor.name,
      metadata: { type: descriptor.type, name: descriptor.name, handle: descriptor.handle },
    };
  }

  protected get driver(): AgentLoopDriver {
    this._driver ??= new AgentLoopDriver({
      sql: this.sql,
      gad: {
        call: <T,>(method: string, args: Record<string, unknown>) =>
          this.callGad<T>(method, args),
      },
      executorDeps: this.executorDeps(),
      selfRefFor: (channelId) => this.selfRef(channelId),
      configFor: (channelId) => this.loopConfig(channelId),
      policiesFor: (channelId) => this.getStepPolicies(channelId),
      onEphemeral: (emit) => this.emitEphemeral(emit),
      broadcastStoredEnvelopes: async (channelId, envelopeIds) => {
        await this.createChannelClient(channelId).broadcastStoredEnvelopes(envelopeIds);
      },
      now: () => Date.now(),
      // Idle-history budget before a fold-shrinking compaction. Kept well
      // below typical model context windows so context never grows to the
      // model's hard limit (the deleted CompactionTrigger used ~0.8× the
      // window); a subclass can tune via getCompactionTriggerBytes.
      compaction: { triggerBytes: this.getCompactionTriggerBytes() },
      scheduleAlarm: (at) => this.setAlarm(Math.max(at - Date.now(), 50)),
      runBackground: (fn) => {
        const promise = fn();
        this.ctx.waitUntil?.(promise);
      },
      executorOverride: this.getDriverExecutorOverride(),
    });
    this._driver.connectSpecProvider = async (providerId) =>
      this.getModelCredentialSetupProps(providerId) ?? { providerId };
    return this._driver;
  }

  private _gadClient: DurableObjectServiceClient | null = null;

  private async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    this._gadClient ??= createGadServiceClient({
      call: <R,>(targetId: string, m: string, a: unknown[]) => this.rpc.call<R>(targetId, m, a),
    });
    return this._gadClient.call<T>(method, ...args);
  }

  private executorDeps(): ExecutorDeps {
    let ref: { source: string; className: string; objectKey: string };
    try {
      ref = this.identity.ref;
    } catch {
      // Pre-bootstrap fallback (constructor wiring / unit tests).
      ref = { source: "unknown", className: "unknown", objectKey: this.objectKey };
    }
    return {
      selfRef: { kind: "agent", id: this.participantId(), participantId: this.participantId() },
      blobstore: {
        getText: (digest) => this.getCachedBlobText(digest),
        putText: async (value) => {
          const stored = await this.rpc.call<{ digest: string; size: number }>(
            "main",
            "blobstore.putText",
            [value]
          );
          this.rememberBlobText(stored.digest, value);
          return stored;
        },
      },
      channel: {
        callMethod: async (input) => {
          await this.createChannelClient(input.channelId).callMethod(
            this.participantId(),
            input.targetParticipantId,
            input.transportCallId,
            input.method,
            input.args,
            {
              invocationId: input.invocationId,
              transportCallId: input.transportCallId,
              ...(input.turnId ? { turnId: input.turnId } : {}),
              ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
            }
          );
        },
        publish: async (input) => {
          await this.rpc.call(
            await this.channelTarget(input.channelId),
            "publish",
            [
              this.participantId(),
              input.payloadKind,
              input.payload,
              input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
            ]
          );
        },
        sendSignalEvent: async (channelId, event) => {
          await this.createChannelClient(channelId).sendSignalEvent(
            this.participantId(),
            AGENTIC_EVENT_PAYLOAD_KIND,
            event
          );
        },
      },
      credentials: {
        getApiKey: async ({ providerId, modelBaseUrl, requestId, idempotencyKey }) => {
          // Prefer URL-bound credentials when the model exposes a concrete
          // endpoint; fall back to provider-scoped credentials for providers
          // whose registry entries do not carry a base URL.
          let summary: ModelCredentialSummary | null;
          const resolveRequest = modelBaseUrl ? { url: modelBaseUrl } : { providerId };
          try {
            if (requestId) {
              const ack = await this.rpc.callDeferred(
                "main",
                "credentials.resolveCredential",
                [resolveRequest],
                { requestId, idempotencyKey: idempotencyKey ?? requestId }
              );
              if (ack.status === "deferred") {
                throw new CredentialApprovalDeferredError(providerId, modelBaseUrl);
              }
              summary = ack.result as ModelCredentialSummary | null;
            } else {
              summary = await this.rpc.call<ModelCredentialSummary | null>(
                "main",
                "credentials.resolveCredential",
                [resolveRequest]
              );
            }
            if (!summary) throw new CredentialPendingError(providerId, modelBaseUrl);
          } catch (err) {
            if (
              !(
                err instanceof CredentialPendingError ||
                err instanceof CredentialApprovalDeferredError
              )
            ) {
              console.warn(
                `[AgentVessel] resolveCredential(${modelBaseUrl ?? providerId}) failed:`,
                err instanceof Error ? err.message : err
              );
            }
            if (
              err instanceof CredentialPendingError ||
              err instanceof CredentialApprovalDeferredError
            ) {
              throw err;
            }
            throw new CredentialPendingError(providerId, modelBaseUrl);
          }
          installUrlBoundModelFetchProxy(modelBaseUrl ?? "*", (url, init) =>
            this.credentials.fetch(url, init)
          );
          return {
            apiKey: createModelCredentialSentinel(
              this.getModelCredentialTokenClaims(providerId, summary)
            ),
          };
        },
        registerCredentialInterest: async () => {
          // Resolution arrives via the `credentialConnected` agent method —
          // panel-driven, no server-side interest registry required.
        },
      },
      localTools: {
        run: async ({ channelId, tool, invocationId, args, signal, onProgress }) => {
          const registry = await this.toolRegistry(channelId);
          const agentTool = registry.get(tool);
          if (!agentTool) {
            return { result: `unknown tool: ${tool}`, isError: true };
          }
          const params = agentTool.prepareArguments
            ? agentTool.prepareArguments(args)
            : (args as never);
          try {
            const result = await agentTool.execute(
              invocationId,
              params as never,
              signal,
              (update) => onProgress?.(update)
            );
            return {
              result: { protocolContent: result.content, details: result.details },
              isError: false,
            };
          } catch (err) {
            return {
              result: err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        },
        alreadyApplied: () => false,
      },
      http: {
        post: async (input) => {
          if (!input.target) throw new Error("http_call requires a target service/method");
          // Deferral opt-in (CAP-5): capability-gated server methods (egress
          // domain approval, permission prompts) PARK server-side instead of
          // holding this RPC open across a human approval — the outbox row is
          // the durable continuation, keyed by branch-scoped outbox id, and the result
          // arrives via onDeferredResult → deliverEffectOutcome. Non-gated
          // methods complete inline exactly as before (deferIfNeeded only
          // parks when an approval is actually pending).
          const ack = await this.rpc.callDeferred(
            "main",
            `${input.target.service}.${input.target.method}`,
            [input.request],
            { requestId: input.effectId, idempotencyKey: input.idempotencyKey }
          );
          if (ack.status === "deferred") return { deferred: true };
          return { deferred: false, result: ack.result, isError: false };
        },
      },
      callbackAddress: {
        source: ref.source,
        className: ref.className,
        objectKey: ref.objectKey,
      },
      env: this.env,
    };
  }

  private async getCachedBlobText(digest: string): Promise<string | null> {
    const cached = this.blobTextCache.get(digest);
    if (cached) {
      this.blobTextCache.delete(digest);
      this.blobTextCache.set(digest, cached);
      return cached.value;
    }
    const value = await this.rpc.call<string | null>("main", "blobstore.getText", [digest]);
    if (value != null) this.rememberBlobText(digest, value);
    return value;
  }

  private rememberBlobText(digest: string, value: string): void {
    const bytes = new TextEncoder().encode(value).byteLength;
    const existing = this.blobTextCache.get(digest);
    if (existing) this.blobTextCacheBytes -= existing.bytes;
    this.blobTextCache.delete(digest);
    this.blobTextCache.set(digest, { value, bytes });
    this.blobTextCacheBytes += bytes;
    while (this.blobTextCacheBytes > BLOB_TEXT_CACHE_MAX_BYTES) {
      const first = this.blobTextCache.entries().next().value as
        | [string, { value: string; bytes: number }]
        | undefined;
      if (!first) break;
      this.blobTextCache.delete(first[0]);
      this.blobTextCacheBytes -= first[1].bytes;
    }
  }

  private async channelTarget(channelId: string): Promise<string> {
    const service = await this.rpc.call<{ targetId?: string }>("main", "workers.resolveService", [
      "natstack.channel.v1",
      channelId,
    ]);
    if (!service.targetId) throw new Error("channel service did not resolve");
    return service.targetId;
  }

  /** Batched delta signals (~100ms) — never durable (WS1 §2.4.1). */
  /** Per-channel ordered signal sender — concurrent fire-and-forget posts
   *  arrive out of order and scramble streamed token text; the chain keeps
   *  delta order end to end (across flush batches too). */
  private readonly signalChains = new Map<string, Promise<unknown>>();

  private sendOrderedSignal(channelId: string, events: AgenticEvent[]): void {
    void serializeByKey(this.signalChains, channelId, () =>
      this.createChannelClient(channelId)
        .sendSignalEvent(
          this.participantId(),
          AGENTIC_EVENT_PAYLOAD_KIND,
          events.length === 1 ? events[0] : events
        )
        .catch(() => {})
    );
  }

  private emitEphemeral(emit: EphemeralEmit): void {
    const buffer = this.deltaBuffers.get(emit.channelId) ?? { events: [], timer: null };
    buffer.events.push(emit.event);
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        const drained = this.deltaBuffers.get(emit.channelId);
        this.deltaBuffers.delete(emit.channelId);
        const events = drained?.events ?? [];
        if (events.length > 0) this.sendOrderedSignal(emit.channelId, events);
      }, DELTA_BATCH_MS);
    }
    this.deltaBuffers.set(emit.channelId, buffer);
  }

  // ── Settings (Ref-kind KV; the log journals what each call actually used) ─

  private settingsKey(channelId: string): string {
    return `agent:settings:${channelId}`;
  }

  private storedSettings(channelId: string): StoredSettings {
    const raw = this.getStateValue(this.settingsKey(channelId));
    if (!raw) return {};
    try {
      return JSON.parse(raw) as StoredSettings;
    } catch {
      return {};
    }
  }

  protected updateSettings(channelId: string, patch: StoredSettings): AgentSettings {
    const next = { ...this.storedSettings(channelId), ...patch };
    this.setStateValue(this.settingsKey(channelId), JSON.stringify(next));
    // Settings feed the fold's initial config: drop the cached loop + fold
    // cache so the next wake refolds with the new configuration.
    this.driver.dropLoop(channelId);
    this.driver.foldCache.delete(ids.logIdForChannel(channelId), ids.logIdForChannel(channelId));
    return this.getAgentSettings(channelId);
  }

  getAgentSettings(channelId: string): AgentSettings {
    const stored = this.storedSettings(channelId);
    const config = this.subscriptions.getConfig(channelId) as
      | Record<string, unknown>
      | undefined;
    const approval = stored.approvalLevel ?? (config?.["approvalLevel"] as ApprovalLevel);
    const modelStreamIdleTimeoutMs = this.modelStreamIdleTimeoutMsFrom(
      stored.modelStreamIdleTimeoutMs,
      config?.["modelStreamIdleTimeoutMs"],
      this.getDefaultModelStreamIdleTimeoutMs()
    );
    const maxModelCallsPerTurn = this.maxModelCallsPerTurnFrom(
      stored.maxModelCallsPerTurn,
      config?.["maxModelCallsPerTurn"],
      null
    );
    return {
      model:
        stored.model ??
        (typeof config?.["model"] === "string" ? (config["model"] as string) : undefined) ??
        this.getDefaultModel(),
      thinkingLevel: stored.thinkingLevel ?? this.getDefaultThinkingLevel(),
      approvalLevel: approval === 0 || approval === 1 || approval === 2
        ? approval
        : this.getDefaultApprovalLevel(),
      respondPolicy: isRespondPolicy(stored.respondPolicy)
        ? stored.respondPolicy
        : isRespondPolicy(config?.["respondPolicy"])
          ? (config?.["respondPolicy"] as RespondPolicy)
          : this.getRespondPolicy(channelId),
      respondFrom: stored.respondFrom ?? this.getDefaultRespondFrom(),
      maxModelCallsPerTurn,
      modelStreamIdleTimeoutMs,
    };
  }

  protected getRespondPolicy(_channelId: string): RespondPolicy {
    return this.getDefaultRespondPolicy();
  }

  private loopConfig(channelId: string): AgentLoopConfig {
    const settings = this.getAgentSettings(channelId);
    return {
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      approvalLevel: settings.approvalLevel,
      respondPolicy: settings.respondPolicy,
      systemPromptHash: this.getStateValue(`agent:promptHash:${channelId}`) ?? "",
      toolSchemasHash: this.getStateValue(`agent:toolsHash:${channelId}`) ?? undefined,
      activeToolNames: JSON.parse(
        this.getStateValue(`agent:toolNames:${channelId}`) ?? "[]"
      ) as string[],
      roster: { participants: [] }, // roster snapshots fold from system.event
      maxModelCallsPerTurn: settings.maxModelCallsPerTurn,
      modelStreamIdleTimeoutMs: settings.modelStreamIdleTimeoutMs,
    };
  }

  /** Compose + blob-spill the prompt/tool artifacts whose hashes ride every
   *  model request descriptor. Content-addressed: cheap to re-run. */
  protected async ensurePromptArtifacts(channelId: string): Promise<void> {
    try {
      const systemPrompt = await this.composePrompt(channelId);
      const registry = await this.toolRegistry(channelId);
      const schemas: Array<{ name: string; description?: string; parameters?: unknown }> = [
        ...registry.values(),
      ].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      // Channel tools: roster participants' advertised methods become model
      // tools dispatched as channel_call effects (the panel's eval/UI surface).
      const seenTools = new Set(registry.keys());
      for (const participant of this.rosterSnapshot(channelId)) {
        for (const method of participant.methods) {
          if (seenTools.has(method.name)) continue;
          seenTools.add(method.name);
          schemas.push({
            name: method.name,
            description:
              method.description ??
              `Channel method on @${participant.handle ?? participant.participantId}`,
            parameters:
              method.parameters ?? { type: "object", properties: {}, additionalProperties: true },
          });
        }
      }
      const schemasJson = JSON.stringify(schemas);
      const names = JSON.stringify([...registry.keys()]);
      const signature = stableSha256Hex({ systemPrompt, schemas });
      const promptHashKey = `agent:promptHash:${channelId}`;
      const toolsHashKey = `agent:toolsHash:${channelId}`;
      const toolNamesKey = `agent:toolNames:${channelId}`;
      const artifactSigKey = `agent:artifactSig:${channelId}`;
      const existingPromptHash = this.getStateValue(promptHashKey) ?? "";
      const existingToolsHash = this.getStateValue(toolsHashKey) ?? "";
      if (
        existingPromptHash &&
        existingToolsHash &&
        this.getStateValue(artifactSigKey) === signature &&
        this.getStateValue(toolNamesKey) === names
      ) {
        return;
      }
      const prompt = await this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
        systemPrompt,
      ]);
      const tools = await this.rpc.call<{ digest?: string }>("main", "blobstore.putText", [
        schemasJson,
      ]);
      const promptHash = typeof prompt?.digest === "string" ? prompt.digest : "";
      const toolsHash = typeof tools?.digest === "string" ? tools.digest : "";
      const changed =
        existingPromptHash !== promptHash ||
        existingToolsHash !== toolsHash ||
        this.getStateValue(toolNamesKey) !== names;
      this.setStateValue(promptHashKey, promptHash);
      this.setStateValue(toolsHashKey, toolsHash);
      this.setStateValue(toolNamesKey, names);
      this.setStateValue(artifactSigKey, signature);
      this.deleteStateValue(`agent:promptArtifactError:${channelId}`);
      if (changed) {
        this.driver.dropLoop(channelId);
        this.driver.foldCache.delete(ids.logIdForChannel(channelId), ids.logIdForChannel(channelId));
      }
    } catch (err) {
      await this.publishPromptArtifactDiagnostic(channelId, err);
      throw err;
    }
  }

  private async publishPromptArtifactDiagnostic(channelId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const signature = stableSha256Hex({ channelId, message }).slice(0, 16);
    const errorKey = `agent:promptArtifactError:${channelId}`;
    if (this.getStateValue(errorKey) === signature) return;
    this.setStateValue(errorKey, signature);

    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const messageId = `agent-prompt-artifact-error:${signature}`;
    const event: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: this.getParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        ).name,
      },
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: `${messageId}:diagnostic` as never,
            type: "diagnostic",
            content:
              "Agent prompt setup failed. The agent will not start a model turn until workspace prompt resources load successfully.",
            metadata: {
              code: "prompt_artifact_load_failed",
              severity: "error",
              reason: message,
              recoverable: true,
            },
          },
        ],
        outcome: "completed",
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: messageId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((publishErr) => {
        console.error(
          `[AgentVessel] prompt artifact diagnostic emit failed for ${channelId}:`,
          publishErr
        );
      });
  }

  /** Last roster snapshot for a channel (set by maybeRefreshRoster). */
  private rosterSnapshot(channelId: string): RosterEntry[] {
    try {
      const raw = this.getStateValue(`agent:roster:${channelId}`);
      return raw ? (JSON.parse(raw) as RosterEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async toolRegistry(channelId: string): Promise<Map<string, AgentTool>> {
    let registry = this.localTools.get(channelId);
    if (!registry) {
      registry = new Map();
      // Standard tools every vessel gets, regardless of getLoopTools overrides.
      registry.set("memory_recall", this.createMemoryRecallTool());
      for (const tool of this.getLoopTools(channelId)) {
        registry.set(tool.name, tool);
      }
      this.localTools.set(channelId, registry);
    }
    return registry;
  }

  /**
   * Workspace memory search (WS4): chat messages, knowledge claims, and
   * committed file content, with provenance. The recall result is journaled
   * via the invocation terminal like any tool output — replays and audits
   * see exactly what was recalled.
   */
  private createMemoryRecallTool(): AgentTool<never> {
    return {
      name: "memory_recall",
      label: "memory_recall",
      description:
        "Search workspace memory: past conversation messages, recorded knowledge claims, and committed file content. " +
        "Returns snippets with provenance (who/when/where). Use before re-deriving facts that may already be known.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms." },
          kinds: {
            type: "array",
            items: { type: "string", enum: ["message", "claim", "file"] },
            description: "Optional filter by memory kind.",
          },
          limit: { type: "number", description: "Max results (default 10, max 50)." },
        },
        required: ["query"],
      } as never,
      execute: async (_toolCallId, params) => {
        const input = params as { query?: unknown; kinds?: unknown; limit?: unknown };
        if (typeof input.query !== "string" || !input.query.trim()) {
          throw new Error("memory_recall requires a non-empty query");
        }
        const recall = await this.callGad<{
          results: Array<{
            kind: string;
            snippet: string;
            path: string | null;
            eventId: string | null;
            actor: unknown;
            appendedAt: string | null;
          }>;
        }>("recallMemory", {
          query: input.query,
          kinds: Array.isArray(input.kinds)
            ? input.kinds.filter((kind): kind is string => typeof kind === "string")
            : null,
          limit: typeof input.limit === "number" ? input.limit : null,
        });
        const lines = recall.results.map((result) => {
          const where =
            result.path ??
            (result.actor && typeof result.actor === "object" && "id" in result.actor
              ? String((result.actor as { id: unknown }).id)
              : (result.eventId ?? "unknown"));
          const when = result.appendedAt ? ` @ ${result.appendedAt}` : "";
          return `[${result.kind}] ${where}${when}\n${result.snippet}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                lines.length > 0
                  ? lines.join("\n\n")
                  : "No memory matched the query.",
            },
          ],
          details: { resultCount: recall.results.length } as never,
        };
      },
    };
  }

  // ── Channel membership ───────────────────────────────────────────────────

  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    this.ensureIdentity();
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });
    if (result.channelConfig?.["approvalLevel"] != null) {
      const level = result.channelConfig["approvalLevel"];
      if (level === 0 || level === 1 || level === 2) {
        this.updateSettings(opts.channelId, { approvalLevel: level });
      }
    }
    await this.ensurePromptArtifacts(opts.channelId);
    await this.ingestSubscriptionReplay(opts.channelId, result.envelope);
    return { ok: result.ok, participantId: result.participantId };
  }

  private async ingestSubscriptionReplay(
    channelId: string,
    envelope: ChannelReplayEnvelope | undefined
  ): Promise<void> {
    if (envelope?.logEvents?.length) {
      for (const event of envelope.logEvents) {
        await this.processChannelEvent(channelId, {
          id: event.id,
          messageId: event.messageId,
          type: event.type,
          payload: event.payload,
          senderId: event.senderId,
          ts: event.ts,
          ...(event.senderMetadata ? { senderMetadata: event.senderMetadata } : {}),
          ...(event.contentType ? { contentType: event.contentType } : {}),
          ...(event.attachments ? { attachments: event.attachments } : {}),
          ...((event as unknown as { annotations?: Record<string, unknown> }).annotations
            ? {
                annotations: (event as unknown as { annotations: Record<string, unknown> })
                  .annotations,
              }
            : {}),
        });
      }
    }
    await this.driver.wake(channelId);
  }

  async unsubscribeChannel(channelId: string): Promise<{ ok: boolean }> {
    try {
      await this.driver.handleIncoming(channelId, {
        type: "command",
        command: { kind: "abort", reason: "channel_unsubscribe" },
      });
      await this.subscriptions.unsubscribeFromChannel(channelId);
    } finally {
      this.subscriptions.deleteSubscription(channelId);
      this.driver.dropLoop(channelId);
    }
    return { ok: true };
  }

  // ── Channel intake ───────────────────────────────────────────────────────

  async onChannelEnvelope(channelId: string, envelope: RpcChannelMessage): Promise<void> {
    if (envelope.kind === "control") {
      if (envelope.type === "ready") {
        await this.driver.wake(channelId);
      }
      return;
    }
    if (envelope.kind === "log" && envelope.event) {
      await this.processChannelEvent(channelId, envelope.event);
      return;
    }
    // signals are advisory — subclasses may hook them via onChannelEvent
    if (envelope.kind === "signal" && envelope.type) {
      await this.onChannelEvent(channelId, {
        id: 0,
        messageId: "",
        type: envelope.type,
        payload: envelope.payload,
        senderId: envelope.senderId ?? "system",
        ts: envelope.ts ?? Date.now(),
      });
    }
  }

  async processChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    // Invalidate the cached participant roster on any presence change, in the one sink both the
    // live stream and subscription-replay paths funnel through — so neither path serves a stale
    // roster to shouldRespond / maybeRefreshRoster.
    if (event.type === "presence") this.participantCache.delete(channelId);
    if (await this.onChannelEvent(channelId, event)) return;
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return;
    const maybeFeedback = event.payload as AgenticEvent | null;
    if (maybeFeedback && (maybeFeedback as { kind?: string }).kind === "ui.feedback") {
      const payload = (maybeFeedback as AgenticEvent<"ui.feedback">).payload;
      if ((payload.target as { participantId?: string })?.participantId === this.participantId()) {
        this.feedback.ingest(channelId, payload);
      }
      return;
    }
    // Outcome routing first: a channel invocation terminal for one of our
    // pending channel_call effects settles that effect. This must run BEFORE
    // the message.completed gate and the self-sender skip — the channel
    // journals call terminals with the CALLER (us) as sender.
    if (await this.routeInvocationTerminal(channelId, event)) return;

    const agentic = event.payload as AgenticEvent | null;
    if (!agentic || (agentic as { kind?: string }).kind !== "message.completed") return;
    if (event.senderId === this.participantId()) return;

    const respond = await this.shouldRespond(channelId, event);
    if (!respond) return;

    await this.maybeRefreshRoster(channelId);
    await this.ensurePromptArtifacts(channelId);
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        // Replayed history is deduped downstream by envelope id
        // (alreadyIngested) — only messages the loop never saw open a turn,
        // so backlog that arrived while the agent was down still gets a
        // response after replay.
        kind: "prompt",
        channelId,
        source: { envelopeId: event.messageId },
        content: this.turnContent(channelId, event),
        senderRef: (agentic as AgenticEvent).actor,
        agentHops: event.annotations?.["agentHops"] as number | undefined,
      },
    });
  }

  /** Channel terminals for our pending channel_call/approval-form effects. */
  private static readonly INVOCATION_TERMINAL_KINDS = new Set([
    "invocation.completed",
    "invocation.failed",
    "invocation.cancelled",
    "invocation.abandoned",
  ]);

  /** Settle our pending channel_call effects from the channel's durable
   *  invocation terminals (the channel broadcasts them to all subscribers,
   *  including us, the caller). This IS the outcome-delivery leg of the
   *  channel_call at-least-once protocol — without it a turn that invokes a
   *  panel method (eval, set_title, …) never advances. Duplicate delivery is
   *  a no-op: the outbox row is gone after the first settle. */
  private async routeInvocationTerminal(
    channelId: string,
    event: ChannelEvent
  ): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const kind = (agentic as { kind?: string }).kind ?? "";
    if (!kind.startsWith("invocation.")) return false;
    if (!AgentVesselBase.INVOCATION_TERMINAL_KINDS.has(kind)) {
      return true; // started/output traffic is never a prompt
    }
    const causality = ((agentic as { causality?: Record<string, unknown> }).causality ??
      {}) as Record<string, unknown>;
    const invocationId =
      typeof causality["invocationId"] === "string" ? (causality["invocationId"] as string) : null;
    if (!invocationId) return true;
    const effectId = ids.invocationEffect(invocationId);
    const row = this.driver.outbox.getForChannel(channelId, effectId);
    if (!row || row.kind !== "channel_call") return true; // not ours or already settled
    const descriptor = row.descriptor as import("@workspace/agent-loop").ChannelCallEffect;
    const payload = ((agentic as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
      string,
      unknown
    >;
    const isError = kind !== "invocation.completed";
    let outcome: EffectOutcome;
    if (descriptor.purpose === "approval-form") {
      const raw = await this.hydrateTransportValue(payload["result"]);
      const granted =
        !isError &&
        !!raw &&
        typeof raw === "object" &&
        (raw as { granted?: unknown }).granted === true;
      outcome = {
        kind: "approval",
        granted,
        resolvedBy: descriptor.target,
        ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] as string } : {}),
      };
      if (isError) {
        await this.publishApprovalDeliveryDiagnostic(channelId, descriptor, payload["reason"]);
      }
    } else {
      outcome = {
        kind: "tool",
        result: payload["result"] ?? payload["error"] ?? payload["reason"] ?? null,
        isError,
        ...(typeof payload["reason"] === "string" ? { reason: payload["reason"] as string } : {}),
      };
    }
    await this.driver.deliverEffectOutcome(effectId, outcome, { channelId });
    return true;
  }

  private async publishApprovalDeliveryDiagnostic(
    channelId: string,
    descriptor: import("@workspace/agent-loop").ChannelCallEffect,
    reason: unknown
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const messageId = `approval-delivery-failed:${descriptor.transportCallId}`;
    const reasonText =
      typeof reason === "string" && reason.trim() ? reason : "approval prompt unavailable";
    const event: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: this.getParticipantInfo(
          channelId,
          this.subscriptions.getConfig(channelId)
        ).name,
      },
      turnId: descriptor.turnId as never,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        blocks: [
          {
            blockId: `${messageId}:diagnostic` as never,
            type: "diagnostic",
            content: "Approval prompt could not be delivered. The requested action was denied.",
            metadata: {
              code: "approval_prompt_unavailable",
              severity: "error",
              reason: reasonText,
              invocationId: descriptor.invocationId,
            },
          },
        ],
        outcome: "completed",
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: messageId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(`[AgentVessel] approval diagnostic emit failed for ${channelId}:`, err);
      });
  }

  private turnContent(channelId: string, event: ChannelEvent): unknown {
    const agentic = event.payload as { payload?: { blocks?: unknown[] } };
    const blocks = agentic.payload?.blocks ?? [];
    const text = blocks
      .map((block) =>
        block && typeof block === "object" && typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : ""
      )
      .filter(Boolean)
      .join("\n");
    const notes = this.feedback.consume(channelId);
    return notes.length > 0 ? [...notes, text].filter(Boolean).join("\n\n") : text;
  }

  protected async shouldRespond(channelId: string, event: ChannelEvent): Promise<boolean> {
    const agentic = event.payload as AgenticEvent;
    const payload = (agentic.payload ?? {}) as {
      mentions?: string[];
      replyTo?: string;
      to?: never[];
    };
    const channel = this.createChannelClient(channelId);
    let lastCompletedSender: string | null = null;
    let lastCompletedMessageId: string | null = null;
    let replyToSenderId: string | undefined;
    let conversationPolicy: "open" | "directed" | "moderated" | undefined;
    let agentHopLimit: number | undefined;
    let participantIds: string[] = [];
    let agentStreakHops: number | undefined;
    try {
      const [policyState, config, participants] = await Promise.all([
        channel.getPolicyState(),
        this.getCachedChannelConfig(channelId),
        this.getCachedParticipants(channelId),
      ]);
      const conversation = policyState.state as {
        lastCompletedSender: string | null;
        lastCompletedMessageId?: string | null;
        lastCompletedSeq: number | null;
        previousCompletedSender: string | null;
        previousCompletedMessageId?: string | null;
        agentStreak?: number;
      };
      // The GAD trajectory fan-out path doesn't run the channel policy annotate,
      // so agent-published rows lack the per-event `agentHops` annotation. The
      // policy's `agentStreak` (folded over every channel row, incl. fan-out) is
      // the equivalent hop count — use it as the fallback so the loop breaker
      // still fires for agent→agent chains.
      if (typeof conversation.agentStreak === "number") {
        agentStreakHops = conversation.agentStreak;
      }
      lastCompletedSender =
        conversation.lastCompletedSeq != null && conversation.lastCompletedSeq === event.id
          ? conversation.previousCompletedSender
          : conversation.lastCompletedSender;
      lastCompletedMessageId =
        conversation.lastCompletedSeq != null && conversation.lastCompletedSeq === event.id
          ? (conversation.previousCompletedMessageId ?? null)
          : (conversation.lastCompletedMessageId ?? null);
      if (
        config?.["conversationPolicy"] === "open" ||
        config?.["conversationPolicy"] === "directed" ||
        config?.["conversationPolicy"] === "moderated"
      ) {
        conversationPolicy = config["conversationPolicy"];
      }
      if (typeof config?.["agentHopLimit"] === "number") {
        agentHopLimit = config["agentHopLimit"];
      }
      participantIds = participants.map((participant) => participant.participantId);
      if (payload.replyTo) {
        replyToSenderId =
          (await channel.getMessageSender(this.participantId(), payload.replyTo)) ??
          (payload.replyTo === lastCompletedMessageId ? lastCompletedSender ?? undefined : undefined);
      }
    } catch {
      /* addressing degrades gracefully without channel state */
    }
    const settings = this.getAgentSettings(channelId);
    const decision = resolveShouldRespond({
      event: {
        senderParticipantId: event.senderId,
        senderKind: agentic.actor?.kind ?? "user",
        mentions: payload.mentions,
        replyTo: payload.replyTo,
        replyToSenderId,
        to: payload.to,
        agentHops:
          (event.annotations?.["agentHops"] as number | undefined) ?? agentStreakHops,
      },
      self: { participantId: this.participantId() },
      policy: settings.respondPolicy,
      respondFrom: settings.respondFrom,
      participantIds,
      lastCompletedSender,
      conversationPolicy,
      agentHopLimit,
    });
    return decision.respond;
  }

  /** roster.snapshot details are class-INLINE (the fold reads them; there is
   *  no implicit spill, oversize is a hard encode error) — so this emitter
   *  bounds what panels advertise: descriptions are truncated, oversized
   *  parameter JSON-Schemas are dropped (the method stays callable; the
   *  model just loses its schema). */
  private static readonly MAX_ROSTER_DESCRIPTION_CHARS = 2_000;
  private static readonly MAX_ROSTER_PARAMETERS_BYTES = 16 * 1024;

  private boundedRosterMethod(method: {
    name: string;
    description?: string;
    parameters?: unknown;
  }): { name: string; description?: string; parameters?: unknown } {
    const description =
      typeof method.description === "string"
        ? method.description.slice(0, AgentVesselBase.MAX_ROSTER_DESCRIPTION_CHARS)
        : undefined;
    let parameters = method.parameters;
    if (parameters !== undefined) {
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(parameters)).byteLength;
        if (bytes > AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES) {
          console.warn(
            `[Vessel] dropping oversized parameter schema for roster method ` +
              `${method.name} (${bytes} bytes > ${AgentVesselBase.MAX_ROSTER_PARAMETERS_BYTES})`
          );
          parameters = undefined;
        }
      } catch {
        parameters = undefined;
      }
    }
    return {
      name: method.name,
      ...(description !== undefined ? { description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    };
  }

  /** Roster changes enter the log as events (nondeterministic I/O → journal). */
  private async maybeRefreshRoster(channelId: string): Promise<void> {
    try {
      const participants = await this.getCachedParticipants(channelId);
      const roster: RosterEntry[] = participants
        .filter((participant) => participant.participantId !== this.participantId())
        .map((participant) => ({
          participantId: participant.participantId,
          ref: {
            kind: "panel",
            id: participant.participantId,
            participantId: participant.participantId,
          } as ParticipantRef,
          handle:
            typeof participant.metadata?.["handle"] === "string"
              ? (participant.metadata["handle"] as string)
              : undefined,
          type:
            typeof participant.metadata?.["type"] === "string"
              ? (participant.metadata["type"] as string)
              : undefined,
          methods: Array.isArray(participant.metadata?.["methods"])
            ? (
                participant.metadata["methods"] as Array<{
                  name?: string;
                  description?: string;
                  parameters?: unknown;
                }>
              )
                .filter((method) => typeof method?.name === "string")
                .map((method) => this.boundedRosterMethod(method as { name: string } & typeof method))
            : [],
        }));
      const fingerprint = JSON.stringify(roster);
      if (this.getStateValue(`agent:roster:${channelId}`) === fingerprint) return;
      const loop = await this.driver.loop(channelId);
      const envelope = await this.appendRosterSnapshot(loop.state, channelId, roster);
      await this.driver.handleIncoming(channelId, {
        type: "event-appended",
        envelope: envelope as never,
      });
      this.setStateValue(`agent:roster:${channelId}`, fingerprint);
    } catch {
      /* roster refresh is best-effort */
    }
  }

  private async getCachedChannelConfig(channelId: string): Promise<Record<string, unknown> | null> {
    const now = Date.now();
    const cached = this.channelConfigCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value =
      (await this.createChannelClient(channelId).getConfig()) ??
      ((this.subscriptions.getConfig(channelId) as Record<string, unknown> | null) ?? null);
    this.channelConfigCache.set(channelId, { value, expiresAt: now + CHANNEL_STATE_CACHE_MS });
    return value;
  }

  private async getCachedParticipants(
    channelId: string
  ): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    const now = Date.now();
    const cached = this.participantCache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.createChannelClient(channelId).getParticipants();
    this.participantCache.set(channelId, { value, expiresAt: now + CHANNEL_STATE_CACHE_MS });
    return value;
  }

  private async appendRosterSnapshot(
    state: AgentState,
    channelId: string,
    roster: RosterEntry[]
  ): Promise<unknown> {
    const result = await this.callGad<{ envelopes: unknown[] }>("appendLogEvent", {
      logId: state.logId,
      head: state.head,
      logKind: "trajectory",
      events: [
        {
          envelopeId: ids.systemEvent(channelId, "roster", state.lastSeq),
          actor: { kind: "agent", id: this.participantId() },
          payloadKind: "system.event",
          payload: {
            protocol: "agentic.trajectory.v1",
            kind: "roster.snapshot",
            details: { kind: "roster.snapshot", roster: { participants: roster } },
          },
        },
      ],
    });
    return result.envelopes[result.envelopes.length - 1];
  }

  // ── Method calls (agent as PROVIDER) ─────────────────────────────────────

  async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    return (
      (await this.handleStandardAgentMethodCall(channelId, methodName, args)) ?? {
        result: { error: `unknown method: ${methodName}` },
        isError: true,
      }
    );
  }

  protected async handleStandardAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    switch (methodName) {
      case "pause": {
        this.driver.abortChannel(channelId);
        await this.driver.handleIncoming(channelId, {
          type: "command",
          command: { kind: "interrupt" },
        });
        return { result: { paused: true } };
      }
      case "resume": {
        await this.driver.wake(channelId);
        return { result: { resumed: true } };
      }
      case "scheduleResumeAtReset": {
        const result = await this.driver.scheduleResumeAtReset(
          channelId,
          (args ?? {}) as { messageId?: unknown; resetAt?: unknown }
        );
        return { result, isError: result.scheduled !== true };
      }
      case "connectModelCredential": {
        const input = (args ?? {}) as {
          providerId?: string;
          browserOpenMode?: string;
          modelBaseUrl?: string;
        };
        if (!input.providerId) {
          return { result: { error: "connectModelCredential requires providerId" }, isError: true };
        }
        const setup = this.getModelCredentialSetupProps(input.providerId);
        if (!setup) {
          return {
            result: { error: `no credential setup for provider ${input.providerId}` },
            isError: true,
          };
        }
        const credential = await this.rpc.call<Record<string, unknown>>(
          "main",
          "credentials.connect",
          [
            {
              ...setup,
              ...(input.browserOpenMode ? { browserOpenMode: input.browserOpenMode } : {}),
              ...(input.modelBaseUrl ? { modelBaseUrl: input.modelBaseUrl } : {}),
            },
          ]
        );
        // settle any in-flight credential wait for this provider
        await this.driver.deliverEffectOutcome(
          ids.credentialWaitEffect(ids.credKey(channelId, input.providerId)),
          { kind: "credential", resolved: true } satisfies EffectOutcome,
          { channelId }
        );
        return { result: credential };
      }
      case "credentialConnected": {
        const input = (args ?? {}) as { providerId?: string };
        const providerId = input.providerId ?? "";
        const effectId = ids.credentialWaitEffect(ids.credKey(channelId, providerId));
        await this.driver.deliverEffectOutcome(effectId, {
          kind: "credential",
          resolved: true,
        } satisfies EffectOutcome, { channelId });
        await this.driver.wake(channelId);
        return { result: { resumed: true } };
      }
      case "setModel": {
        const model = (args as { model?: unknown } | null)?.model;
        if (typeof model !== "string" || model.length === 0) {
          return {
            result: { error: "setModel requires model in provider:model format" },
            isError: true,
          };
        }
        return { result: this.updateSettings(channelId, { model }) };
      }
      case "setThinkingLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (level !== "minimal" && level !== "low" && level !== "medium" && level !== "high") {
          return {
            result: { error: "setThinkingLevel requires level: minimal, low, medium, or high" },
            isError: true,
          };
        }
        return { result: this.updateSettings(channelId, { thinkingLevel: level }) };
      }
      case "setApprovalLevel": {
        const level = (args as { level?: unknown } | null)?.level;
        if (level !== 0 && level !== 1 && level !== 2) {
          return { result: { error: "setApprovalLevel requires level: 0, 1, or 2" }, isError: true };
        }
        return { result: this.updateSettings(channelId, { approvalLevel: level }) };
      }
      case "setRespondPolicy": {
        const input = args as { policy?: unknown; from?: unknown } | null;
        if (!isRespondPolicy(input?.policy)) {
          return {
            result: {
              error:
                "setRespondPolicy requires policy: all, mentioned, mentioned-strict, mentioned-or-followup, or from-participants",
            },
            isError: true,
          };
        }
        const from = Array.isArray(input?.from)
          ? input.from.filter((id): id is string => typeof id === "string")
          : undefined;
        return {
          result: this.updateSettings(channelId, {
            respondPolicy: input.policy,
            ...(from !== undefined ? { respondFrom: from } : {}),
          }),
        };
      }
      case "setModelStreamIdleTimeoutMs": {
        const input = args as { timeoutMs?: unknown } | null;
        const timeoutMs = input?.timeoutMs;
        if (
          timeoutMs !== null &&
          (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        ) {
          return {
            result: {
              error: "setModelStreamIdleTimeoutMs requires timeoutMs as a positive number of milliseconds, or null to disable",
            },
            isError: true,
          };
        }
        return {
          result: this.updateSettings(channelId, {
            modelStreamIdleTimeoutMs: timeoutMs,
          }),
        };
      }
      case "refreshPromptArtifacts": {
        this.invalidatePromptResources(channelId);
        await this.ensurePromptArtifacts(channelId);
        return {
          result: {
            refreshed: true,
            systemPromptHash: this.getStateValue(`agent:promptHash:${channelId}`),
            toolSchemasHash: this.getStateValue(`agent:toolsHash:${channelId}`),
          },
        };
      }
      case "getAgentSettings":
        return { result: this.getAgentSettings(channelId) };
      case "getDebugState":
        return { result: await this.getDebugState(channelId) };
      case "inspectMethodSuspensions":
        return {
          result: {
            outbox: this.driver.outbox.all(),
          },
        };
      default:
        return null;
    }
  }

  /** Channel DO settle path: terminals for our channel_call effects POST back
   *  here. Duplicate delivery is a no-op (deterministic terminal ids). */
  async deliverEffectOutcome(
    effectId: string,
    outcome: EffectOutcome,
    address?: { branchId?: string; channelId?: string }
  ): Promise<void> {
    await this.driver.deliverEffectOutcome(effectId, outcome, address);
  }

  /** Inbound completion of a server-deferred RPC (CAP-5). The requestId is the
   *  branch-scoped outbox id set by the http port's callDeferred, so duplicate
   *  delivery no-ops once the row is gone. Eviction between defer and delivery
   *  is healed by lease-expiry redrive: the retried call re-attaches via its
   *  idempotencyKey / already-granted capability. */
  async onDeferredResult(payload: {
    requestId: string;
    result?: unknown;
    isError?: boolean;
  }): Promise<void> {
    await this.driver.deliverDeferredResult(
      payload.requestId,
      payload.result ?? null,
      payload.isError === true
    );
  }

  // ── Custom message recovery (CardManager read path) ─────────────────────

  /** Fold this agent's own custom messages from the channel log:
   *  Map<typeId, Map<messageId, state>> with card reducers applied. Used by
   *  card-owning agents to recover live card state after hibernation/fork. */
  protected async indexOwnCustomMessages(
    channelId: string,
    reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null
  ): Promise<Map<string, Map<string, unknown>>> {
    const selfParticipantId = this.subscriptions.getParticipantId(channelId);
    if (!selfParticipantId) return new Map();

    const byMessageId = new Map<string, { typeId: string; state: unknown }>();
    const channel = this.createChannelClient(channelId);
    let cursor = 0;
    for (;;) {
      const envelope = await channel.getReplayAfter(cursor);
      const events = envelope.logEvents;
      if (events.length === 0) break;
      let nextCursor = cursor;
      for (const event of events) {
        nextCursor = Math.max(nextCursor, event.id ?? 0);
        if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
        const agentic = event.payload as {
          kind?: string;
          actor?: { id?: string; participantId?: string };
          payload?: Record<string, unknown>;
        } | null;
        const actor = agentic?.actor;
        if (actor?.participantId !== selfParticipantId && actor?.id !== selfParticipantId) {
          continue;
        }
        const payload = agentic?.payload ?? {};
        if (agentic?.kind === "custom.started") {
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          const typeId = typeof payload["typeId"] === "string" ? payload["typeId"] : null;
          if (!messageId || !typeId) continue;
          byMessageId.set(messageId, {
            typeId,
            state: await this.hydrateTransportValue(payload["initialState"]),
          });
          continue;
        }
        if (agentic?.kind === "custom.updated") {
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          if (!messageId) continue;
          const existing = byMessageId.get(messageId);
          if (!existing) continue;
          const reducer = reducerLookup?.(existing.typeId) ?? null;
          const update = await this.hydrateTransportValue(payload["update"]);
          byMessageId.set(messageId, {
            typeId: existing.typeId,
            state: reducer ? reducer(existing.state, update) : update,
          });
        }
      }
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }

    const byType = new Map<string, Map<string, unknown>>();
    for (const [messageId, { typeId, state }] of byMessageId.entries()) {
      let messages = byType.get(typeId);
      if (!messages) {
        messages = new Map();
        byType.set(typeId, messages);
      }
      messages.set(messageId, state);
    }
    return byType;
  }

  private async hydrateTransportValue(value: unknown): Promise<unknown> {
    return hydrateStoredValueRefs(value, {
      getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    });
  }

  private modelStreamIdleTimeoutMsFrom(
    storedValue: unknown,
    configValue: unknown,
    fallback: number | null
  ): number | null {
    const stored = this.parseModelStreamIdleTimeoutMs(storedValue);
    if (stored !== undefined) return stored;
    const configured = this.parseModelStreamIdleTimeoutMs(configValue);
    if (configured !== undefined) return configured;
    return fallback;
  }

  private parseModelStreamIdleTimeoutMs(value: unknown): number | null | undefined {
    if (value === null) return null;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private maxModelCallsPerTurnFrom(
    storedValue: unknown,
    configValue: unknown,
    fallback: number | null
  ): number | null {
    const stored = this.parseMaxModelCallsPerTurn(storedValue);
    if (stored !== undefined) return stored;
    const configured = this.parseMaxModelCallsPerTurn(configValue);
    if (configured !== undefined) return configured;
    return fallback;
  }

  private parseMaxModelCallsPerTurn(value: unknown): number | null | undefined {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  // ── Subclass conveniences ────────────────────────────────────────────────

  /** Whether a channel event is a client-authored completed message. */
  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    if (event.senderId === this.participantId()) return false;
    const agentic = event.payload as { kind?: string } | null;
    return agentic?.kind === "message.completed";
  }

  /** Plain-text turn input extracted from a channel event. */
  protected buildTurnInput(event: ChannelEvent): { content: string } {
    const agentic = event.payload as { payload?: { blocks?: unknown[] } } | null;
    const blocks = agentic?.payload?.blocks ?? [];
    const content = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : ""
      )
      .filter(Boolean)
      .join("\n");
    return { content };
  }

  /** Journal an agent-initiated prompt (digest turns, onboarding nudges).
   *  `steeringId` keys the deterministic turn identity — re-submission with
   *  the same id is a replay no-op all the way down. */
  protected async submitAgentInitiatedTurn(
    channelId: string,
    input: { content: string },
    opts?: { steeringId?: string; mode?: "auto" | "sequential" }
  ): Promise<void> {
    await this.ensurePromptArtifacts(channelId);
    await this.driver.handleIncoming(channelId, {
      type: "command",
      command: {
        kind: "prompt",
        channelId,
        source: { envelopeId: opts?.steeringId ?? `agent-init:${Date.now()}` },
        content: input.content,
        senderRef: { kind: "system", id: "agent-initiated" },
      },
    });
  }

  /** Resolve the current model's API key (out-of-loop helpers like draft
   *  writers). When no credential is configured, publishes a connect-only
   *  credential card (resumeAfterConnect: false — one-shot flows have no
   *  parked turn to resume) and throws with the canonical message. */
  protected async resolveModelApiKey(
    channelId: string,
    opts?: { connectCard?: boolean }
  ): Promise<string> {
    const model = this.getAgentSettings(channelId).model;
    const providerId = model.includes(":") ? model.slice(0, model.indexOf(":")) : "anthropic";
    const modelId = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
    try {
      const { getModel } = await import("@earendil-works/pi-ai");
      const registryModel = getModel(providerId as never, modelId as never) as
        | { baseUrl?: string }
        | undefined;
      const modelBaseUrl =
        typeof registryModel?.baseUrl === "string" ? registryModel.baseUrl : undefined;
      const resolved = await this.executorDeps().credentials.getApiKey({
        providerId,
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
      });
      return resolved.apiKey;
    } catch (err) {
      if (err instanceof CredentialPendingError && opts?.connectCard !== false) {
        await this.publishCredentialConnectCard(channelId, providerId, {
          resumeAfterConnect: false,
        });
      }
      throw new Error(
        `No URL-bound model credential is configured for model provider: ${providerId}`
      );
    }
  }

  /** The credential-connect inline card (same renderer the chat panel ships). */
  protected async publishCredentialConnectCard(
    channelId: string,
    providerId: string,
    opts: { resumeAfterConnect: boolean; reason?: string }
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId) ?? this.participantId();
    const cardId = `model-credential-${providerId}:${channelId}`;
    const event: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: { kind: "agent", id: participantId, displayName: participantId },
      payload: {
        protocol: "agentic.trajectory.v1",
        uiType: "inline",
        id: cardId,
        source: {
          type: "file",
          path: "workspace/packages/agentic-chat/components/ModelCredentialRequiredCard.tsx",
        },
        props: {
          providerId,
          modelRef: this.getAgentSettings(channelId).model,
          agentParticipantId: participantId,
          resumeAfterConnect: opts.resumeAfterConnect,
          ...(opts.reason ? { reason: opts.reason } : {}),
          ...(this.getModelCredentialSetupProps(providerId) ?? {}),
        },
      },
      createdAt: new Date().toISOString(),
    };
    await this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: cardId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(`[AgentVessel] credential card emit failed for ${providerId}:`, err);
      });
  }

  // ── Fork ─────────────────────────────────────────────────────────────────

  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
    const count = this.subscriptions.count();
    return count <= 1
      ? { ok: true, subscriptionCount: count }
      : { ok: false, subscriptionCount: count, reason: "multiple subscriptions" };
  }

  async postClone(
    _parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkPointPubsubId: number
  ): Promise<void> {
    // fix identity (cloneDO copied the parent's)
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    const from = ids.logIdForChannel(oldChannelId);
    const to = ids.logIdForChannel(newChannelId);
    const atSeq = await this.resolveTrajectorySeqForChannelSeq(from, oldChannelId, forkPointPubsubId);
    await this.callGad("forkLog", {
      fromLogId: from,
      fromHead: from,
      toLogId: to,
      toHead: to,
      atSeq,
    });
    const driver = this.driver;
    // caches: wiped, reconverge (P3)
    this.sql.exec(`DELETE FROM effect_outbox`);
    this.sql.exec(`DELETE FROM fold_cache`);
    this.subscriptions.rename(oldChannelId, newChannelId);
    // Subclass fork cleanup/setup runs with the rename applied but BEFORE the
    // new channel is (re)subscribed, so subclasses can purge per-channel state
    // the clone copied and influence the upcoming subscribe.
    await this.onChannelForked({ oldChannelId, newChannelId, forkPointPubsubId });
    await this.subscribeChannel({
      channelId: newChannelId,
      contextId: this.subscriptions.getContextId(newChannelId),
      config: this.subscriptions.getConfig(newChannelId) ?? undefined,
      replay: false,
    });
    await driver.wake(newChannelId); // fork policy settles pre-cut pendings
  }

  private async resolveTrajectorySeqForChannelSeq(
    trajectoryLogId: string,
    channelId: string,
    channelSeq: number
  ): Promise<number> {
    const fork = await this.callGad<{ rows: Array<Record<string, unknown>> }>(
      "rawSql",
      `SELECT MAX(o.seq) AS seq
       FROM log_events ch
       JOIN log_events o
         ON o.log_id = ch.origin_log_id
        AND o.head = ch.origin_head
        AND o.envelope_id = ch.origin_envelope_id
       WHERE ch.log_id = ?
         AND ch.seq <= ?
         AND ch.origin_log_id = ?
         AND ch.origin_head = ?`,
      [channelId, channelSeq, trajectoryLogId, trajectoryLogId]
    );
    const seq = fork?.rows?.[0]?.["seq"];
    if (seq == null) return 0;
    const parsed = Number(seq);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid trajectory fork sequence for ${trajectoryLogId}: ${String(seq)}`);
    }
    return parsed;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  override async alarm(): Promise<void> {
    await super.alarm();
    await this.driver.alarm();
  }

  async getDebugState(channelId?: string): Promise<Record<string, unknown>> {
    const channels = channelId
      ? [channelId]
      : this.subscriptions.listChannelIds();
    const loops: Record<string, unknown> = {};
    for (const id of channels) {
      try {
        const loop = await this.driver.loop(id);
        loops[id] = {
          turnStatus: derivedTurnStatus(loop.state),
          lastSeq: loop.state.lastSeq,
          pendingInvocations: Object.keys(loop.state.pendingInvocations),
          pendingApprovals: Object.keys(loop.state.pendingApprovals),
          pendingCredentialWaits: Object.keys(loop.state.pendingCredentialWaits),
          settings: this.getAgentSettings(id),
        };
      } catch (err) {
        loops[id] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { participantId: this.participantId(), loops, outbox: this.driver.outbox.all() };
  }
}
