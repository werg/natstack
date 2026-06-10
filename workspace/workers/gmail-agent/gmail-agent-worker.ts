import { AgentWorkerBase, lintRendererSource, type RespondPolicy } from "@workspace/agentic-do";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import {
  AGENTIC_PROTOCOL_VERSION,
  type ActorRef,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { createGmailClient, type GmailClient, type GmailThread } from "@workspace/gmail";
import type {
  GmailAttentionDecision,
  GmailAttentionDirective,
  GmailAttentionRuleSet,
  GmailInboxCardState,
  GmailSetupState,
  GmailThreadCardState,
} from "@workspace/gmail/card-types";
import {
  reduce as reduceGmailThread,
  type GmailThreadState,
} from "@workspace/gmail/renderers/gmail-thread.reducer";
import type { PiRunnerOptions } from "@workspace/harness";
import type { ParticipantDescriptor } from "@workspace/harness";

import { createGmailTables, dropGmailTables } from "./schema.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  numberArg,
  record,
  stringArg,
  type GmailChannelState,
} from "./types.js";
import { AttentionEngine } from "./attention/attention-engine.js";
import type { GmailAttentionEvent } from "./attention/rules.js";
import { WAKE_DEBOUNCE_MS, WakeQueue, buildWakeDigestPrompt } from "./attention/wake.js";
import { SyncEngine } from "./sync/sync-engine.js";
import {
  GmailCards,
  GMAIL_MESSAGE_TYPES,
  INBOX_CARD_KEY,
  SETUP_CARD_KEY,
  threadCardKey,
} from "./cards/cards.js";
import { GmailHandlers, type GmailAttentionRulesSnapshot } from "./agent/handlers.js";
import { GmailParticipantApi } from "./participant-api.js";
import { GMAIL_TOOLS } from "./agent/tools.js";
import { GMAIL_SETUP_ONBOARDING_PROMPT, GMAIL_SYSTEM_PROMPT } from "./agent/prompts.js";
import { generateDraftReplyBody as generateDraftReplyBodyLlm } from "./agent/draft-writer.js";

const GMAIL_ACTION_BAR_FILE = "skills/gmail/action-bar.tsx";
const GMAIL_ACTION_BAR_MAX_HEIGHT = 180;
const GMAIL_UI_INSTALL_VERSION = 4;
const GMAIL_UI_IMPORTS = {
  react: "latest",
  "react/jsx-runtime": "latest",
  "@radix-ui/themes": "npm:^3.2.1",
  "@radix-ui/react-icons": "npm:^1.3.2",
} satisfies Record<string, string>;

type GmailTool = NonNullable<PiRunnerOptions["extraTools"]>[number];

export class GmailAgentWorker extends AgentWorkerBase {
  // Gmail tables are versioned by drop-and-recreate (see schema.ts); bump
  // past the base version so existing dev objects re-run migrate().
  static override schemaVersion = AgentWorkerBase.schemaVersion + 2;

  private gmailClients = new Map<string, GmailClient>();
  private recoveredChannels = new Set<string>();

  private readonly attention: AttentionEngine;
  private readonly wake: WakeQueue;
  private readonly gmailCards: GmailCards;
  private readonly syncEngine: SyncEngine;
  private readonly handlers: GmailHandlers;
  private readonly participantApi: GmailParticipantApi;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("Gmail");
    this.attention = new AttentionEngine({ sql: this.sql });
    this.wake = new WakeQueue({ sql: this.sql });
    this.gmailCards = new GmailCards({ cards: this.cards, sql: this.sql });
    this.syncEngine = new SyncEngine({
      sql: this.sql,
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      attention: this.attention,
      cards: this.gmailCards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishOverview: (channelId, email) => this.publishOverview(channelId, email),
      startAttentionTurn: (channelId, event, decision) =>
        this.enqueueAttentionWake(channelId, event, decision),
      schedulePoll: (ms) => this.setAlarm(ms),
    });
    this.handlers = new GmailHandlers({
      sql: this.sql,
      gmailFor: (channelId) => this.gmailForChannel(channelId),
      sync: this.syncEngine,
      attention: this.attention,
      cards: this.gmailCards,
      getChannelState: (channelId) => this.getChannelState(channelId),
      saveChannelState: (state) => this.saveChannelState(state),
      publishOverview: (channelId, email) => this.publishOverview(channelId, email),
      publishSetup: (channelId) => this.publishSetupCard(channelId),
      setPollAlarm: (ms) => this.setAlarm(ms),
      generateDraftReplyBody: (channelId, thread) => this.generateDraftReplyBody(channelId, thread),
      isSubscribed: (channelId) => Boolean(this.subscriptions.getParticipantId(channelId)),
    });
    this.participantApi = new GmailParticipantApi({
      sql: this.sql,
      handlers: this.handlers,
      sync: this.syncEngine,
      getChannelState: (channelId) => this.getChannelState(channelId),
    });
  }

  protected override createTables(): void {
    super.createTables();
    createGmailTables(this.sql);
  }

  protected override migrate(fromVersion: number, toVersion: number): void {
    super.migrate(fromVersion, toVersion);
    if (fromVersion > 0 && fromVersion < (this.constructor as typeof GmailAgentWorker).schemaVersion) {
      dropGmailTables(this.sql);
      createGmailTables(this.sql);
    }
  }

  // ── Gmail client & channel state ──────────────────────────────────────────

  protected gmailForChannel(channelId: string): GmailClient {
    const credentialId = this.getGmailCredentialId(channelId);
    const key = credentialId ?? "__default__";
    let client = this.gmailClients.get(key);
    if (!client) {
      client = this.createGmailClient(credentialId);
      this.gmailClients.set(key, client);
    }
    return client;
  }

  protected createGmailClient(credentialId?: string): GmailClient {
    return createGmailClient(this.credentials, credentialId ? { credentialId } : {});
  }

  private getGmailCredentialId(channelId: string): string | undefined {
    const state = this.getChannelState(channelId);
    if (state.credentialId) return state.credentialId;
    const config = record(this.subscriptions.getConfig(channelId));
    return stringArg(config, "googleCredentialId") ?? stringArg(config, "credentialId") ?? undefined;
  }

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO gmail_channel_state (channel_id, poll_interval_ms) VALUES (?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS
    );
  }

  private getChannelState(channelId: string): GmailChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM gmail_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      historyId: (row["history_id"] as string | null) ?? undefined,
      emailAddress: (row["email_address"] as string | null) ?? undefined,
      credentialId: (row["credential_id"] as string | null) ?? undefined,
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      lastSyncAt: (row["last_sync_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      lastOverviewJson: (row["last_overview_json"] as string | null) ?? undefined,
      lastSearchQuery: (row["last_search_query"] as string | null) ?? undefined,
      lastSearchJson: (row["last_search_json"] as string | null) ?? undefined,
      setupStatus: row["setup_status"] === "configured" ? "configured" : "needs-user-preferences",
      setupPromptedAt: (row["setup_prompted_at"] as number | null) ?? undefined,
      configuredAt: (row["configured_at"] as number | null) ?? undefined,
      setupSummary: (row["setup_summary"] as string | null) ?? undefined,
      syncState: row["sync_state"] === "auth-needed" ? "auth-needed" : "ok",
      rateLimitedUntil: (row["rate_limited_until"] as number | null) ?? undefined,
      backoffMs: (row["backoff_ms"] as number | null) ?? undefined,
      lastSetupJson: (row["last_setup_json"] as string | null) ?? undefined,
    };
  }

  private saveChannelState(state: GmailChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO gmail_channel_state
       (channel_id, history_id, email_address, credential_id, poll_interval_ms, last_sync_at, last_error, last_overview_json, last_search_query, last_search_json, setup_status, setup_prompted_at, configured_at, setup_summary, sync_state, rate_limited_until, backoff_ms, last_setup_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.historyId ?? null,
      state.emailAddress ?? null,
      state.credentialId ?? null,
      state.pollIntervalMs,
      state.lastSyncAt ?? null,
      state.lastError ?? null,
      state.lastOverviewJson ?? null,
      state.lastSearchQuery ?? null,
      state.lastSearchJson ?? null,
      state.setupStatus,
      state.setupPromptedAt ?? null,
      state.configuredAt ?? null,
      state.setupSummary ?? null,
      state.syncState,
      state.rateLimitedUntil ?? null,
      state.backoffMs ?? null,
      state.lastSetupJson ?? null
    );
  }

  // ── agent configuration ───────────────────────────────────────────────────

  protected override getDefaultModel(): string {
    return "openai-codex:gpt-5.5";
  }

  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned-or-followup";
  }

  protected override getRunnerPromptConfig(_channelId: string): {
    systemPrompt?: string;
    systemPromptMode?: "replace";
  } {
    return { systemPromptMode: "replace", systemPrompt: GMAIL_SYSTEM_PROMPT };
  }

  protected async generateDraftReplyBody(channelId: string, thread: GmailThread): Promise<string> {
    return generateDraftReplyBodyLlm({
      modelRef: this.getModel(channelId),
      apiKey: await this.getApiKeyForChannel(channelId, {
        resumeCurrentTurnOnMissingCredential: false,
      })(),
      thread,
    });
  }

  protected override getRunnerTools(channelId: string): PiRunnerOptions["extraTools"] {
    return GMAIL_TOOLS.map(
      (spec) =>
        ({
          name: spec.name,
          label: spec.name,
          description: spec.description,
          parameters: spec.schema,
          execute: async (_toolCallId: string, params: unknown) => {
            const details = await spec.run(this.handlers, channelId, record(params));
            return {
              content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
              details,
            };
          },
        }) as GmailTool
    );
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "gmail",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "Gmail",
      type: "agent",
      metadata: { provider: "gmail" },
      methods: [
        { name: "checkNow", description: "Synchronize Gmail now" },
        { name: "markConfigured", description: "Mark first-run Gmail setup complete" },
        { name: "categorize", description: "Set a local category for a Gmail thread" },
        { name: "draftReply", description: "Create a reply compose card for a Gmail thread" },
        { name: "send", description: "Send a Gmail message or compose card" },
        { name: "saveDraft", description: "Save a Gmail draft from a compose card" },
        { name: "discardCompose", description: "Mark a Gmail compose card discarded" },
        { name: "archiveThread", description: "Archive a Gmail thread" },
        { name: "markRead", description: "Mark a Gmail thread read" },
        { name: "compose", description: "Create a Gmail compose card" },
        { name: "search", description: "Search Gmail and publish a result card" },
        { name: "clearSearch", description: "Clear Gmail search results from the inbox card" },
        { name: "listActionableThreads", description: "Return current actionable Gmail threads" },
        { name: "setPollInterval", description: "Configure Gmail polling interval" },
        { name: "getThread", description: "Fetch sanitized Gmail thread contents" },
        { name: "openThread", description: "Publish or focus a Gmail thread card" },
        { name: "reconnect", description: "Re-verify the Google credential and report auth status" },
        {
          name: "setAttentionRuleEnabled",
          description: "Enable or disable one Gmail attention rule",
        },
        { name: "gmail_query", description: "Agent API: search threads (cache-first). Returns { source, query, count, results: [{ threadId, subject, from, snippet, unread, date }] }." },
        { name: "gmail_getThread", description: "Agent API: fetch sanitized thread contents" },
        { name: "gmail_getOverview", description: "Agent API: dashboard snapshot of mail state" },
        {
          name: "gmail_requestDraft",
          description: "Agent API: prepare a compose card in review state (never sends)",
        },
        ...this.getStandardAgentMethods(),
      ],
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  override async subscribeChannel(
    opts: Parameters<AgentWorkerBase["subscribeChannel"]>[0]
  ): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    const credentialId =
      stringArg(record(opts.config), "googleCredentialId") ??
      stringArg(record(opts.config), "credentialId");
    if (credentialId) {
      const state = this.getChannelState(opts.channelId);
      state.credentialId = credentialId;
      this.saveChannelState(state);
    }
    await this.installChannelUi(opts.channelId);
    await this.publishSetupCard(opts.channelId);
    this.setAlarm(this.getChannelState(opts.channelId).pollIntervalMs);
    await this.startSetupTurnIfNeeded(opts.channelId);
    return result;
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT channel_id, sync_state, rate_limited_until FROM gmail_channel_state`
      )
      .toArray();
    for (const row of rows) {
      const channelId = String(row["channel_id"]);
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      if (rateLimitedUntil > now) continue;
      await this.ensureRecovered(channelId);
      await this.syncEngine.syncChannel(channelId).catch((err) => {
        console.error(`[GmailAgentWorker] sync failed for channel=${channelId}:`, err);
      });
    }
    const wakeDelay = await this.processWakeQueues(now);
    // Recompute the next wake from fresh state: auth-needed channels do not
    // reschedule; rate-limited channels wake at their backoff deadline; wake
    // digest deadlines compete for the earliest alarm.
    const fresh = this.sql
      .exec(
        `SELECT poll_interval_ms, sync_state, rate_limited_until FROM gmail_channel_state`
      )
      .toArray();
    let nextDelay = wakeDelay;
    for (const row of fresh) {
      if (String(row["sync_state"] ?? "ok") === "auth-needed") continue;
      const rateLimitedUntil = Number(row["rate_limited_until"] ?? 0);
      const interval =
        rateLimitedUntil > now
          ? Math.max(rateLimitedUntil - now, 1000)
          : Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS;
      nextDelay = nextDelay === undefined ? interval : Math.min(nextDelay, interval);
    }
    if (nextDelay) this.setAlarm(nextDelay);
  }

  /**
   * Drain due attention wake windows into a single digest turn per channel.
   * Returns the delay (ms) until the next pending wake deadline, if any.
   */
  protected async processWakeQueues(now: number): Promise<number | undefined> {
    let nextDelay: number | undefined;
    const minDelay = (deadline: number) => {
      const delay = Math.max(deadline - now, 1000);
      nextDelay = nextDelay === undefined ? delay : Math.min(nextDelay, delay);
    };
    const channels = this.sql
      .exec(`SELECT DISTINCT channel_id FROM gmail_attention_queue`)
      .toArray()
      .map((row) => String(row["channel_id"]));
    for (const channelId of channels) {
      const decision = this.wake.decision(channelId, now);
      if (decision.kind === "wait") {
        minDelay(decision.deadline);
      } else if (decision.kind === "capped") {
        // Rate-capped: skip the turn, surface the backlog on the inbox card,
        // retry once the oldest counted wake turn ages out of the window.
        minDelay(decision.retryAt);
        await this.publishOverview(channelId).catch(() => undefined);
      } else if (decision.kind === "turn") {
        const hits = this.wake.drain(channelId, now);
        if (hits.length === 0) continue;
        await this.submitAgentInitiatedTurn(
          channelId,
          { content: buildWakeDigestPrompt(hits) },
          { mode: "sequential", steeringId: `gmail-attention-digest:${channelId}:${now}` }
        );
        await this.publishOverview(channelId).catch(() => undefined);
      }
    }
    return nextDelay;
  }

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      const standardResult = await this.handleStandardAgentMethodCall(channelId, methodName, args);
      if (standardResult) return standardResult;

      const wrap = (result: unknown): { result: unknown; isError?: boolean } =>
        result && typeof result === "object" && "error" in (result as Record<string, unknown>)
          ? { result, isError: true }
          : { result };

      switch (methodName) {
        case "checkNow":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.checkInbox(channelId));
        case "markConfigured":
          return { result: await this.handlers.markConfigured(channelId, record(args)) };
        case "categorize":
          await this.ensureRecovered(channelId);
          return { result: await this.handlers.categorize(channelId, record(args)) };
        case "draftReply":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.draftReply(channelId, record(args)));
        case "send":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.send(channelId, record(args)));
        case "saveDraft":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.saveDraft(channelId, record(args)));
        case "discardCompose":
          return { result: await this.handlers.discardCompose(channelId, record(args)) };
        case "archiveThread":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.archiveThread(channelId, record(args)));
        case "markRead":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.markRead(channelId, record(args)));
        case "compose":
          return { result: await this.handlers.compose(channelId, record(args)) };
        case "search":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.search(channelId, record(args)));
        case "clearSearch":
          return { result: await this.handlers.clearSearch(channelId) };
        case "listActionableThreads":
          await this.ensureRecovered(channelId);
          return {
            result: this.handlers.listActionableThreads(
              channelId,
              numberArg(record(args), "limit") ?? 6
            ),
          };
        case "setPollInterval":
          return { result: this.handlers.setPollInterval(channelId, record(args)) };
        case "getThread":
          return wrap(await this.handlers.getThread(channelId, record(args)));
        case "openThread":
          await this.ensureRecovered(channelId);
          return wrap(await this.handlers.openThread(channelId, record(args)));
        case "reconnect":
          await this.ensureRecovered(channelId);
          return { result: await this.handlers.reconnect(channelId) };
        case "setAttentionRuleEnabled":
          return { result: await this.handlers.setAttentionRuleEnabled(channelId, args) };
        case "gmail_query":
          await this.ensureRecovered(channelId);
          return wrap(await this.participantApi.query(channelId, record(args)));
        case "gmail_getThread":
          return wrap(await this.participantApi.getThread(channelId, record(args)));
        case "gmail_getOverview":
          await this.ensureRecovered(channelId);
          return {
            result: this.participantApi.getOverview(channelId, this.wake.queuedCount(channelId)),
          };
        case "gmail_requestDraft":
          await this.ensureRecovered(channelId);
          return wrap(await this.participantApi.requestDraft(channelId, record(args)));
        default:
          return { result: { error: `unknown method: ${methodName}` }, isError: true };
      }
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  // ── attention rule RPC (public Durable Object methods) ────────────────────

  private assertSubscribedChannel(channelId: string): void {
    if (!channelId || !this.subscriptions.getParticipantId(channelId)) {
      throw new Error(`Gmail agent is not subscribed to channel: ${channelId}`);
    }
  }

  private assertAttentionRuleWriteAllowed(): void {
    const caller = this.caller;
    if (!caller) return;
    if (["panel", "shell", "server", "harness"].includes(caller.callerKind)) return;
    throw new Error("Gmail attention rule changes must be initiated from a user-facing panel");
  }

  async listAttentionRules(channelId: string): Promise<GmailAttentionRulesSnapshot> {
    this.assertSubscribedChannel(channelId);
    return this.handlers.listAttentionRules(channelId);
  }

  async upsertAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    return this.handlers.upsertAttentionRule(channelId, args);
  }

  async setAttentionRuleEnabled(
    channelId: string,
    args: unknown
  ): Promise<{ saved: true; rule: GmailAttentionDirective; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    return this.handlers.setAttentionRuleEnabled(channelId, args);
  }

  async deleteAttentionRule(
    channelId: string,
    args: unknown
  ): Promise<{ deleted: true; id: string; ruleSet: GmailAttentionRuleSet }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    return this.handlers.deleteAttentionRule(channelId, args);
  }

  async clearAttentionRules(channelId: string): Promise<{
    cleared: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    return this.handlers.clearAttentionRules(channelId);
  }

  async resetAttentionRules(channelId: string): Promise<{
    reset: true;
    ruleSet: GmailAttentionRuleSet;
    rules: GmailAttentionDirective[];
  }> {
    this.assertSubscribedChannel(channelId);
    this.assertAttentionRuleWriteAllowed();
    return this.handlers.resetAttentionRules(channelId);
  }

  // ── channel UI install & onboarding ───────────────────────────────────────

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`Gmail agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "Gmail",
      metadata: { type: "agent", handle: "gmail", name: "Gmail" },
    };
  }

  private async installChannelUi(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const actor = this.localActor(channelId);
    await this.lintRendererSources();
    for (const spec of GMAIL_MESSAGE_TYPES) {
      const event: AgenticEvent<"messageType.registered"> = {
        kind: "messageType.registered",
        actor,
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          source: { type: "file", path: spec.path },
          imports: GMAIL_UI_IMPORTS,
          stateSchema: spec.stateSchema,
          ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
          registeredBy: actor,
        },
        createdAt: new Date().toISOString(),
      };
      await channel.publishAgenticEvent(actor.id, event, {
        idempotencyKey: `gmail:ui:v${GMAIL_UI_INSTALL_VERSION}:message-type:${spec.typeId}`,
        senderMetadata: actor.metadata,
      });
      this.cards.invalidateType(channelId, spec.typeId);
    }

    const actionBarEvent: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "gmail-action-bar",
        source: { type: "file", path: GMAIL_ACTION_BAR_FILE },
        imports: GMAIL_UI_IMPORTS,
        maxHeight: GMAIL_ACTION_BAR_MAX_HEIGHT,
        result: { ok: true },
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, actionBarEvent, {
      idempotencyKey: `gmail:ui:v${GMAIL_UI_INSTALL_VERSION}:action-bar`,
      senderMetadata: actor.metadata,
    });
  }

  /**
   * Fail registration loudly when a renderer has a value import the panel
   * cannot satisfy self-contained — at render time that becomes a slow (or
   * misresolved) build-service call and a stuck card with no attribution.
   */
  private async lintRendererSources(): Promise<void> {
    const sources = [
      ...GMAIL_MESSAGE_TYPES.map((spec) => spec.path),
      GMAIL_ACTION_BAR_FILE,
    ];
    const failures: string[] = [];
    for (const path of sources) {
      let code: string | null = null;
      try {
        const raw = await this.fs.readFile(path, "utf8");
        code =
          typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : null;
      } catch {
        /* fall through */
      }
      if (code === null) {
        // Can't lint what we can't read — a transient fs problem must not
        // block UI install (the panel reads the file itself at compile time).
        console.warn(`[GmailAgentWorker] renderer lint skipped (unreadable): ${path}`);
        continue;
      }
      for (const issue of lintRendererSource(code, { imports: GMAIL_UI_IMPORTS })) {
        failures.push(`${path}: ${issue.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Gmail renderer registration blocked:\n${failures.join("\n")}`);
    }
  }

  private async startSetupTurnIfNeeded(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured" || state.setupPromptedAt) return;
    await this.submitAgentInitiatedTurn(channelId, { content: GMAIL_SETUP_ONBOARDING_PROMPT }, {
      mode: "sequential",
      steeringId: `gmail-setup:${channelId}`,
    });
    state.setupPromptedAt = Date.now();
    this.saveChannelState(state);
  }

  /**
   * Attention hits are batched: enqueue and let the debounced wake window
   * drain everything into one digest turn (see processWakeQueues).
   */
  private enqueueAttentionWake(
    channelId: string,
    event: GmailAttentionEvent,
    decision: GmailAttentionDecision
  ): Promise<void> {
    this.wake.enqueue(channelId, event, decision);
    this.setAlarm(WAKE_DEBOUNCE_MS);
    return Promise.resolve();
  }

  // ── inbox card publishing ─────────────────────────────────────────────────

  private async publishOverview(channelId: string, email?: string): Promise<void> {
    const state = this.getChannelState(channelId);
    const attentionRecord = this.attention.getRulesRecord(channelId);
    const actionable = this.syncEngine.listActionableThreads(channelId, 8);
    const rows =
      this.sql
        .exec(
          `SELECT
        SUM(CASE WHEN unread = 1 THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN in_inbox = 1 THEN 1 ELSE 0 END) AS inbox
       FROM gmail_threads WHERE channel_id = ?`,
          channelId
        )
        .toArray()[0] ?? {};
    const searchResults = this.parseStoredThreadCards(state.lastSearchJson);
    const now = Date.now();
    const payload: GmailInboxCardState = {
      email: email ?? state.emailAddress,
      unread: Number(rows["unread"] ?? 0),
      inbox: Number(rows["inbox"] ?? 0),
      urgent: actionable.filter((thread) => thread.category === "urgent").length,
      draftCount: 0,
      perCategory: this.categoryCounts(channelId),
      actionable,
      attentionRules: attentionRecord.ruleSet,
      attentionHits: this.attention.hits(channelId, 8),
      ...(this.wake.queuedCount(channelId) > 0
        ? { needsAttentionCount: this.wake.queuedCount(channelId) }
        : {}),
      ...(state.lastSearchQuery ? { searchQuery: state.lastSearchQuery } : {}),
      ...(searchResults.length > 0 ? { searchResults } : {}),
      lastSyncedAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : undefined,
      lastError: state.lastError,
      ...(state.syncState === "auth-needed" ? { auth: { status: "reconnect-required" } } : {}),
      ...(state.rateLimitedUntil && state.rateLimitedUntil > now
        ? { rateLimitedUntil: state.rateLimitedUntil }
        : {}),
    };
    const overviewJson = JSON.stringify(payload);
    if (!this.gmailCards.hasInboxCard(channelId) || state.lastOverviewJson !== overviewJson) {
      await this.gmailCards.publishInbox(channelId, payload);
      state.lastOverviewJson = overviewJson;
      this.saveChannelState(state);
    }
    await this.publishSetupCard(channelId);
  }

  /** Publish/refresh the gmail.setup card; deduped via last_setup_json. */
  private async publishSetupCard(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    const ruleSet = this.attention.getRulesRecord(channelId).ruleSet;
    const payload: GmailSetupState = {
      status: state.setupStatus === "configured" ? "configured" : "onboarding",
      auth: {
        status:
          state.syncState === "auth-needed"
            ? "reconnect-required"
            : state.lastSyncAt
              ? "ok"
              : "unknown",
      },
      ...(state.emailAddress ? { email: state.emailAddress } : {}),
      ...(state.setupSummary ? { setupSummary: state.setupSummary } : {}),
      attentionRules: ruleSet.directives.map((directive) => ({
        id: directive.id,
        name: directive.name,
        enabled: directive.enabled,
        priority: directive.priority,
      })),
      pollIntervalMs: state.pollIntervalMs,
      ...(state.lastSyncAt ? { lastSyncAt: new Date(state.lastSyncAt).toISOString() } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
    const setupJson = JSON.stringify(payload);
    if (state.lastSetupJson === setupJson) return;
    await this.gmailCards.publishSetup(channelId, payload);
    const fresh = this.getChannelState(channelId);
    fresh.lastSetupJson = setupJson;
    this.saveChannelState(fresh);
  }

  private parseStoredThreadCards(value: string | undefined): GmailThreadCardState[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter(
            (item): item is GmailThreadCardState =>
              Boolean(item && typeof item === "object" && typeof record(item)["threadId"] === "string")
          )
        : [];
    } catch {
      return [];
    }
  }

  private categoryCounts(channelId: string): Record<string, number> {
    const rows = this.sql
      .exec(
        `SELECT category, COUNT(*) AS count
       FROM gmail_threads
       WHERE channel_id = ? AND category IS NOT NULL
       GROUP BY category`,
        channelId
      )
      .toArray();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const category = row["category"];
      if (typeof category === "string" && category) counts[category] = Number(row["count"] ?? 0);
    }
    return counts;
  }

  // ── replay recovery ───────────────────────────────────────────────────────

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);

    const folded = await this.indexOwnCustomMessages(channelId, (typeId) => {
      if (typeId === "gmail.thread") {
        return (state, update) => reduceGmailThread(state as GmailThreadState, update as never);
      }
      return undefined;
    });

    const inbox = folded.get("gmail.inbox");
    if (inbox && inbox.size > 0) {
      const messageId = [...inbox.keys()][0]!;
      this.gmailCards.adoptRecoveredCard(channelId, INBOX_CARD_KEY, "gmail.inbox", messageId);
    }

    const setup = folded.get("gmail.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      this.gmailCards.adoptRecoveredCard(channelId, SETUP_CARD_KEY, "gmail.setup", messageId);
    }

    for (const [messageId, value] of folded.get("gmail.thread") ?? []) {
      const thread = record(value);
      const threadId = typeof thread["threadId"] === "string" ? thread["threadId"] : undefined;
      if (!threadId) continue;
      this.gmailCards.adoptRecoveredCard(channelId, threadCardKey(threadId), "gmail.thread", messageId);
      const subject = typeof thread["subject"] === "string" ? thread["subject"] : "(no subject)";
      const from =
        Array.isArray(thread["participants"]) && typeof thread["participants"][0] === "string"
          ? thread["participants"][0]
          : "";
      const snippet =
        typeof thread["lastSnippet"] === "string"
          ? thread["lastSnippet"]
          : typeof thread["snippet"] === "string"
            ? thread["snippet"]
            : "";
      const unreadCount = typeof thread["unreadCount"] === "number" ? thread["unreadCount"] : 0;
      const status = typeof thread["status"] === "string" ? thread["status"] : "unread";
      const category = typeof thread["category"] === "string" ? thread["category"] : null;
      const actionable =
        Boolean(thread["actionable"]) ||
        (unreadCount > 0 &&
          status !== "archived" &&
          !["Promotions", "Social", "Updates", "Forums"].includes(category ?? ""));
      this.sql.exec(
        `INSERT OR REPLACE INTO gmail_threads
         (channel_id, thread_id, subject, from_addr, snippet, unread, in_inbox, actionable, category, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        channelId,
        threadId,
        subject,
        from,
        snippet,
        unreadCount > 0 ? 1 : 0,
        status === "archived" ? 0 : 1,
        actionable ? 1 : 0,
        category,
        Date.now()
      );
    }
  }
}
