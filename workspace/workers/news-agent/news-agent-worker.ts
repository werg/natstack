import {
  AgentWorkerBase,
  RecurringScheduler,
  installMessageTypes,
  type RespondPolicy,
} from "@workspace/agentic-do";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import type { ActorRef } from "@workspace/agentic-protocol";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import {
  articleId as canonicalArticleId,
  parseFeed,
  fetchFeed,
  type Fetcher,
} from "@workspace/feeds";
import {
  NEWS_DEEPDIVE_SIGNAL,
  type NewsBriefingCardState,
  type NewsDeepDiveRequested,
  type NewsSetupCardState,
  type NewsStoryRef,
} from "@workspace/feeds/card-types";

import { createNewsTables, dropNewsTables } from "./schema.js";
import {
  BRIEFING_WATCHDOG_MS,
  DEFAULT_BRIEFING_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TOP_K,
  booleanArg,
  numberArg,
  record,
  stringArg,
  type NewsChannelState,
} from "./types.js";
import { NewsSyncEngine } from "./sync-engine.js";
import {
  NEWS_MESSAGE_TYPES,
  NEWS_UI_IMPORTS,
  NEWS_UI_INSTALL_VERSION,
  NewsCards,
  SETUP_CARD_KEY,
  briefingCardKey,
} from "./cards.js";
import {
  NEWS_OPERATIONS,
  advertisedMethods,
  buildOperationIndex,
  toolOperations,
  type NewsHandlers,
  type NewsOperation,
  type NewsOperationContext,
} from "./operations.js";
import {
  NEWS_SETUP_ONBOARDING_PROMPT,
  NEWS_SYSTEM_PROMPT,
  buildBriefingPrompt,
} from "./prompts.js";

type NewsTool = AgentTool;

const DAY_MS = 24 * 3_600_000;
const NEWS_BASE_LOOP_TOOL_NAMES = new Set([
  "close_turn_without_response",
  "ask_user",
  "web_search",
  "web_fetch",
  "web_read",
]);
const MAX_SEARCH_STORIES_PER_BRIEFING = 10;

/** Next run for the briefing job: anchored to local HH:MM when set. */
function nextBriefingRunAt(now: number, intervalMs: number, atMinutes?: number): number {
  if (atMinutes === undefined || intervalMs % DAY_MS !== 0) return now + intervalMs;
  const anchor = new Date(now);
  anchor.setHours(Math.floor(atMinutes / 60), atMinutes % 60, 0, 0);
  let next = anchor.getTime();
  while (next <= now) next += DAY_MS;
  return next;
}

export class NewsAgentWorker extends AgentWorkerBase implements NewsHandlers {
  // News tables are versioned by drop-and-recreate (dev mode: articles
  // re-ingest from feeds; configuration is cheap to redo).
  static override schemaVersion = AgentWorkerBase.schemaVersion + 1;

  private readonly syncEngine: NewsSyncEngine;
  private readonly scheduler: RecurringScheduler;
  private readonly newsCards: NewsCards;
  private readonly operationIndex: Map<string, NewsOperation>;
  private readonly operationContext: NewsOperationContext;
  private recoveredChannels = new Set<string>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    void this.setOwnTitle("News");
    this.syncEngine = new NewsSyncEngine({
      sql: this.sql,
      now: () => this.now(),
      fetcher: this.feedFetcher(),
      sleep: (ms) => this.politenessSleep(ms),
    });
    this.scheduler = new RecurringScheduler({
      sql: this.sql,
      setAlarmAt: (timeMs) => this.setAlarmAt(timeMs),
    });
    this.newsCards = new NewsCards(this.cards);
    this.operationIndex = buildOperationIndex();
    this.operationContext = { handlers: this };
  }

  /** Injectable clock for tests. */
  protected now(): number {
    return Date.now();
  }

  /** Injectable feed transport for tests; undefined = global fetch. */
  protected feedFetcher(): Fetcher | undefined {
    return undefined;
  }

  /** Injectable per-host politeness wait for tests. */
  protected politenessSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected override createTables(): void {
    super.createTables();
    createNewsTables(this.sql);
    RecurringScheduler.createTables(this.sql);
  }

  protected override migrate(fromVersion: number, toVersion: number): void {
    super.migrate(fromVersion, toVersion);
    if (
      fromVersion > 0 &&
      fromVersion < (this.constructor as typeof NewsAgentWorker).schemaVersion
    ) {
      dropNewsTables(this.sql);
      RecurringScheduler.dropTables(this.sql);
      createNewsTables(this.sql);
      RecurringScheduler.createTables(this.sql);
    }
  }

  // ── channel state ──────────────────────────────────────────────────────────

  private ensureChannelState(channelId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO news_channel_state (channel_id, poll_interval_ms, briefing_interval_ms)
       VALUES (?, ?, ?)`,
      channelId,
      DEFAULT_POLL_INTERVAL_MS,
      DEFAULT_BRIEFING_INTERVAL_MS
    );
  }

  private getChannelState(channelId: string): NewsChannelState {
    this.ensureChannelState(channelId);
    const row = this.sql
      .exec(`SELECT * FROM news_channel_state WHERE channel_id = ?`, channelId)
      .toArray()[0]!;
    return {
      channelId,
      pollIntervalMs: Number(row["poll_interval_ms"]) || DEFAULT_POLL_INTERVAL_MS,
      briefingIntervalMs: Number(row["briefing_interval_ms"]) || DEFAULT_BRIEFING_INTERVAL_MS,
      briefingAtMinutes:
        row["briefing_at_minutes"] === null ? undefined : Number(row["briefing_at_minutes"]),
      topK: Number(row["top_k"]) || DEFAULT_TOP_K,
      setupStatus: row["setup_status"] === "configured" ? "configured" : "needs-user-preferences",
      setupPromptedAt: (row["setup_prompted_at"] as number | null) ?? undefined,
      preferencesText: (row["preferences_text"] as string | null) ?? undefined,
      lastBriefingId: (row["last_briefing_id"] as string | null) ?? undefined,
      lastRunAt: (row["last_run_at"] as number | null) ?? undefined,
      lastError: (row["last_error"] as string | null) ?? undefined,
      lastSetupJson: (row["last_setup_json"] as string | null) ?? undefined,
    };
  }

  private saveChannelState(state: NewsChannelState): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO news_channel_state
       (channel_id, poll_interval_ms, briefing_interval_ms, briefing_at_minutes, top_k, setup_status, setup_prompted_at, preferences_text, last_briefing_id, last_run_at, last_error, last_setup_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      state.channelId,
      state.pollIntervalMs,
      state.briefingIntervalMs,
      state.briefingAtMinutes ?? null,
      state.topK,
      state.setupStatus,
      state.setupPromptedAt ?? null,
      state.preferencesText ?? null,
      state.lastBriefingId ?? null,
      state.lastRunAt ?? null,
      state.lastError ?? null,
      state.lastSetupJson ?? null
    );
  }

  // ── agent configuration ───────────────────────────────────────────────────

  protected override getRespondPolicy(_channelId: string): RespondPolicy {
    return "mentioned-or-followup";
  }

  protected override getAgentPrompt(_channelId: string): string {
    return NEWS_SYSTEM_PROMPT;
  }

  protected override getLoopTools(channelId: string): AgentTool[] {
    const baseTools = super
      .getLoopTools(channelId)
      .filter((tool) => NEWS_BASE_LOOP_TOOL_NAMES.has(tool.name));
    const newsTools = toolOperations().map(
      (op) =>
        ({
          name: op.name,
          label: op.name,
          description: op.description,
          parameters: op.schema,
          execute: async (_toolCallId: string, params: unknown) => {
            if (op.needsRecovery) await this.ensureRecovered(channelId);
            const details = await op.run(this.operationContext, channelId, record(params));
            return {
              content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
              details,
            };
          },
        }) as NewsTool
    );
    return [...baseTools, ...newsTools];
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = record(config);
    return {
      handle: typeof cfg["handle"] === "string" ? cfg["handle"] : "news",
      name: typeof cfg["name"] === "string" ? cfg["name"] : "News",
      type: "agent",
      metadata: { provider: "news" },
      methods: [...advertisedMethods(), ...this.getStandardAgentMethods()],
    };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  override async subscribeChannel(
    opts: Parameters<AgentWorkerBase["subscribeChannel"]>[0]
  ): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    this.ensureChannelState(opts.channelId);
    await this.installChannelUi(opts.channelId);
    await this.publishSetupCard(opts.channelId);
    this.seedJobs(opts.channelId);
    await this.startSetupTurnIfNeeded(opts.channelId);
    return result;
  }

  private seedJobs(channelId: string): void {
    const state = this.getChannelState(channelId);
    const now = this.now();
    this.scheduler.upsertJob({
      jobId: `poll:${channelId}`,
      channelId,
      intervalMs: state.pollIntervalMs,
      jitterMs: Math.min(60_000, Math.floor(state.pollIntervalMs / 10)),
      nextRunAt: now, // first poll immediately
    });
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: nextBriefingRunAt(now, state.briefingIntervalMs, state.briefingAtMinutes),
    });
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    await this.scheduler.onAlarm(this.now(), async (jobId, channelId) => {
      if (jobId.startsWith("poll:")) await this.runPoll(channelId);
      else if (jobId.startsWith("briefing:")) await this.runBriefing(channelId);
    });
  }

  /** Entry point for workspace-level `recurring:` jobs (natstack.yml). */
  async runScheduledJob(args: unknown): Promise<{ ok: boolean }> {
    const input = record(args);
    const job = stringArg(input, "job") ?? "briefing";
    for (const channelId of this.subscribedChannelIds()) {
      if (job === "poll") await this.runPoll(channelId);
      else await this.runBriefing(channelId);
    }
    return { ok: true };
  }

  private subscribedChannelIds(): string[] {
    return this.sql
      .exec(`SELECT channel_id FROM news_channel_state`)
      .toArray()
      .map((row) => String(row["channel_id"]));
  }

  // ── Tier 1: poll ──────────────────────────────────────────────────────────

  private async runPoll(channelId: string, opts?: { force?: boolean }): Promise<void> {
    const state = this.getChannelState(channelId);
    try {
      await this.syncEngine.pollChannel(channelId, opts);
      state.lastRunAt = this.now();
      state.lastError = undefined;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    }
    this.saveChannelState(state);
    this.watchdogStuckBriefings(channelId);
    await this.publishSetupCard(channelId);
  }

  /** Flip briefings stuck in "summarizing" (e.g. dead harness turn) to error. */
  private watchdogStuckBriefings(channelId: string): void {
    const cutoff = this.now() - BRIEFING_WATCHDOG_MS;
    const stuck = this.sql
      .exec(
        `SELECT briefing_id FROM news_briefings
         WHERE channel_id = ? AND status = 'summarizing' AND created_at < ?`,
        channelId,
        cutoff
      )
      .toArray();
    for (const row of stuck) {
      const briefingId = String(row["briefing_id"]);
      this.sql.exec(
        `UPDATE news_briefings SET status = 'error' WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      );
      void this.updateBriefingCard(channelId, briefingId, {
        status: "error",
        lastError: "briefing run did not complete",
      });
    }
  }

  // ── Tier 2: briefing ──────────────────────────────────────────────────────

  private async runBriefing(channelId: string): Promise<void> {
    // Fresh articles first; a stale snapshot makes a stale briefing.
    await this.runPoll(channelId);
    const state = this.getChannelState(channelId);
    const stories = this.syncEngine.rankUnbriefed(channelId, state.topK);
    const scanned = this.syncEngine.countUnbriefed(channelId);
    const topics = this.listTopics(channelId)
      .filter((topic) => topic.enabled)
      .map((topic) => topic.topic);
    if (stories.length === 0 && topics.length === 0) return; // nothing to brief

    const now = this.now();
    const briefingId = `${new Date(now).toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const card: NewsBriefingCardState = {
      briefingId,
      createdAt: new Date(now).toISOString(),
      status: "summarizing",
      stories,
      articleCountScanned: scanned,
      newSinceLastRun: scanned,
    };
    await this.newsCards.createBriefing(channelId, card);
    this.sql.exec(
      `INSERT OR REPLACE INTO news_briefings (channel_id, briefing_id, created_at, status, story_ids_json)
       VALUES (?, ?, ?, 'summarizing', ?)`,
      channelId,
      briefingId,
      now,
      JSON.stringify(stories.map((story) => story.articleId))
    );

    const previousTldr = this.previousTldr(channelId, briefingId);
    await this.submitAgentInitiatedTurn(
      channelId,
      {
        content: buildBriefingPrompt({
          briefingId,
          dateLabel: new Date(now).toDateString(),
          stories,
          followedTopics: topics,
          previousTldr,
          preferencesText: state.preferencesText,
          articleCountScanned: scanned,
        }),
      },
      { mode: "sequential", steeringId: `news-briefing:${channelId}:${briefingId}` }
    );
  }

  private previousTldr(channelId: string, excludeBriefingId: string): string | undefined {
    const row = this.sql
      .exec(
        `SELECT tldr FROM news_briefings
         WHERE channel_id = ? AND briefing_id != ? AND status = 'ready' AND tldr IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        channelId,
        excludeBriefingId
      )
      .toArray()[0];
    return (row?.["tldr"] as string | null) ?? undefined;
  }

  private briefingState(channelId: string, briefingId: string): NewsBriefingCardState | undefined {
    const row = this.sql
      .exec(
        `SELECT * FROM news_briefings WHERE channel_id = ? AND briefing_id = ?`,
        channelId,
        briefingId
      )
      .toArray()[0];
    if (!row) return undefined;
    const storyIds = JSON.parse(String(row["story_ids_json"] ?? "[]")) as string[];
    return {
      briefingId,
      createdAt: new Date(Number(row["created_at"])).toISOString(),
      status: String(row["status"]) as NewsBriefingCardState["status"],
      tldr: (row["tldr"] as string | null) ?? undefined,
      stories: this.storiesByIds(channelId, storyIds),
      articleCountScanned: storyIds.length,
      newSinceLastRun: 0,
    };
  }

  private storiesByIds(channelId: string, articleIds: string[]): NewsStoryRef[] {
    const stories: NewsStoryRef[] = [];
    for (const id of articleIds) {
      const row = this.sql
        .exec(
          `SELECT a.*, f.title AS feed_title FROM news_articles a
           LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
           WHERE a.channel_id = ? AND a.article_id = ?`,
          channelId,
          id
        )
        .toArray()[0];
      if (!row) continue;
      stories.push({
        articleId: id,
        url: String(row["canonical_url"]),
        title: String(row["title"]),
        source:
          (row["feed_title"] as string | null) ??
          (String(row["origin"]) === "search" ? "web search" : "feed"),
        origin: String(row["origin"]) === "search" ? "search" : "feed",
        publishedAt:
          row["published_at"] === null
            ? undefined
            : new Date(Number(row["published_at"])).toISOString(),
        score: 0,
        blurb: (
          (row["blurb"] as string | null) ??
          (row["summary"] as string | null) ??
          undefined
        )?.slice(0, 280),
        read: Number(row["read"]) === 1,
      });
    }
    return stories;
  }

  private async updateBriefingCard(
    channelId: string,
    briefingId: string,
    patch: Partial<NewsBriefingCardState>
  ): Promise<void> {
    const current = this.briefingState(channelId, briefingId);
    if (!current) return;
    await this.newsCards.updateBriefing(channelId, briefingId, { ...current, ...patch });
  }

  // ── setup card ────────────────────────────────────────────────────────────

  private buildSetupCardState(channelId: string): NewsSetupCardState {
    const state = this.getChannelState(channelId);
    const feeds = this.sql
      .exec(`SELECT * FROM news_feeds WHERE channel_id = ? ORDER BY url`, channelId)
      .toArray()
      .map((row) => ({
        feedId: String(row["feed_id"]),
        url: String(row["url"]),
        title: (row["title"] as string | null) ?? undefined,
        weight: Number(row["weight"]) || 1,
        enabled: Number(row["enabled"]) === 1,
        lastFetchAt:
          row["last_fetch_at"] === null
            ? undefined
            : new Date(Number(row["last_fetch_at"])).toISOString(),
        lastStatus: (row["last_status"] as string | null) ?? undefined,
        failCount: Number(row["fail_count"]) || 0,
      }));
    const followedTopics = this.listTopics(channelId);
    const briefingLabel =
      state.briefingAtMinutes !== undefined
        ? `daily at ${String(Math.floor(state.briefingAtMinutes / 60)).padStart(2, "0")}:${String(state.briefingAtMinutes % 60).padStart(2, "0")}`
        : `every ${Math.round(state.briefingIntervalMs / 3_600_000)}h`;
    return {
      status: state.setupStatus,
      feeds,
      followedTopics,
      scheduleSummary: `polls every ${Math.round(state.pollIntervalMs / 60_000)}m, briefing ${briefingLabel}`,
      pollIntervalMs: state.pollIntervalMs,
      briefingIntervalMs: state.briefingIntervalMs,
      preferencesText: state.preferencesText,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : undefined,
      lastError: state.lastError,
    };
  }

  private async publishSetupCard(channelId: string): Promise<void> {
    const payload = this.buildSetupCardState(channelId);
    const state = this.getChannelState(channelId);
    const json = JSON.stringify(payload);
    if (state.lastSetupJson === json) return;
    await this.newsCards.publishSetup(channelId, payload);
    state.lastSetupJson = json;
    this.saveChannelState(state);
  }

  private listTopics(
    channelId: string
  ): Array<{ topic: string; weight: number; enabled: boolean }> {
    return this.sql
      .exec(
        `SELECT topic, weight, enabled FROM news_topics WHERE channel_id = ? ORDER BY topic`,
        channelId
      )
      .toArray()
      .map((row) => ({
        topic: String(row["topic"]),
        weight: Number(row["weight"]) || 1,
        enabled: Number(row["enabled"]) === 1,
      }));
  }

  // ── channel UI install & onboarding ───────────────────────────────────────

  private localActor(channelId: string): ActorRef & { participantId?: string } {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`News agent is not subscribed to channel ${channelId}`);
    return {
      kind: "agent",
      id: participantId,
      participantId,
      displayName: "News",
      metadata: { type: "agent", handle: "news", name: "News" },
    };
  }

  private async installChannelUi(channelId: string): Promise<void> {
    await installMessageTypes({
      channel: this.createChannelClient(channelId),
      actor: this.localActor(channelId),
      specs: NEWS_MESSAGE_TYPES,
      imports: NEWS_UI_IMPORTS,
      version: NEWS_UI_INSTALL_VERSION,
      keyPrefix: "news",
      cards: this.cards,
      channelId,
      readFile: async (path) => {
        try {
          const raw = await this.fs.readFile(path, "utf8");
          return typeof raw === "string"
            ? raw
            : raw instanceof Uint8Array
              ? new TextDecoder().decode(raw)
              : null;
        } catch {
          return null;
        }
      },
    });
  }

  private async startSetupTurnIfNeeded(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured" || state.setupPromptedAt) return;
    await this.submitAgentInitiatedTurn(
      channelId,
      { content: NEWS_SETUP_ONBOARDING_PROMPT },
      { mode: "sequential", steeringId: `news-setup:${channelId}` }
    );
    state.setupPromptedAt = this.now();
    this.saveChannelState(state);
  }

  private async ensureRecovered(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;
    this.recoveredChannels.add(channelId);
    const folded = await this.indexOwnCustomMessages(channelId, () => undefined);
    const setup = folded.get("news.setup");
    if (setup && setup.size > 0) {
      const messageId = [...setup.keys()][0]!;
      this.newsCards.adoptRecoveredCard(channelId, SETUP_CARD_KEY, "news.setup", messageId);
    }
    for (const [messageId, value] of folded.get("news.briefing") ?? []) {
      const briefingId = stringArg(record(value), "briefingId");
      if (!briefingId) continue;
      this.newsCards.adoptRecoveredCard(
        channelId,
        briefingCardKey(briefingId),
        "news.briefing",
        messageId
      );
    }
  }

  // ── method dispatch ───────────────────────────────────────────────────────

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    try {
      const standardResult = await this.handleStandardAgentMethodCall(channelId, methodName, args);
      if (standardResult) return standardResult;

      const op = this.operationIndex.get(methodName);
      if (!op || !op.exposure.includes("method")) {
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
      }
      if (op.needsRecovery) await this.ensureRecovered(channelId);
      const result = await op.run(this.operationContext, channelId, record(args));
      const isError = Boolean(
        result && typeof result === "object" && "error" in (result as Record<string, unknown>)
      );
      return isError ? { result, isError: true } : { result };
    } catch (err) {
      return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
    }
  }

  // ── NewsHandlers implementation ───────────────────────────────────────────

  async addFeed(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const url = stringArg(args, "url");
    if (!url) return { error: "url is required" };
    const fetched = await fetchFeed(url, { fetcher: this.feedFetcher() });
    if (fetched.status !== "ok") {
      return {
        error: `feed not reachable: ${fetched.status === "error" ? fetched.error : fetched.status}`,
      };
    }
    let parsed;
    try {
      parsed = parseFeed(fetched.body, undefined, url);
    } catch (err) {
      return { error: `not a parseable feed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const feedId = (await canonicalArticleId(url)).slice(0, 16);
    this.sql.exec(
      `INSERT INTO news_feeds (channel_id, feed_id, url, title, weight)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, feed_id) DO UPDATE SET
         url = excluded.url, title = excluded.title, weight = excluded.weight, enabled = 1`,
      channelId,
      feedId,
      url,
      parsed.title ?? null,
      numberArg(args, "weight") ?? 1.0
    );
    // Ingest right away so the feed visibly works.
    let added = 0;
    for (const item of parsed.items.slice(0, 50)) {
      if (await this.syncEngine.insertArticle(channelId, { ...item, feedId, origin: "feed" })) {
        added += 1;
      }
    }
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return { feedId, title: parsed.title, itemCount: parsed.items.length, newArticles: added };
  }

  async removeFeed(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const feedId =
      stringArg(args, "feedId") ??
      (stringArg(args, "url")
        ? (await canonicalArticleId(stringArg(args, "url")!)).slice(0, 16)
        : undefined);
    if (!feedId) return { error: "feedId or url is required" };
    this.sql.exec(`DELETE FROM news_feeds WHERE channel_id = ? AND feed_id = ?`, channelId, feedId);
    await this.publishSetupCard(channelId);
    return { removed: feedId };
  }

  async setFeedEnabled(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const feedId = stringArg(args, "feedId");
    const enabled = booleanArg(args, "enabled");
    if (!feedId || enabled === undefined) return { error: "feedId and enabled are required" };
    this.sql.exec(
      `UPDATE news_feeds SET enabled = ? WHERE channel_id = ? AND feed_id = ?`,
      enabled ? 1 : 0,
      channelId,
      feedId
    );
    await this.publishSetupCard(channelId);
    return { feedId, enabled };
  }

  async followTopic(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(
      `INSERT INTO news_topics (channel_id, topic, weight, enabled) VALUES (?, ?, ?, 1)
       ON CONFLICT(channel_id, topic) DO UPDATE SET weight = excluded.weight, enabled = 1`,
      channelId,
      topic,
      numberArg(args, "weight") ?? 1.0
    );
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return { following: topic };
  }

  async unfollowTopic(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const topic = stringArg(args, "topic");
    if (!topic) return { error: "topic is required" };
    this.sql.exec(`DELETE FROM news_topics WHERE channel_id = ? AND topic = ?`, channelId, topic);
    await this.publishSetupCard(channelId);
    return { unfollowed: topic };
  }

  async setPreferences(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const text = stringArg(args, "text") ?? "";
    const state = this.getChannelState(channelId);
    state.preferencesText = text || undefined;
    this.saveChannelState(state);
    await this.markConfigured(channelId);
    await this.publishSetupCard(channelId);
    return { saved: true, preferencesText: state.preferencesText };
  }

  private async markConfigured(channelId: string): Promise<void> {
    const state = this.getChannelState(channelId);
    if (state.setupStatus === "configured") return;
    state.setupStatus = "configured";
    this.saveChannelState(state);
  }

  async listArticles(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const limit = Math.min(numberArg(args, "limit") ?? 30, 200);
    const unbriefedOnly = booleanArg(args, "unbriefedOnly") ?? false;
    const sinceMs = numberArg(args, "sinceMs");
    const clauses = ["a.channel_id = ?"];
    const params: unknown[] = [channelId];
    if (unbriefedOnly) clauses.push("a.briefed_in IS NULL");
    if (sinceMs !== undefined) {
      clauses.push("a.fetched_at >= ?");
      params.push(sinceMs);
    }
    const rows = this.sql
      .exec(
        `SELECT a.article_id, a.title, a.canonical_url, a.published_at, a.briefed_in, a.read, a.origin,
                f.title AS feed_title
         FROM news_articles a
         LEFT JOIN news_feeds f ON f.channel_id = a.channel_id AND f.feed_id = a.feed_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
         LIMIT ?`,
        ...params,
        limit
      )
      .toArray();
    return {
      count: rows.length,
      articles: rows.map((row) => ({
        articleId: String(row["article_id"]),
        title: String(row["title"]),
        url: String(row["canonical_url"]),
        source: (row["feed_title"] as string | null) ?? String(row["origin"]),
        publishedAt:
          row["published_at"] === null
            ? undefined
            : new Date(Number(row["published_at"])).toISOString(),
        briefedIn: (row["briefed_in"] as string | null) ?? undefined,
        read: Number(row["read"]) === 1,
      })),
    };
  }

  async publishBriefing(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const briefingId = stringArg(args, "briefingId");
    const tldr = stringArg(args, "tldr");
    if (!briefingId || !tldr) return { error: "briefingId and tldr are required" };
    const briefing = this.briefingState(channelId, briefingId);
    if (!briefing) return { error: `unknown briefing: ${briefingId}` };

    const blurbs = new Map<string, string>();
    for (const entry of Array.isArray(args["storyBlurbs"]) ? args["storyBlurbs"] : []) {
      const item = record(entry);
      const id = stringArg(item, "articleId");
      if (id) blurbs.set(id, stringArg(item, "blurb") ?? "");
    }
    const dropped = new Set(
      (Array.isArray(args["droppedArticleIds"]) ? args["droppedArticleIds"] : []).map(String)
    );
    /** Short [id] prefixes from the prompt resolve to full article ids. */
    const resolveId = (idOrPrefix: string, candidates: NewsStoryRef[]): string | undefined =>
      candidates.find(
        (story) => story.articleId === idOrPrefix || story.articleId.startsWith(idOrPrefix)
      )?.articleId;

    const kept: NewsStoryRef[] = [];
    const keptIds = new Set<string>();
    for (const story of briefing.stories) {
      const droppedHit = [...dropped].some(
        (id) => story.articleId === id || story.articleId.startsWith(id)
      );
      if (droppedHit) continue;
      const blurbKey = [...blurbs.keys()].find(
        (id) => story.articleId === id || story.articleId.startsWith(id)
      );
      kept.push({ ...story, blurb: blurbKey ? blurbs.get(blurbKey) || story.blurb : story.blurb });
      keptIds.add(story.articleId);
    }

    // Search-found stories become first-class articles (deduped by URL).
    let searchStoryCount = 0;
    for (const entry of Array.isArray(args["searchStories"]) ? args["searchStories"] : []) {
      if (searchStoryCount >= MAX_SEARCH_STORIES_PER_BRIEFING) break;
      const item = record(entry);
      const url = stringArg(item, "url");
      const title = stringArg(item, "title");
      if (!url || !title) continue;
      if (!isHttpUrl(url)) continue;
      let id: string;
      try {
        id = await canonicalArticleId(url);
      } catch {
        continue;
      }
      if (keptIds.has(id)) continue;
      await this.syncEngine.insertArticle(channelId, {
        url,
        title,
        origin: "search",
        blurb: stringArg(item, "blurb"),
      });
      keptIds.add(id);
      searchStoryCount += 1;
      kept.push({
        articleId: id,
        url,
        title,
        source: stringArg(item, "source") ?? "web search",
        origin: "search",
        score: 0,
        blurb: stringArg(item, "blurb"),
      });
    }

    const now = this.now();
    this.sql.exec(
      `UPDATE news_briefings SET status = 'ready', tldr = ?, story_ids_json = ? WHERE channel_id = ? AND briefing_id = ?`,
      tldr,
      JSON.stringify(kept.map((story) => story.articleId)),
      channelId,
      briefingId
    );
    for (const story of kept) {
      this.sql.exec(
        `UPDATE news_articles SET briefed_in = ?, blurb = COALESCE(?, blurb) WHERE channel_id = ? AND article_id = ?`,
        briefingId,
        story.blurb ?? null,
        channelId,
        story.articleId
      );
    }
    for (const id of dropped) {
      this.sql.exec(
        `UPDATE news_articles SET briefed_in = ? WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%')`,
        `dropped:${briefingId}`,
        channelId,
        id,
        id
      );
    }
    const state = this.getChannelState(channelId);
    state.lastBriefingId = briefingId;
    this.saveChannelState(state);

    await this.newsCards.updateBriefing(channelId, briefingId, {
      briefingId,
      createdAt: briefing.createdAt,
      status: "ready",
      tldr,
      stories: kept,
      articleCountScanned: briefing.articleCountScanned,
      newSinceLastRun: briefing.newSinceLastRun,
    });
    return { published: briefingId, storyCount: kept.length, at: new Date(now).toISOString() };
  }

  async briefingHistory(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const limit = Math.min(numberArg(args, "limit") ?? 5, 50);
    const rows = this.sql
      .exec(
        `SELECT briefing_id, created_at, status, tldr FROM news_briefings
         WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
        channelId,
        limit
      )
      .toArray();
    return {
      briefings: rows.map((row) => ({
        briefingId: String(row["briefing_id"]),
        createdAt: new Date(Number(row["created_at"])).toISOString(),
        status: String(row["status"]),
        tldr: (row["tldr"] as string | null) ?? undefined,
      })),
    };
  }

  async setSchedule(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.getChannelState(channelId);
    const pollIntervalMs = numberArg(args, "pollIntervalMs");
    const briefingIntervalMs = numberArg(args, "briefingIntervalMs");
    if (pollIntervalMs !== undefined) state.pollIntervalMs = Math.max(60_000, pollIntervalMs);
    if (briefingIntervalMs !== undefined)
      state.briefingIntervalMs = Math.max(600_000, briefingIntervalMs);
    if ("briefingAt" in args) {
      const at = args["briefingAt"];
      if (at === null) {
        state.briefingAtMinutes = undefined;
      } else if (typeof at === "string") {
        const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
          return { error: `invalid briefingAt: ${at} (expected "HH:MM")` };
        }
        state.briefingAtMinutes = Number(match[1]) * 60 + Number(match[2]);
        // A local-time anchor implies a daily cadence.
        state.briefingIntervalMs = Math.max(
          DAY_MS,
          state.briefingIntervalMs - (state.briefingIntervalMs % DAY_MS) || DAY_MS
        );
      }
    }
    this.saveChannelState(state);
    this.seedJobsAfterReschedule(channelId, state);
    await this.publishSetupCard(channelId);
    return {
      pollIntervalMs: state.pollIntervalMs,
      briefingIntervalMs: state.briefingIntervalMs,
      briefingAtMinutes: state.briefingAtMinutes,
    };
  }

  private seedJobsAfterReschedule(channelId: string, state: NewsChannelState): void {
    const now = this.now();
    this.scheduler.upsertJob({
      jobId: `poll:${channelId}`,
      channelId,
      intervalMs: state.pollIntervalMs,
      jitterMs: Math.min(60_000, Math.floor(state.pollIntervalMs / 10)),
      nextRunAt: now + state.pollIntervalMs,
    });
    this.scheduler.upsertJob({
      jobId: `briefing:${channelId}`,
      channelId,
      intervalMs: state.briefingIntervalMs,
      nextRunAt: nextBriefingRunAt(now, state.briefingIntervalMs, state.briefingAtMinutes),
    });
  }

  async markRead(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const ids = Array.isArray(args["articleIds"]) ? args["articleIds"].map(String) : [];
    if (ids.length === 0) return { error: "articleIds is required" };
    for (const id of ids) {
      this.sql.exec(
        `UPDATE news_articles SET read = 1 WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%')`,
        channelId,
        id,
        id
      );
    }
    return { markedRead: ids.length };
  }

  async refreshNow(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    await this.runPoll(channelId, { force: true });
    if (booleanArg(args, "briefing")) {
      await this.runBriefing(channelId);
      return { polled: true, briefingStarted: true };
    }
    return { polled: true, unbriefed: this.syncEngine.countUnbriefed(channelId) };
  }

  async requestDeepDive(channelId: string, args: Record<string, unknown>): Promise<unknown> {
    const idOrPrefix = stringArg(args, "articleId");
    if (!idOrPrefix) return { error: "articleId is required" };
    const row = this.sql
      .exec(
        `SELECT article_id, canonical_url, title, briefed_in FROM news_articles
         WHERE channel_id = ? AND (article_id = ? OR article_id LIKE ? || '%') LIMIT 1`,
        channelId,
        idOrPrefix,
        idOrPrefix
      )
      .toArray()[0];
    if (!row) return { error: `unknown article: ${idOrPrefix}` };
    const payload: NewsDeepDiveRequested = {
      articleId: String(row["article_id"]),
      url: String(row["canonical_url"]),
      title: String(row["title"]),
      briefingId: (row["briefed_in"] as string | null) ?? undefined,
    };
    const actor = this.localActor(channelId);
    await this.createChannelClient(channelId).sendSignalEvent(
      actor.id,
      NEWS_DEEPDIVE_SIGNAL,
      payload
    );
    return { requested: payload };
  }

  async getOverview(channelId: string, _args: Record<string, unknown>): Promise<unknown> {
    const state = this.getChannelState(channelId);
    return {
      setup: this.buildSetupCardState(channelId),
      articleCount: this.syncEngine.countArticles(channelId),
      unbriefedCount: this.syncEngine.countUnbriefed(channelId),
      lastBriefingId: state.lastBriefingId,
    };
  }
}

// Keep the operations table honest: every operation must resolve at startup.
void NEWS_OPERATIONS;

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
