import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { Fetcher } from "@workspace/feeds";
import { articleId } from "@workspace/feeds";
import type { NewsBriefingCardState } from "@workspace/feeds/card-types";

import { NewsAgentWorker } from "./news-agent-worker.js";
import { NEWS_MESSAGE_TYPES } from "./cards.js";

const FEED_URL = "https://example.com/feed.xml";

function rss(items: Array<{ title: string; link: string; pubDate?: string }>): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Feed</title>
    ${items
      .map(
        (item) =>
          `<item><title>${item.title}</title><link>${item.link}</link>${
            item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""
          }</item>`
      )
      .join("")}
  </channel></rss>`;
}

class TestNewsAgentWorker extends NewsAgentWorker {
  published: Array<{ participantId: string; event: { kind?: string; payload?: unknown } }> = [];
  signals: Array<{ participantId: string; content: string; type?: string }> = [];
  agentInitiatedTurns: Array<{ channelId: string; content: string }> = [];
  /** url → ordered list of responses; last one repeats. */
  feedResponses = new Map<
    string,
    Array<{ status: number; body?: string; headers?: Record<string, string> }>
  >();
  blobs = new Map<string, string>();
  clock: number = 1_750_000_000_000;
  capturedAlarms: number[] = [];

  execSqlForTest(query: string, ...args: unknown[]): void {
    this.sql.exec(query, ...args);
  }

  rowsForTest(query: string, ...args: unknown[]): Array<Record<string, unknown>> {
    return this.sql.exec(query, ...args).toArray() as Array<Record<string, unknown>>;
  }

  schedulerForTest() {
    return this["scheduler"];
  }

  loopTools(channelId = "ch-1") {
    return this.getLoopTools(channelId).map((tool) => tool.name);
  }

  async alarmAt(time: number): Promise<void> {
    this.clock = time;
    await this.alarm();
  }

  protected override now(): number {
    return this.clock;
  }

  protected override setAlarmAt(timeMs: number): void {
    this.capturedAlarms.push(timeMs);
  }

  protected override politenessSleep(): Promise<void> {
    return Promise.resolve();
  }

  rpcCall = vi.fn(async (_target: string, method: string, args?: unknown[]): Promise<unknown> => {
    if (method === "runtime.resolveContext") return "ctx-1";
    if (method === "workers.resolveService") {
      return { kind: "durable-object", targetId: "do:channel:test" };
    }
    if (method === "subscribe") {
      return { ok: true, participantId: "agent-news", channelConfig: {} };
    }
    if (method === "workspace.getAgentsMd") return "";
    if (method === "workspace.listSkills") return [];
    if (method === "fs.readFile") {
      const filePath = String(args?.[0] ?? "");
      if (filePath === "skills/news/renderers/news-setup.tsx") {
        return readFileSync(
          new URL("../../skills/news/renderers/news-setup.tsx", import.meta.url),
          "utf8"
        );
      }
      if (filePath === "skills/news/renderers/news-briefing.tsx") {
        return readFileSync(
          new URL("../../skills/news/renderers/news-briefing.tsx", import.meta.url),
          "utf8"
        );
      }
      throw new Error(`unexpected fs.readFile path: ${filePath}`);
    }
    if (method === "blobstore.putText") {
      const value = String(args?.[0] ?? "");
      const digest = `blob-${this.blobs.size + 1}`;
      this.blobs.set(digest, value);
      return { digest, size: value.length };
    }
    return null;
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
      callDeferred: async (...args: unknown[]) => ({
        status: "completed" as const,
        result: await (this.rpcCall as (...rpcArgs: unknown[]) => Promise<unknown>)(...args),
      }),
    } as never;
  }

  protected override feedFetcher(): Fetcher {
    return async (url) => {
      const queue = this.feedResponses.get(url);
      if (!queue || queue.length === 0) return new Response("not found", { status: 404 });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(next.body ?? null, { status: next.status, headers: next.headers });
    };
  }

  seedSubscription(channelId = "ch-1", participantId = "agent-news") {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      JSON.stringify({ handle: "news" }),
      participantId
    );
  }

  protected override async submitAgentInitiatedTurn(
    channelId: string,
    input: { content?: string }
  ): Promise<void> {
    this.agentInitiatedTurns.push({ channelId, content: input.content ?? "" });
  }

  protected override createChannelClient() {
    return {
      subscribe: async () => ({
        ok: true,
        channelConfig: undefined,
        envelope: { mode: "initial", logEvents: [], snapshots: [], ready: {} },
      }),
      unsubscribe: async () => undefined,
      getConfig: async () => null,
      getParticipants: async () => [],
      getReplayAfter: async () => ({
        mode: "after",
        logEvents: [],
        snapshots: [],
        ready: { totalCount: 0, envelopeCount: 0 },
      }),
      publishAgenticEvent: async (
        participantId: string,
        event: { kind?: string; payload?: unknown }
      ) => {
        this.published.push({ participantId, event });
        return { id: this.published.length };
      },
      sendSignal: async (participantId: string, content: string, type?: string) => {
        this.signals.push({ participantId, content, type });
      },
      sendSignalEvent: async (participantId: string, contentType: string, payload: unknown) => {
        this.signals.push({ participantId, content: JSON.stringify(payload), type: contentType });
      },
      getMessageType: async (typeId: string) => {
        const spec = NEWS_MESSAGE_TYPES.find((entry) => entry.typeId === typeId);
        if (!spec) return null;
        return {
          typeId: spec.typeId,
          displayMode: spec.displayMode,
          stateSchema: spec.stateSchema,
        };
      },
    } as never;
  }
}

async function makeWorker() {
  const { instance } = await createTestDO(TestNewsAgentWorker, {
    WORKERD_SESSION_ID: "test-session",
    WORKERD_BOOT_GENERATION: "1",
  });
  const worker = instance as TestNewsAgentWorker;
  worker.seedSubscription();
  return worker;
}

async function addExampleFeed(
  worker: TestNewsAgentWorker,
  items: Array<{ title: string; link: string; pubDate?: string }>
) {
  worker.feedResponses.set(FEED_URL, [
    { status: 200, body: rss(items), headers: { etag: '"v1"' } },
  ]);
  return (await worker.addFeed("ch-1", { url: FEED_URL })) as Record<string, unknown>;
}

describe("NewsAgentWorker", () => {
  it("exposes the web research tools its briefing prompt requires", async () => {
    const worker = await makeWorker();
    expect(worker.loopTools()).toEqual(
      expect.arrayContaining([
        "close_turn_without_response",
        "ask_user",
        "web_search",
        "web_fetch",
        "web_read",
        "news_add_feed",
        "news_follow_topic",
        "news_publish_briefing",
      ])
    );
  });

  it("addFeed validates by fetching, ingests immediately, and dedupes across polls", async () => {
    const worker = await makeWorker();
    const result = await addExampleFeed(worker, [
      { title: "First story", link: "https://example.com/a?utm_source=rss" },
      { title: "Second story", link: "https://example.com/b" },
    ]);
    expect(result).toMatchObject({ title: "Example Feed", itemCount: 2, newArticles: 2 });

    // Re-poll the same content: nothing new (URL canonicalization dedupes).
    const poll = (await worker.refreshNow("ch-1", {})) as Record<string, unknown>;
    expect(poll["unbriefed"]).toBe(2);
    const rows = worker.rowsForTest(`SELECT article_id, canonical_url FROM news_articles`);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["canonical_url"])).toContain("https://example.com/a");
  });

  it("rejects unfetchable or unparseable feeds", async () => {
    const worker = await makeWorker();
    worker.feedResponses.set("https://bad.example/feed", [{ status: 503 }]);
    expect(await worker.addFeed("ch-1", { url: "https://bad.example/feed" })).toMatchObject({
      error: expect.stringContaining("not reachable"),
    });
    worker.feedResponses.set("https://html.example/page", [{ status: 200, body: "<html></html>" }]);
    expect(await worker.addFeed("ch-1", { url: "https://html.example/page" })).toMatchObject({
      error: expect.stringContaining("not a parseable feed"),
    });
  });

  it("applies growing backoff to failing feeds and recovers on success", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);
    worker.feedResponses.set(FEED_URL, [{ status: 500 }]);
    await worker.refreshNow("ch-1", {});
    const failed = worker.rowsForTest(`SELECT fail_count, backoff_until FROM news_feeds`)[0]!;
    expect(Number(failed["fail_count"])).toBe(1);
    expect(Number(failed["backoff_until"])).toBeGreaterThan(worker.clock);

    // force-refresh ignores backoff; second failure doubles it
    await worker.refreshNow("ch-1", {});
    const failed2 = worker.rowsForTest(`SELECT fail_count, backoff_until FROM news_feeds`)[0]!;
    expect(Number(failed2["fail_count"])).toBe(2);
    expect(Number(failed2["backoff_until"]) - worker.clock).toBeGreaterThan(
      Number(failed["backoff_until"]) - worker.clock
    );

    worker.feedResponses.set(FEED_URL, [
      { status: 200, body: rss([{ title: "B", link: "https://example.com/b" }]) },
    ]);
    await worker.refreshNow("ch-1", {});
    const recovered = worker.rowsForTest(`SELECT fail_count, last_status FROM news_feeds`)[0]!;
    expect(Number(recovered["fail_count"])).toBe(0);
    expect(String(recovered["last_status"])).toBe("ok");
  });

  it("subscribeChannel installs UI, publishes the setup card, seeds jobs, and starts onboarding", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);

    const kinds = worker.published.map((entry) => entry.event.kind);
    expect(kinds).toContain("messageType.registered");
    expect(kinds).toContain("custom.started"); // setup card

    const jobs = worker.rowsForTest(`SELECT job_id FROM recurring_jobs ORDER BY job_id`);
    expect(jobs.map((row) => row["job_id"])).toEqual(["briefing:ch-1", "poll:ch-1"]);
    expect(worker.capturedAlarms.length).toBeGreaterThan(0);

    expect(worker.agentInitiatedTurns).toHaveLength(1);
    expect(worker.agentInitiatedTurns[0]!.content).toContain("not configured any news sources");
    // Re-subscribe does not re-prompt.
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    expect(worker.agentInitiatedTurns).toHaveLength(1);
  });

  it("briefing run creates a summarizing card and a self-contained turn prompt", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      {
        title: "Big launch happened",
        link: "https://example.com/launch",
        pubDate: new Date(worker.clock - 3_600_000).toUTCString(),
      },
      {
        title: "Minor update shipped",
        link: "https://example.com/minor",
        pubDate: new Date(worker.clock - 50 * 3_600_000).toUTCString(),
      },
    ]);
    await worker.followTopic("ch-1", { topic: "AI agents" });
    await worker.setPreferences("ch-1", { text: "less crypto, terse blurbs" });
    // Seed a prior briefing for continuity.
    worker.execSqlForTest(
      `INSERT INTO news_briefings (channel_id, briefing_id, created_at, status, tldr, story_ids_json)
       VALUES ('ch-1', 'prev', ?, 'ready', 'Yesterday: the foo merged.', '[]')`,
      worker.clock - 86_400_000
    );

    await worker.refreshNow("ch-1", { briefing: true });

    const briefing = worker.rowsForTest(
      `SELECT briefing_id, status FROM news_briefings WHERE briefing_id != 'prev'`
    )[0]!;
    expect(String(briefing["status"])).toBe("summarizing");

    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.content).toContain("Big launch happened");
    expect(turn.content).toContain("AI agents");
    expect(turn.content).toContain("Yesterday: the foo merged.");
    expect(turn.content).toContain("less crypto, terse blurbs");
    expect(turn.content).toContain(String(briefing["briefing_id"]));
  });

  it("news_publish_briefing finalizes the card, marks stories briefed, and merges search stories", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Keep me", link: "https://example.com/keep" },
      { title: "Drop me", link: "https://example.com/drop" },
    ]);
    await worker.refreshNow("ch-1", { briefing: true });
    const briefingId = String(
      worker.rowsForTest(`SELECT briefing_id FROM news_briefings`)[0]!["briefing_id"]
    );
    const keepId = await articleId("https://example.com/keep");
    const dropId = await articleId("https://example.com/drop");

    const result = (await worker.publishBriefing("ch-1", {
      briefingId,
      tldr: "**Keep me** shipped.",
      storyBlurbs: [{ articleId: keepId.slice(0, 8), blurb: "It shipped." }],
      droppedArticleIds: [dropId.slice(0, 8)],
      searchStories: [
        {
          url: "https://elsewhere.example/found",
          title: "Found via search",
          blurb: "From topics.",
        },
        {
          url: "https://elsewhere.example/found?utm_source=dup",
          title: "Duplicate via search",
          blurb: "Duplicate should be ignored.",
        },
        {
          url: "file:///tmp/private",
          title: "Not a web citation",
          blurb: "Should be ignored.",
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          url: `https://elsewhere.example/found-${index}`,
          title: `Found ${index}`,
          blurb: "From topics.",
        })),
      ],
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ published: briefingId, storyCount: 11 });

    const articles = worker.rowsForTest(
      `SELECT article_id, briefed_in, blurb, origin FROM news_articles ORDER BY canonical_url`
    );
    const kept = articles.find((row) => row["article_id"] === keepId)!;
    expect(kept["briefed_in"]).toBe(briefingId);
    expect(kept["blurb"]).toBe("It shipped.");
    const droppedRow = articles.find((row) => row["article_id"] === dropId)!;
    expect(String(droppedRow["briefed_in"])).toBe(`dropped:${briefingId}`);
    expect(articles.filter((row) => row["origin"] === "search")).toHaveLength(10);
    expect(articles.some((row) => row["canonical_url"] === "file:///tmp/private")).toBe(false);

    expect(
      worker.rowsForTest(
        `SELECT status, tldr FROM news_briefings WHERE briefing_id = ?`,
        briefingId
      )[0]
    ).toMatchObject({ status: "ready", tldr: "**Keep me** shipped." });

    // Next briefing prompt carries this TLDR forward.
    await worker.refreshNow("ch-1", {});
    worker.feedResponses.set(FEED_URL, [
      { status: 200, body: rss([{ title: "New day", link: "https://example.com/new" }]) },
    ]);
    await worker.refreshNow("ch-1", { briefing: true });
    expect(worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!.content).toContain(
      "**Keep me** shipped."
    );
  });

  it("scheduler alarm drives polls and watchdogs stuck briefings", async () => {
    const worker = await makeWorker();
    await worker.subscribeChannel({ channelId: "ch-1", contextId: "ctx-1" } as never);
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);

    // Stuck briefing from 31 minutes ago flips to error on the next poll.
    worker.execSqlForTest(
      `INSERT INTO news_briefings (channel_id, briefing_id, created_at, status, story_ids_json)
       VALUES ('ch-1', 'stuck', ?, 'summarizing', '[]')`,
      worker.clock - 31 * 60_000
    );
    await worker.alarmAt(worker.clock + 1); // poll job is due immediately after subscribe
    expect(
      worker.rowsForTest(`SELECT status FROM news_briefings WHERE briefing_id = 'stuck'`)[0]![
        "status"
      ]
    ).toBe("error");

    // The poll job rescheduled itself.
    const next = Number(
      worker.rowsForTest(`SELECT next_run_at FROM recurring_jobs WHERE job_id = 'poll:ch-1'`)[0]![
        "next_run_at"
      ]
    );
    expect(next).toBeGreaterThan(worker.clock);
  });

  it("requestDeepDive resolves id prefixes and emits the typed signal", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "Dive story", link: "https://example.com/dive" }]);
    const id = await articleId("https://example.com/dive");

    const result = (await worker.requestDeepDive("ch-1", { articleId: id.slice(0, 8) })) as Record<
      string,
      unknown
    >;
    expect(result["requested"]).toMatchObject({ articleId: id, title: "Dive story" });
    const signal = worker.signals[worker.signals.length - 1]!;
    expect(signal.type).toBe("news.deepdive.requested");
    expect(JSON.parse(signal.content)).toMatchObject({ url: "https://example.com/dive" });

    expect(await worker.requestDeepDive("ch-1", { articleId: "nope" })).toMatchObject({
      error: expect.stringContaining("unknown article"),
    });
  });

  it("onMethodCall routes operations and rejects unknown methods", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [{ title: "A", link: "https://example.com/a" }]);

    const overview = await worker.onMethodCall("ch-1", "call-1", "getOverview", {});
    expect(record(overview.result)["articleCount"]).toBe(1);

    const schedule = await worker.onMethodCall("ch-1", "call-2", "setSchedule", {
      briefingAt: "08:00",
    });
    expect(record(schedule.result)["briefingAtMinutes"]).toBe(480);

    const unknown = await worker.onMethodCall("ch-1", "call-3", "fly", {});
    expect(unknown.isError).toBe(true);

    // Tool-only operations are not callable as methods.
    const toolOnly = await worker.onMethodCall("ch-1", "call-4", "news_publish_briefing", {});
    expect(toolOnly.isError).toBe(true);
  });

  it("markRead excludes articles from ranking", async () => {
    const worker = await makeWorker();
    await addExampleFeed(worker, [
      { title: "Read me not", link: "https://example.com/x" },
      { title: "Fresh", link: "https://example.com/y" },
    ]);
    const id = await articleId("https://example.com/x");
    await worker.markRead("ch-1", { articleIds: [id.slice(0, 10)] });
    await worker.refreshNow("ch-1", { briefing: true });
    const turn = worker.agentInitiatedTurns[worker.agentInitiatedTurns.length - 1]!;
    expect(turn.content).toContain("Fresh");
    expect(turn.content).not.toContain("Read me not");
  });

  it("recovers card identities from replay via ensureRecovered", async () => {
    const worker = await makeWorker();
    const folded = new Map<string, Map<string, unknown>>([
      ["news.setup", new Map([["msg-setup", { status: "configured" }]])],
      [
        "news.briefing",
        new Map([["msg-brief", { briefingId: "b-1" } satisfies Partial<NewsBriefingCardState>]]),
      ],
    ]);
    const spy = vi
      .spyOn(
        worker as unknown as { indexOwnCustomMessages: (...args: unknown[]) => unknown },
        "indexOwnCustomMessages"
      )
      .mockResolvedValue(folded as never);

    // requestDeepDive declares needsRecovery; dispatch via onMethodCall runs it.
    await worker.onMethodCall("ch-1", "call-1", "requestDeepDive", { articleId: "missing" });
    expect(spy).toHaveBeenCalledOnce();
    const cards = worker.rowsForTest(
      `SELECT natural_key, message_id FROM custom_cards ORDER BY natural_key`
    );
    expect(cards).toEqual([
      expect.objectContaining({ natural_key: "ch-1:news:briefing:b-1", message_id: "msg-brief" }),
      expect.objectContaining({ natural_key: "ch-1:news:setup", message_id: "msg-setup" }),
    ]);
  });
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
