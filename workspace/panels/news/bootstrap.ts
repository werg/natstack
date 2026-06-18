/** Pure bootstrap + presentation helpers, unit-testable without the runtime. */

export function resolveNewsContextId(
  stateArgsContextId: string | undefined,
  runtimeContextId: string | undefined,
): string | undefined {
  const contextId = stateArgsContextId ?? runtimeContextId;
  if (typeof contextId !== "string") return undefined;
  const trimmed = contextId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function newsChannelName(random: () => string = () => crypto.randomUUID()): string {
  return `news-${random().slice(0, 8)}`;
}

export function newsAgentKey(random: () => string = () => crypto.randomUUID()): string {
  return `news-agent-${random().slice(0, 8)}`;
}

/** Curated one-click feeds for the empty-state quick start. */
export interface SuggestedFeed {
  label: string;
  url: string;
  blurb: string;
}

export const SUGGESTED_FEEDS: SuggestedFeed[] = [
  { label: "Hacker News", url: "https://hnrss.org/frontpage", blurb: "Tech & startups" },
  {
    label: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    blurb: "Tech, science, policy",
  },
  { label: "The Verge", url: "https://www.theverge.com/rss/index.xml", blurb: "Tech & culture" },
  { label: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", blurb: "World news" },
  {
    label: "NASA",
    url: "https://www.nasa.gov/feed/",
    blurb: "Space & science",
  },
];

/** Curated one-click topics (web-searched each briefing). */
export const SUGGESTED_TOPICS: string[] = [
  "artificial intelligence",
  "open source software",
  "space exploration",
  "climate technology",
  "startups & venture capital",
];

/** Compact relative age like "now" / "3h" / "2d" for a timestamp. */
export function relativeAge(iso: string | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
