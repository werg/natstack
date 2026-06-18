# News

Agentic news aggregation in three tiers:
- **Tier 1 — poll** (deterministic, zero tokens): the `workers/news-agent`
  Durable Object polls RSS/Atom/JSON feeds, dedupes, and stores items.
- **Tier 1.5 — triage** (agent, light): `runTriage` batches un-triaged items
  into a `news_triage` turn that categorizes, clusters same-event coverage,
  one-line-summarizes, and drops noise. The reader only shows triaged items
  (`listArticles triagedOnly`), so nothing raw/un-curated surfaces. Fired on
  demand (the reader's `triageNow` when it opens with a backlog) and at
  briefing time.
- **Tier 2 — briefing** (agent, deep): a scheduled/cold-start briefing turn
  web-searches followed topics, reads the top stories, and publishes a
  structured TLDR briefing card. A manual "Brief me now" runs the same turn
  silently (scheduled runs fire a "ready" notification).

## Pieces

- **Worker**: `workers/news-agent` (`NewsAgentWorker`) — per-channel feeds,
  followed topics, articles (deduped by canonical-URL sha256), briefings, and
  a `RecurringScheduler` driving `poll:{channelId}` / `briefing:{channelId}`
  jobs off the single DO alarm.
- **Panel**: `panels/news` — reader UI (latest TLDR + article list, a first-run
  quick-start with one-click feeds/topics, and an in-progress briefing hero)
  with the full `AgenticChat` embedded on the same channel. It resolves the
  workspace-configured model and subscribes the agent with it. Story "Deep-dive"
  forks the channel via `@workspace/channel-fork` (cloning the agent DO) into a
  fresh analysis chat and calls `startDeepDive` on the clone to seed the
  analyst's opening turn.
- **Renderers** (this skill): `renderers/news-briefing.tsx` and
  `renderers/news-setup.tsx`, registered as `news.briefing` / `news.setup`
  message types by the agent on subscribe.
- **Shared package**: `@workspace/feeds` — feed parsing, URL canonicalization,
  conditional polite fetching, recency scoring, and the card-state contracts
  (`@workspace/feeds/card-types`).

## Agent surface

One operations table (`workers/news-agent/operations.ts`) drives the model
tools, `onMethodCall` methods, and the participant descriptor: `news_add_feed`,
`news_import_opml`, `news_remove_feed`, `news_follow_topic`,
`news_unfollow_topic`, `news_set_preferences`, `news_list_articles`,
`news_publish_briefing`, `news_get_briefing_history`, plus method-only
`setSchedule`, `markRead`, `refreshNow`, `requestDeepDive`, `getOverview`,
`setFeedEnabled`. `startDeepDive` is a direct DO method the panel calls on a
freshly-cloned agent after forking.

## Channel modes

A channel is either `curator` (a normal personal news channel: polls feeds,
publishes the setup card, runs briefings) or `analyst` (a deep-dive fork:
focused on one story, no polling/setup/onboarding). `postClone` marks forks as
`analyst` and strips the parent channel's copied jobs/state; `subscribeChannel`
skips curator bootstrap for analyst channels.

## Standing schedules

Per-channel cadence is DO-internal and automatic — each curator channel's
`RecurringScheduler` drives its own `poll:` / `briefing:` jobs (configure via
the setup card or `setSchedule`); a self-canceling `watchdog:` job flips a
stalled briefing to error within minutes. Workspace-level standing jobs are
**optional** and can be declared in `meta/natstack.yml` under `recurring:`
(approval-gated) to drive a specific pinned agent instance by objectKey; the
agent exposes `runScheduledJob({ job: "poll" | "briefing" })` for that path
(it skips analyst channels).
