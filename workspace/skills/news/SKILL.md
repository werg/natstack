# News

Agentic news aggregation: the `workers/news-agent` Durable Object polls
RSS/Atom/JSON feeds deterministically (Tier 1, zero tokens), and a scheduled
briefing turn (Tier 2) web-searches followed topics, ranks the top stories,
and publishes a TLDR briefing card.

## Pieces

- **Worker**: `workers/news-agent` (`NewsAgentWorker`) — per-channel feeds,
  followed topics, articles (deduped by canonical-URL sha256), briefings, and
  a `RecurringScheduler` driving `poll:{channelId}` / `briefing:{channelId}`
  jobs off the single DO alarm.
- **Panel**: `panels/news` — reader UI (latest TLDR + article list) with the
  full `AgenticChat` embedded on the same channel. Story "Deep-dive" forks the
  channel via `@workspace/channel-fork` (cloning the agent DO) into a fresh
  analysis chat panel.
- **Renderers** (this skill): `renderers/news-briefing.tsx` and
  `renderers/news-setup.tsx`, registered as `news.briefing` / `news.setup`
  message types by the agent on subscribe.
- **Shared package**: `@workspace/feeds` — feed parsing, URL canonicalization,
  conditional polite fetching, recency scoring, and the card-state contracts
  (`@workspace/feeds/card-types`).

## Agent surface

One operations table (`workers/news-agent/operations.ts`) drives the model
tools, `onMethodCall` methods, and the participant descriptor: `news_add_feed`,
`news_remove_feed`, `news_follow_topic`, `news_unfollow_topic`,
`news_set_preferences`, `news_list_articles`, `news_publish_briefing`,
`news_get_briefing_history`, plus method-only `setSchedule`, `markRead`,
`refreshNow`, `requestDeepDive`, `getOverview`, `setFeedEnabled`.

## Standing schedules

Per-channel cadence is DO-internal (configure via the setup card or
`setSchedule`). Workspace-level standing jobs can also be declared in
`meta/natstack.yml` under `recurring:` (approval-gated); the agent exposes
`runScheduledJob({ job: "poll" | "briefing" })` for that path.
