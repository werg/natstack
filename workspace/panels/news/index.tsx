/**
 * News panel — a reader app wrapped around the reusable agentic stack.
 *
 * Left region: deterministic reader UI (latest TLDR, article list with filters,
 * past briefings, a first-run quick-start, and a model-connect nudge) fed by
 * direct DO method calls on the news agent. Right region: the full AgenticChat
 * on the same channel. Story deep-dives fork the channel (cloning the agent DO)
 * into a fresh analysis chat and seed the analyst's opening turn on the clone.
 */

import {
  contextId as runtimeContextId,
  createDurableObjectServiceClient,
  openPanel,
  panel,
  rpc,
  type DurableObjectServiceClient,
} from "@workspace/runtime";
import { recoveryCoordinator } from "@workspace/runtime/internal/diagnostics";
import { usePanelTheme } from "@workspace/react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  IconButton,
  Link,
  ScrollArea,
  SegmentedControl,
  Select,
  Separator,
  Spinner,
  Switch,
  Text,
  TextArea,
  TextField,
  Theme,
} from "@radix-ui/themes";
import {
  CheckIcon,
  CopyIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  EyeNoneIcon,
  GearIcon,
  GlobeIcon,
  LightningBoltIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ReloadIcon,
  StarFilledIcon,
  StarIcon,
  ThickArrowDownIcon,
  ThickArrowUpIcon,
} from "@radix-ui/react-icons";
import { AgenticChat, ErrorBoundary, markdownComponents } from "@workspace/agentic-chat";
import type { ConnectionConfig } from "@workspace/agentic-chat";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createPanelSandboxConfig, parseSignalEvent } from "@workspace/agentic-core";
import { connectViaRpc } from "@workspace/pubsub";
import { fork } from "@workspace/channel-fork";
import {
  DEFAULT_AGENT_MODEL_REF,
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type ModelCatalog,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import { toPanelConnectRequest } from "@workspace/model-catalog/providerConnect";
import { findMatchingUrlAudience } from "@natstack/shared/credentials/urlAudience";
import type { UrlAudience } from "@natstack/shared/credentials/urlAudience";
import {
  NEWS_DEEPDIVE_SIGNAL,
  type NewsDeepDiveRequested,
  type NewsSetupCardState,
} from "@workspace/feeds/card-types";
import {
  newsAgentKey,
  newsChannelName,
  relativeAge,
  resolveNewsContextId,
  SUGGESTED_FEEDS,
  SUGGESTED_TOPICS,
} from "./bootstrap.js";
import {
  NEWS_AGENT_CLASS,
  NEWS_AGENT_HANDLE,
  NEWS_AGENT_SOURCE,
  type NewsStateArgs,
} from "./types.js";

interface ArticleRow {
  articleId: string;
  title: string;
  url: string;
  source: string;
  blurb?: string;
  publishedAt?: string;
  /** Epoch ms we first ingested it — drives the "new since last visit" marker. */
  fetchedAt?: number;
  /** Agent-assigned section. */
  category?: string;
  /** Agent-assigned key shared by same-event coverage (semantic clustering). */
  clusterKey?: string;
  briefedIn?: string;
  read: boolean;
  saved?: boolean;
}

/** A cluster of near-duplicate coverage: one primary story + other sources. */
interface ArticleCluster {
  primary: ArticleRow;
  others: ArticleRow[];
}

type FeedView = "all" | "unread" | "saved";

interface SearchResults {
  query: string;
  articles: ArticleRow[];
  briefings: BriefingRow[];
}

/** Group articles by the agent's cluster key so same-event coverage collapses
 *  into one row, preserving the input order by primary. */
function clusterArticles(articles: ArticleRow[]): ArticleCluster[] {
  const clusters: ArticleCluster[] = [];
  const byKey = new Map<string, ArticleCluster>();
  for (const article of articles) {
    const key = article.clusterKey;
    if (!key) {
      clusters.push({ primary: article, others: [] });
      continue;
    }
    const existing = byKey.get(key);
    if (existing) {
      existing.others.push(article);
    } else {
      const cluster: ArticleCluster = { primary: article, others: [] };
      byKey.set(key, cluster);
      clusters.push(cluster);
    }
  }
  return clusters;
}

/** Render a briefing as portable markdown for the clipboard. */
function briefingToMarkdown(createdAt: string, tldr: string): string {
  const date = new Date(createdAt).toLocaleString();
  return `# News briefing — ${date}\n\n${tldr}\n`;
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

/** Minutes-after-midnight → "HH:MM" for a native time input ("" when unset). */
function minutesToHHMM(minutes: number | undefined): string {
  if (typeof minutes !== "number") return "";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** "3h ago" / "just now" / a date for older briefings. */
function agoLabel(iso: string): string {
  const age = relativeAge(iso);
  if (!age) return new Date(iso).toLocaleDateString();
  return age === "now" ? "just now" : `${age} ago`;
}

/** A site favicon with a graceful globe fallback. Derives the icon from the
 *  article's OWN origin (no third-party favicon service → no domain leak). */
function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = null;
  }
  if (!origin || failed) {
    return <GlobeIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />;
  }
  return (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      width={16}
      height={16}
      onError={() => setFailed(true)}
      style={{ flexShrink: 0, borderRadius: 3, objectFit: "contain" }}
    />
  );
}

/** Render a briefing TLDR / story blurb as markdown, reusing the chat's
 *  component mapping so the reader matches the embedded AgenticChat. */
function Markdown({ children }: { children: string }) {
  return (
    <div className="message-prose">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={markdownComponents as Components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface BriefingRow {
  briefingId: string;
  createdAt: string;
  status: string;
  tldr?: string;
  sourcesRead?: number;
}

interface Overview {
  setup: NewsSetupCardState;
  articleCount: number;
  unbriefedCount: number;
  untriagedCount?: number;
  lastBriefingId?: string;
}

interface DeepDiveStory {
  articleId: string;
  url: string;
  title: string;
  source?: string;
  briefingId?: string;
}

/** A model is "connected" when a stored credential matches its base URL. */
function modelHasMatchingCredential(
  baseUrl: string | undefined,
  audiences: UrlAudience[]
): boolean {
  if (!baseUrl?.trim() || /\{[^}]+\}/.test(baseUrl)) return false;
  try {
    return findMatchingUrlAudience(baseUrl, audiences) !== null;
  } catch {
    return false;
  }
}

/** Returns the provider/baseUrl to connect when the resolved model lacks a
 *  credential, or null when connected / undetectable (never blocks startup). */
async function detectMissingModelCredential(
  catalog: ModelCatalog,
  modelRef: string
): Promise<{ providerId: string; baseUrl: string } | null> {
  const entry = catalog.models.find((model) => model.ref === modelRef);
  if (!entry || !entry.connectable) return null;
  try {
    const creds = await rpc.call<Array<{ audience: UrlAudience[] }>>(
      "main",
      "credentials.listStoredCredentials",
      []
    );
    const audiences = creds.flatMap((cred) => cred.audience ?? []);
    if (modelHasMatchingCredential(entry.baseUrl, audiences)) return null;
    return { providerId: entry.provider, baseUrl: entry.baseUrl };
  } catch {
    return null;
  }
}

async function ensureAgentSubscribed(args: {
  agentKey: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
}): Promise<string> {
  const handle = await rpc.call<{ targetId: string }>("main", "runtime.createEntity", [
    {
      kind: "do",
      source: NEWS_AGENT_SOURCE,
      className: NEWS_AGENT_CLASS,
      key: args.agentKey,
      contextId: args.channelContextId,
    },
  ]);
  await rpc.call(handle.targetId, "subscribeChannel", [
    {
      channelId: args.channelId,
      contextId: args.channelContextId,
      config: { handle: NEWS_AGENT_HANDLE, ...(args.config ?? {}) },
      replay: true,
    },
  ]);
  return handle.targetId;
}

/** True when the panel is too narrow for the side-by-side reader+chat layout. */
function useNarrow(breakpoint = 720): boolean {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return narrow;
}

/** One story row: title + summary + source/age + actions (deep-dive, save,
 *  feedback, mark-read), plus an "also covered by" line for clustered coverage.
 *  Extracted so the feed, the Saved view, and search results share one row. */
function ArticleItem({
  article,
  others,
  busy,
  fresh,
  selected,
  innerRef,
  onDeepDive,
  onReact,
  onSetSaved,
  onMarkRead,
}: {
  article: ArticleRow;
  others: ArticleRow[];
  busy: boolean;
  fresh: boolean;
  selected: boolean;
  innerRef?: (el: HTMLDivElement | null) => void;
  onDeepDive: (article: ArticleRow) => void;
  onReact: (articleId: string, reaction: "more" | "less" | "mute_source") => void;
  onSetSaved: (articleId: string, saved: boolean) => void;
  onMarkRead: (articleId: string) => void;
}) {
  const age = relativeAge(article.publishedAt);
  return (
    <Box
      ref={innerRef}
      px="2"
      py="1"
      style={{
        opacity: article.read ? 0.55 : 1,
        borderRadius: "var(--radius-2)",
        boxShadow: selected ? "inset 0 0 0 1px var(--accent-8)" : undefined,
        background: selected ? "var(--accent-a2)" : undefined,
      }}
    >
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <Favicon url={article.url} />
          <Link
            href={article.url}
            target="_blank"
            rel="noreferrer"
            size="2"
            weight={article.read ? "regular" : "medium"}
            style={{ minWidth: 0, wordBreak: "break-word" }}
            onClick={() => onMarkRead(article.articleId)}
          >
            {article.title}
          </Link>
          {fresh ? (
            <Badge size="1" color="blue" variant="soft" style={{ flexShrink: 0 }}>
              New
            </Badge>
          ) : null}
        </Flex>
        {article.blurb ? (
          <Text size="1" color="gray" style={{ wordBreak: "break-word" }}>
            {article.blurb}
          </Text>
        ) : null}
        {others.length > 0 ? (
          <Text size="1" color="gray">
            also covered by{" "}
            {others.map((other, index) => (
              <span key={other.articleId}>
                {index > 0 ? ", " : ""}
                <Link
                  href={other.url}
                  target="_blank"
                  rel="noreferrer"
                  size="1"
                  onClick={() => onMarkRead(other.articleId)}
                >
                  {other.source}
                </Link>
              </span>
            ))}
          </Text>
        ) : null}
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="1" color="gray">
            {article.source}
            {age ? ` · ${age}` : ""}
          </Text>
          <Button size="1" variant="soft" disabled={busy} onClick={() => onDeepDive(article)}>
            Deep-dive
          </Button>
          <IconButton
            size="1"
            variant="ghost"
            color={article.saved ? "amber" : "gray"}
            title={article.saved ? "Saved — click to remove" : "Save for later"}
            aria-label="Save for later"
            onClick={() => onSetSaved(article.articleId, !article.saved)}
          >
            {article.saved ? <StarFilledIcon /> : <StarIcon />}
          </IconButton>
          <IconButton
            size="1"
            variant="ghost"
            color="grass"
            title="More like this"
            aria-label="More like this"
            onClick={() => onReact(article.articleId, "more")}
          >
            <ThickArrowUpIcon />
          </IconButton>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            title="Less like this"
            aria-label="Less like this"
            onClick={() => onReact(article.articleId, "less")}
          >
            <ThickArrowDownIcon />
          </IconButton>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            title={`Mute ${article.source}`}
            aria-label={`Mute ${article.source}`}
            onClick={() => onReact(article.articleId, "mute_source")}
          >
            <EyeNoneIcon />
          </IconButton>
          {!article.read ? (
            <Button
              size="1"
              variant="ghost"
              disabled={busy}
              onClick={() => onMarkRead(article.articleId)}
            >
              Mark read
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Box>
  );
}

export default function NewsPanel() {
  const theme = usePanelTheme();
  const stateArgs = panel.stateArgs.use<NewsStateArgs>();
  const resolvedContextId = resolveNewsContextId(stateArgs.contextId, runtimeContextId);

  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [agentTarget, setAgentTarget] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [briefings, setBriefings] = useState<BriefingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedDraft, setFeedDraft] = useState("");
  const [modelConnect, setModelConnect] = useState<{ providerId: string; baseUrl: string } | null>(
    null
  );
  const [connecting, setConnecting] = useState(false);
  const [view, setView] = useState<FeedView>("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [pastOpen, setPastOpen] = useState(false);
  const [savedArticles, setSavedArticles] = useState<ArticleRow[]>([]);
  const [pendingArticles, setPendingArticles] = useState<ArticleRow[]>([]);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<"reader" | "chat">("reader");
  const narrow = useNarrow();
  const selectedRowRef = useRef<HTMLDivElement | null>(null);
  const triageInFlightRef = useRef(false);
  const lastSeenEventId = useRef(0);
  const latestTldrRef = useRef<string | undefined>(undefined);
  const bootstrapAttempted = useRef(false);
  const modelServiceRef = useRef<DurableObjectServiceClient | null>(null);
  const modelProbeRef = useRef<{ catalog: ModelCatalog; modelRef: string } | null>(null);
  // Snapshot the last-visit time at mount; articles fetched after it are "new".
  // 0 (first ever visit) means "don't badge everything", so isNew requires > 0.
  const previousVisitRef = useRef<number>(
    typeof stateArgs.lastVisitAt === "number" ? stateArgs.lastVisitAt : 0
  );

  const channelName = stateArgs.channelName ?? bootstrapChannel;

  // Stamp this visit so the next open can mark what's arrived since.
  useEffect(() => {
    void panel.stateArgs.set({ lastVisitAt: Date.now() });
  }, []);

  // ── bootstrap: mint channel + agent, resolve model, ensure-subscribe ──────
  useEffect(() => {
    if (!resolvedContextId || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    void (async () => {
      try {
        // Identity is a deterministic function of the panel's contextId, so a
        // reload that lost its stateArgs still re-resolves the same reader.
        // stateArgs stays as a fast-path cache (and keeps any pre-existing
        // random-keyed reader attached).
        const channel = stateArgs.channelName ?? newsChannelName(resolvedContextId);
        const agentKey = stateArgs.agentKey ?? newsAgentKey(resolvedContextId);
        if (!stateArgs.channelName || !stateArgs.agentKey) {
          void panel.stateArgs.set({
            channelName: channel,
            agentKey,
            contextId: resolvedContextId,
          });
        }
        if (!stateArgs.channelName) setBootstrapChannel(channel);

        // Honor the workspace-configured model like the chat panel does.
        modelServiceRef.current ??= createDurableObjectServiceClient(
          MODEL_SETTINGS_SERVICE_PROTOCOL
        );
        let settings: ModelSettingsSnapshot | null = null;
        try {
          settings = await modelServiceRef.current.call<ModelSettingsSnapshot>("getSettings");
        } catch (err) {
          console.warn("[NewsPanel] Failed to load model settings:", err);
        }
        const model =
          (stateArgs.agentConfig?.["model"] as string | undefined) ??
          settings?.defaultModel ??
          DEFAULT_AGENT_MODEL_REF;

        const targetId = await ensureAgentSubscribed({
          agentKey,
          channelId: channel,
          channelContextId: resolvedContextId,
          config: { model, ...(stateArgs.agentConfig ?? {}) },
        });
        setAgentTarget(targetId);

        // Nudge the user to connect a model if the agent's turns would stall.
        // Stash the catalog so refresh() can re-reconcile (the credential may
        // be connected later, e.g. by the agent's own recovery flow).
        if (settings?.catalog) {
          modelProbeRef.current = { catalog: settings.catalog, modelRef: model };
          setModelConnect(await detectMissingModelCredential(settings.catalog, model));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [resolvedContextId, stateArgs.agentConfig, stateArgs.agentKey, stateArgs.channelName]);

  const handleConnectModel = useCallback(async () => {
    if (!modelConnect) return;
    setConnecting(true);
    setError(null);
    try {
      const request = toPanelConnectRequest(modelConnect.providerId, modelConnect.baseUrl);
      if (!request) {
        setError(`No connect flow available for ${modelConnect.providerId}`);
        return;
      }
      await rpc.call("main", "credentials.connect", [request]);
      setModelConnect(null);
    } catch (err) {
      setError(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(false);
    }
  }, [modelConnect]);

  // ── reader data ────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!agentTarget || !channelName) return;
    try {
      const [nextOverview, articleList, history] = await Promise.all([
        rpc.call<Overview>(agentTarget, "getOverview", [channelName, {}]),
        rpc.call<{ articles: ArticleRow[] }>(agentTarget, "listArticles", [
          channelName,
          { limit: 60, triagedOnly: true },
        ]),
        rpc.call<{ briefings: BriefingRow[] }>(agentTarget, "briefingHistory", [
          channelName,
          { limit: 12 },
        ]),
      ]);
      setOverview(nextOverview);
      setArticles(articleList.articles);
      setBriefings(history.briefings);
      latestTldrRef.current = history.briefings.find(
        (briefing) => briefing.status === "ready" && briefing.tldr
      )?.tldr;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    // Reconcile the connect nudge against current credentials so a model that
    // gets connected later clears the banner without a reload. Only flip state
    // when connectedness actually changes, to avoid re-render churn.
    const probe = modelProbeRef.current;
    if (probe) {
      try {
        const next = await detectMissingModelCredential(probe.catalog, probe.modelRef);
        setModelConnect((prev) => {
          if (prev === null && next === null) return prev;
          if (
            prev &&
            next &&
            prev.providerId === next.providerId &&
            prev.baseUrl === next.baseUrl
          ) {
            return prev;
          }
          return next;
        });
      } catch {
        // leave the existing nudge state untouched on a transient failure
      }
    }
  }, [agentTarget, channelName]);

  useEffect(() => {
    if (!agentTarget) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(timer);
  }, [agentTarget, refresh]);

  // ── lightweight agent calls (no busy/refresh churn) + optimistic updates ──
  const quietAgentCall = useCallback(
    (method: string, args: Record<string, unknown>) => {
      if (!agentTarget || !channelName) return;
      void rpc
        .call(agentTarget, method, [channelName, args])
        .catch((err) => console.warn(`[NewsPanel] ${method} failed:`, err));
    },
    [agentTarget, channelName]
  );

  /** Apply an optimistic patch to a story across every list it may appear in
   *  (the feed, the Saved view, and search results). */
  const patchArticle = useCallback((articleId: string, patch: Partial<ArticleRow>) => {
    const apply = (list: ArticleRow[]) =>
      list.map((article) => (article.articleId === articleId ? { ...article, ...patch } : article));
    setArticles(apply);
    setSavedArticles(apply);
    setSearchResults((prev) => (prev ? { ...prev, articles: apply(prev.articles) } : prev));
  }, []);

  const markReadLocal = useCallback(
    (articleId: string) => {
      patchArticle(articleId, { read: true });
      quietAgentCall("markRead", { articleIds: [articleId] });
    },
    [patchArticle, quietAgentCall]
  );

  const setSavedLocal = useCallback(
    (articleId: string, saved: boolean) => {
      patchArticle(articleId, { saved });
      if (!saved) setSavedArticles((prev) => prev.filter((a) => a.articleId !== articleId));
      quietAgentCall("setSaved", { articleId, saved });
    },
    [patchArticle, quietAgentCall]
  );

  /** Reader feedback tap. "less"/"mute" also drop the story from view at once. */
  const reactToStory = useCallback(
    (articleId: string, reaction: "more" | "less" | "mute_source") => {
      if (reaction !== "more") patchArticle(articleId, { read: true });
      quietAgentCall("reactToStory", { articleId, reaction });
    },
    [patchArticle, quietAgentCall]
  );

  /** Copy a briefing to the clipboard as portable markdown. */
  const exportBriefing = useCallback((id: string, createdAt: string, tldr: string) => {
    void navigator.clipboard?.writeText(briefingToMarkdown(createdAt, tldr)).then(
      () => {
        setCopiedId(id);
        setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
      },
      (err) => console.warn("[NewsPanel] copy failed:", err)
    );
  }, []);

  // ── deep-dive: fork the channel into a per-story analysis chat ────────────
  const handleDeepDive = useCallback(
    async (story: DeepDiveStory) => {
      if (!channelName || !resolvedContextId) return;
      // Opening a story to dig in counts as reading it.
      markReadLocal(story.articleId);
      setBusy(true);
      setError(null);
      try {
        const result = await fork(
          {
            rpc: {
              call: <T,>(target: string, method: string, args: unknown[]) =>
                rpc.call<T>(target, method, args),
            } as never,
            callMain: <T,>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, args),
          },
          { channelId: channelName, forkPointPubsubId: lastSeenEventId.current }
        );
        const agent =
          result.clonedAgents.find((entry) => entry.className === NEWS_AGENT_CLASS) ??
          result.clonedAgents[0];
        if (agent) {
          // Seed the analyst's opening turn directly on the clone (reliable —
          // agent-initiated, so it bypasses the chat's history-suppression).
          try {
            await rpc.call(
              `do:${agent.source}:${agent.className}:${agent.objectKey}`,
              "startDeepDive",
              [
                result.forkedChannelId,
                {
                  articleId: story.articleId,
                  url: story.url,
                  title: story.title,
                  source: story.source,
                  briefingTldr: latestTldrRef.current,
                },
              ]
            );
          } catch (err) {
            console.warn("[NewsPanel] startDeepDive failed:", err);
          }
        }
        await openPanel("panels/chat", {
          name: `Deep-dive: ${story.title.slice(0, 40)}`,
          focus: true,
          stateArgs: {
            channelName: result.forkedChannelId,
            contextId: resolvedContextId,
            // Surface the news agent in the deep-dive chat (mentions + launcher).
            ...(agent
              ? {
                  installedAgents: [
                    {
                      agentId: agent.className,
                      handle: NEWS_AGENT_HANDLE,
                      key: agent.objectKey,
                      source: agent.source,
                      className: agent.className,
                    },
                  ],
                }
              : {}),
          },
        });
      } catch (err) {
        setError(`deep-dive failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [channelName, resolvedContextId, markReadLocal]
  );

  // ── channel listener: live refresh + card-initiated deep-dive signals ─────
  useEffect(() => {
    if (!channelName || !resolvedContextId) return;
    const client = connectViaRpc({
      rpc,
      channel: channelName,
      contextId: resolvedContextId,
      clientId: `${rpc.selfId}:reader`,
      name: "News reader",
      type: "panel",
      handle: "news-reader",
      replayMode: "skip",
    });
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, 750);
    };
    void (async () => {
      try {
        await client.ready();
        for await (const event of client.events()) {
          if (cancelled) break;
          const id = (event as { id?: number }).id;
          if (typeof id === "number" && id > lastSeenEventId.current) {
            lastSeenEventId.current = id;
          }
          if (event.type === "signal") {
            const payload = parseSignalEvent<NewsDeepDiveRequested>(
              event as { content: string; contentType?: string },
              NEWS_DEEPDIVE_SIGNAL
            );
            if (payload) {
              void handleDeepDive(payload);
              continue;
            }
          }
          scheduleRefresh();
        }
      } catch (err) {
        if (!cancelled) console.warn("[NewsPanel] channel listener stopped:", err);
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      void client.close?.();
    };
  }, [channelName, resolvedContextId, handleDeepDive, refresh]);

  const callAgent = useCallback(
    async (method: string, args: Record<string, unknown>) => {
      if (!agentTarget || !channelName) return;
      setBusy(true);
      setError(null);
      try {
        await rpc.call(agentTarget, method, [channelName, args]);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [agentTarget, channelName, refresh]
  );

  const config: ConnectionConfig = useMemo(
    () => ({ clientId: rpc.selfId, rpc, recoveryCoordinator }),
    []
  );
  const sandboxConfig = useMemo(() => createPanelSandboxConfig(rpc), []);
  const installedAgents = useMemo(
    () => [{ agentId: NEWS_AGENT_CLASS, handle: NEWS_AGENT_HANDLE }],
    []
  );

  // On-demand triage: when the reader has a backlog of un-triaged items, ask the
  // agent to categorize/cluster/summarize them. Fired once per backlog (the flag
  // resets when the count returns to 0), so refreshes don't spam triage turns.
  useEffect(() => {
    const pending = overview?.untriagedCount ?? 0;
    if (pending === 0) {
      triageInFlightRef.current = false;
      return;
    }
    if (triageInFlightRef.current || !agentTarget || !channelName) return;
    triageInFlightRef.current = true;
    void rpc
      .call(agentTarget, "triageNow", [channelName, {}])
      .catch((err) => console.warn("[NewsPanel] triageNow failed:", err));
  }, [overview?.untriagedCount, agentTarget, channelName]);

  // Peek at the un-triaged backlog when the "Categorizing…" disclosure is open,
  // so an impatient reader can click through before the agent finishes. Re-fetch
  // as the count shrinks (triage processes items).
  useEffect(() => {
    if (!pendingOpen || !agentTarget || !channelName) return;
    if ((overview?.untriagedCount ?? 0) === 0) {
      setPendingArticles([]);
      return;
    }
    let cancelled = false;
    void rpc
      .call<{ articles: ArticleRow[] }>(agentTarget, "listArticles", [
        channelName,
        { untriagedOnly: true, limit: 50 },
      ])
      .then((res) => {
        if (!cancelled) setPendingArticles(res.articles);
      })
      .catch((err) => console.warn("[NewsPanel] pending fetch failed:", err));
    return () => {
      cancelled = true;
    };
  }, [pendingOpen, overview?.untriagedCount, agentTarget, channelName]);

  // Saved view: fetch on demand (saved items can be older than the feed window).
  useEffect(() => {
    if (view !== "saved" || !agentTarget || !channelName) return;
    let cancelled = false;
    void rpc
      .call<{ articles: ArticleRow[] }>(agentTarget, "listArticles", [
        channelName,
        { savedOnly: true, limit: 200 },
      ])
      .then((res) => {
        if (!cancelled) setSavedArticles(res.articles);
      })
      .catch((err) => console.warn("[NewsPanel] saved fetch failed:", err));
    return () => {
      cancelled = true;
    };
  }, [view, agentTarget, channelName]);

  // Archive search: debounced; empty query clears results back to the feed.
  useEffect(() => {
    const query = searchInput.trim();
    if (!query || !agentTarget || !channelName) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void rpc
        .call<SearchResults>(agentTarget, "searchArchive", [channelName, { query, limit: 60 }])
        .then((res) => {
          if (!cancelled) setSearchResults(res);
        })
        .catch((err) => console.warn("[NewsPanel] search failed:", err));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchInput, agentTarget, channelName]);

  // The list the reader is showing right now (search > saved > feed), with the
  // source filter applied, grouped into same-event clusters and then into the
  // agent's category sections. `flatRows` is the render+selection order.
  const searching = searchInput.trim().length > 0;
  const flatRows = useMemo(() => {
    const base = searching
      ? (searchResults?.articles ?? [])
      : view === "saved"
        ? savedArticles
        : articles.filter((article) => view !== "unread" || !article.read);
    const filtered = sourceFilter
      ? base.filter((article) => article.source === sourceFilter)
      : base;
    const clusters = clusterArticles(filtered);
    // Group clusters by category, category order = first appearance (≈ recency).
    const byCategory = new Map<string, ArticleCluster[]>();
    const order: string[] = [];
    for (const cluster of clusters) {
      const category = cluster.primary.category?.trim() || "Other";
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
        order.push(category);
      }
      byCategory.get(category)!.push(cluster);
    }
    const rows: Array<{ cluster: ArticleCluster; category: string; sectionStart: boolean }> = [];
    for (const category of order) {
      byCategory.get(category)!.forEach((cluster, index) => {
        rows.push({ cluster, category, sectionStart: index === 0 });
      });
    }
    return rows;
  }, [searching, searchResults, view, savedArticles, articles, sourceFilter]);
  const selectable = useMemo(() => flatRows.map((row) => row.cluster.primary), [flatRows]);

  // Reset + keep the keyboard selection in range as the visible list changes.
  useEffect(() => setSelectedIndex(0), [view, searchInput, sourceFilter]);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Reader keyboard shortcuts (ignored while typing or when the chat pane shows).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (narrow && mobilePane !== "reader") return;
      if (selectable.length === 0) return;
      const current = selectable[Math.min(selectedIndex, selectable.length - 1)];
      switch (event.key) {
        case "j":
          setSelectedIndex((index) => Math.min(index + 1, selectable.length - 1));
          break;
        case "k":
          setSelectedIndex((index) => Math.max(index - 1, 0));
          break;
        case "o":
          if (current) {
            window.open(current.url, "_blank", "noopener");
            markReadLocal(current.articleId);
          }
          break;
        case "s":
          if (current) setSavedLocal(current.articleId, !current.saved);
          break;
        case "m":
          if (current) markReadLocal(current.articleId);
          break;
        case "d":
          if (current) void handleDeepDive(current);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectable, selectedIndex, narrow, mobilePane, markReadLocal, setSavedLocal, handleDeepDive]);

  if (!channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
            <Spinner />
            <Text size="2" color="gray">
              Starting news…
            </Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  const feeds = overview?.setup.feeds ?? [];
  const topics = overview?.setup.followedTopics ?? [];
  const existingFeedUrls = new Set(feeds.map((feed) => feed.url));
  const existingTopics = new Set(topics.map((topic) => topic.topic.toLowerCase()));
  const hasSources = feeds.length > 0 || topics.length > 0;
  const failingFeeds = feeds.filter((feed) => feed.failCount > 0);

  const latestBriefing = briefings[0];
  const preparing =
    latestBriefing?.status === "summarizing" || latestBriefing?.status === "collecting";
  const readyBriefings = briefings.filter(
    (briefing) => briefing.status === "ready" && briefing.tldr
  );
  const latestReady = readyBriefings[0];
  const pastReady = readyBriefings.slice(1);

  // A completed briefing is hard proof the model resolved a credential and ran,
  // so never nag to "connect a model" once one exists — the client-side
  // credential probe can false-negative (e.g. OAuth providers like openai-codex
  // whose stored audience doesn't path-match the catalog baseUrl).
  const modelProvenWorking = readyBriefings.length > 0 || Boolean(overview?.lastBriefingId);
  const showConnectNudge = Boolean(modelConnect) && !modelProvenWorking;

  const sources = [...new Set(articles.map((article) => article.source))].sort();
  const unreadIds = articles.filter((article) => !article.read).map((article) => article.articleId);
  // "New since your last visit": arrived after the snapshotted visit time. The
  // 0 guard avoids badging the entire feed on a first-ever visit.
  const previousVisit = previousVisitRef.current;
  const isNewSinceVisit = (article: ArticleRow): boolean =>
    previousVisit > 0 && typeof article.fetchedAt === "number" && article.fetchedAt > previousVisit;
  const newCount = articles.filter(isNewSinceVisit).length;
  const searchBriefings = searchResults?.briefings ?? [];

  return (
    <ErrorBoundary>
      <Theme appearance={theme}>
        <Flex direction="column" style={{ height: "100dvh" }}>
          {/* On narrow panels the two panes don't fit side by side — toggle. */}
          {narrow ? (
            <Flex p="2" justify="center" style={{ borderBottom: "1px solid var(--gray-a5)" }}>
              <SegmentedControl.Root
                size="1"
                value={mobilePane}
                onValueChange={(value) => setMobilePane(value as "reader" | "chat")}
              >
                <SegmentedControl.Item value="reader">📰 Reader</SegmentedControl.Item>
                <SegmentedControl.Item value="chat">💬 Chat</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>
          ) : null}
          <Flex style={{ flex: 1, minHeight: 0 }}>
            {/* ── reader region ── */}
            {!narrow || mobilePane === "reader" ? (
              <Flex
                direction="column"
                style={{ flex: narrow ? "1 1 auto" : "1 1 55%", minWidth: 0 }}
              >
                <Flex align="center" gap="2" p="3">
                  <Text size="3" weight="bold">
                    📰 News
                  </Text>
                  {overview ? (
                    <Badge size="1" color="gray">
                      {overview.articleCount} articles · {overview.unbriefedCount} unbriefed
                    </Badge>
                  ) : null}
                  {failingFeeds.length > 0 ? (
                    <Badge
                      size="1"
                      color="red"
                      title={failingFeeds.map((feed) => feed.title ?? feed.url).join("\n")}
                    >
                      <ExclamationTriangleIcon /> {failingFeeds.length} feed
                      {failingFeeds.length > 1 ? "s" : ""} failing
                    </Badge>
                  ) : null}
                  <Box flexGrow="1" />
                  <Button
                    size="1"
                    variant="soft"
                    disabled={busy || !agentTarget}
                    onClick={() => void callAgent("refreshNow", {})}
                  >
                    <ReloadIcon /> Refresh
                  </Button>
                  <Button
                    size="1"
                    disabled={busy || !agentTarget}
                    onClick={() => void callAgent("refreshNow", { briefing: true })}
                  >
                    <LightningBoltIcon /> Brief me now
                  </Button>
                </Flex>
                {overview ? (
                  <Text size="1" color="gray" style={{ paddingLeft: "var(--space-3)" }}>
                    {overview.setup.scheduleSummary}
                  </Text>
                ) : null}
                {error ? (
                  <Text size="1" color="red" style={{ padding: "0 var(--space-3)" }}>
                    {error}
                  </Text>
                ) : null}

                {showConnectNudge && modelConnect ? (
                  <Box px="3" pt="2">
                    <Callout.Root color="amber" size="1">
                      <Callout.Icon>
                        <ExclamationTriangleIcon />
                      </Callout.Icon>
                      <Callout.Text>
                        <Flex align="center" gap="3" wrap="wrap">
                          <Text size="1">
                            Connect <Text weight="medium">{modelConnect.providerId}</Text> to enable
                            briefings and chat.
                          </Text>
                          <Button
                            size="1"
                            disabled={connecting}
                            onClick={() => void handleConnectModel()}
                          >
                            {connecting ? <Spinner size="1" /> : null} Connect model
                          </Button>
                        </Flex>
                      </Callout.Text>
                    </Callout.Root>
                  </Box>
                ) : null}

                <Separator size="4" my="2" />
                <ScrollArea style={{ flex: 1 }}>
                  <Flex direction="column" gap="3" p="3" pt="0">
                    {overview && hasSources ? (
                      <ReaderSettings
                        setup={overview.setup}
                        busy={busy}
                        callAgent={(method, args) => void callAgent(method, args)}
                      />
                    ) : null}

                    {(overview?.untriagedCount ?? 0) > 0 ? (
                      <Box>
                        <Flex align="center" gap="1">
                          <Spinner size="1" />
                          <Button
                            size="1"
                            variant="ghost"
                            onClick={() => setPendingOpen((open) => !open)}
                          >
                            {pendingOpen ? "▾" : "▸"} Categorizing {overview?.untriagedCount} new
                            stor
                            {overview?.untriagedCount === 1 ? "y" : "ies"}…
                          </Button>
                        </Flex>
                        {pendingOpen ? (
                          <Flex direction="column" gap="2" pt="2" pl="3">
                            {pendingArticles.length === 0 ? (
                              <Text size="1" color="gray">
                                Loading…
                              </Text>
                            ) : (
                              pendingArticles.map((article) => {
                                const age = relativeAge(article.publishedAt);
                                return (
                                  <Flex
                                    key={article.articleId}
                                    direction="column"
                                    gap="1"
                                    style={{ opacity: article.read ? 0.55 : 1 }}
                                  >
                                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                                      <Favicon url={article.url} />
                                      <Link
                                        href={article.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        size="2"
                                        style={{ minWidth: 0, wordBreak: "break-word" }}
                                        onClick={() => {
                                          markReadLocal(article.articleId);
                                          setPendingArticles((prev) =>
                                            prev.filter(
                                              (item) => item.articleId !== article.articleId
                                            )
                                          );
                                        }}
                                      >
                                        {article.title}
                                      </Link>
                                    </Flex>
                                    <Text size="1" color="gray">
                                      {article.source}
                                      {age ? ` · ${age}` : ""} · not yet categorized
                                    </Text>
                                    {article.blurb ? (
                                      <Text
                                        size="1"
                                        color="gray"
                                        style={{ wordBreak: "break-word" }}
                                      >
                                        {article.blurb}
                                      </Text>
                                    ) : null}
                                  </Flex>
                                );
                              })
                            )}
                          </Flex>
                        ) : null}
                      </Box>
                    ) : null}

                    {preparing ? (
                      <Card variant="surface">
                        <Flex align="center" gap="2">
                          <Spinner size="2" />
                          <Flex direction="column">
                            <Text size="2" weight="medium">
                              Preparing your briefing…
                            </Text>
                            <Text size="1" color="gray">
                              Scanning sources and writing your digest.
                            </Text>
                          </Flex>
                        </Flex>
                      </Card>
                    ) : null}

                    {latestReady?.tldr ? (
                      <Flex direction="column" gap="1">
                        <Flex align="center" gap="2">
                          <Text
                            size="1"
                            weight="bold"
                            color="gray"
                            title={new Date(latestReady.createdAt).toLocaleString()}
                          >
                            LATEST BRIEFING · {agoLabel(latestReady.createdAt)}
                            {latestReady.sourcesRead
                              ? ` · synthesized from ${latestReady.sourcesRead} source${latestReady.sourcesRead > 1 ? "s" : ""}`
                              : ""}
                          </Text>
                          <IconButton
                            size="1"
                            variant="ghost"
                            color={copiedId === latestReady.briefingId ? "green" : "gray"}
                            title="Copy briefing as markdown"
                            aria-label="Copy briefing"
                            onClick={() =>
                              exportBriefing(
                                latestReady.briefingId,
                                latestReady.createdAt,
                                latestReady.tldr ?? ""
                              )
                            }
                          >
                            {copiedId === latestReady.briefingId ? <CheckIcon /> : <CopyIcon />}
                          </IconButton>
                        </Flex>
                        <Markdown>{latestReady.tldr}</Markdown>
                      </Flex>
                    ) : null}

                    {pastReady.length > 0 ? (
                      <Box>
                        <Button
                          size="1"
                          variant="ghost"
                          onClick={() => setPastOpen((open) => !open)}
                        >
                          {pastOpen ? "▾" : "▸"} Past briefings ({pastReady.length})
                        </Button>
                        {pastOpen ? (
                          <Flex direction="column" gap="2" pt="2">
                            {pastReady.map((briefing) => (
                              <Flex key={briefing.briefingId} direction="column" gap="1">
                                <Flex align="center" gap="2">
                                  <Text
                                    size="1"
                                    weight="bold"
                                    color="gray"
                                    title={new Date(briefing.createdAt).toLocaleString()}
                                  >
                                    {agoLabel(briefing.createdAt)}
                                    {briefing.sourcesRead
                                      ? ` · ${briefing.sourcesRead} sources`
                                      : ""}
                                  </Text>
                                  {briefing.tldr ? (
                                    <IconButton
                                      size="1"
                                      variant="ghost"
                                      color={copiedId === briefing.briefingId ? "green" : "gray"}
                                      title="Copy briefing as markdown"
                                      aria-label="Copy briefing"
                                      onClick={() =>
                                        exportBriefing(
                                          briefing.briefingId,
                                          briefing.createdAt,
                                          briefing.tldr ?? ""
                                        )
                                      }
                                    >
                                      {copiedId === briefing.briefingId ? (
                                        <CheckIcon />
                                      ) : (
                                        <CopyIcon />
                                      )}
                                    </IconButton>
                                  ) : null}
                                </Flex>
                                {briefing.tldr ? <Markdown>{briefing.tldr}</Markdown> : null}
                              </Flex>
                            ))}
                          </Flex>
                        ) : null}
                      </Box>
                    ) : null}

                    {latestReady || pastReady.length > 0 || articles.length > 0 ? (
                      <Separator size="4" my="1" />
                    ) : null}

                    {articles.length > 0 ? (
                      <Flex direction="column" gap="2">
                        <Flex align="center" gap="2" wrap="wrap">
                          <SegmentedControl.Root
                            size="1"
                            value={view}
                            onValueChange={(value) => setView(value as FeedView)}
                          >
                            <SegmentedControl.Item value="all">All</SegmentedControl.Item>
                            <SegmentedControl.Item value="unread">Unread</SegmentedControl.Item>
                            <SegmentedControl.Item value="saved">Saved</SegmentedControl.Item>
                          </SegmentedControl.Root>
                          {newCount > 0 && !searching ? (
                            <Badge size="1" color="blue" variant="soft">
                              {newCount} new since last visit
                            </Badge>
                          ) : null}
                          {sources.length > 1 && !searching && view !== "saved" ? (
                            <Select.Root
                              size="1"
                              value={sourceFilter || "__all"}
                              onValueChange={(value) =>
                                setSourceFilter(value === "__all" ? "" : value)
                              }
                            >
                              <Select.Trigger placeholder="All sources" variant="soft" />
                              <Select.Content>
                                <Select.Item value="__all">All sources</Select.Item>
                                {sources.map((source) => (
                                  <Select.Item key={source} value={source}>
                                    {source}
                                  </Select.Item>
                                ))}
                              </Select.Content>
                            </Select.Root>
                          ) : null}
                          <Box flexGrow="1" />
                          {unreadIds.length > 0 ? (
                            <Button
                              size="1"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void callAgent("markRead", { articleIds: unreadIds.slice(0, 200) })
                              }
                            >
                              Mark all read
                            </Button>
                          ) : null}
                        </Flex>
                        <TextField.Root
                          size="1"
                          placeholder="Search your news…"
                          value={searchInput}
                          onChange={(event) => setSearchInput(event.target.value)}
                        >
                          <TextField.Slot>
                            <MagnifyingGlassIcon />
                          </TextField.Slot>
                          {searchInput ? (
                            <TextField.Slot side="right">
                              <IconButton
                                size="1"
                                variant="ghost"
                                color="gray"
                                title="Clear search"
                                aria-label="Clear search"
                                onClick={() => setSearchInput("")}
                              >
                                <Cross2Icon />
                              </IconButton>
                            </TextField.Slot>
                          ) : null}
                        </TextField.Root>
                      </Flex>
                    ) : null}

                    {searching && searchBriefings.length > 0 ? (
                      <Flex direction="column" gap="2">
                        <Text size="1" weight="bold" color="gray">
                          BRIEFINGS MENTIONING “{searchInput.trim()}”
                        </Text>
                        {searchBriefings.map((briefing) => (
                          <Flex key={briefing.briefingId} direction="column" gap="1">
                            <Text
                              size="1"
                              color="gray"
                              title={new Date(briefing.createdAt).toLocaleString()}
                            >
                              {agoLabel(briefing.createdAt)}
                            </Text>
                            {briefing.tldr ? <Markdown>{briefing.tldr}</Markdown> : null}
                          </Flex>
                        ))}
                        <Separator size="4" my="1" />
                      </Flex>
                    ) : null}

                    {flatRows.map((row, index) => (
                      <Fragment key={row.cluster.primary.articleId}>
                        {row.sectionStart ? (
                          <Text
                            size="1"
                            weight="bold"
                            color="gray"
                            style={{ marginTop: index > 0 ? "var(--space-3)" : 0 }}
                          >
                            {row.category.toUpperCase()}
                          </Text>
                        ) : null}
                        <ArticleItem
                          article={row.cluster.primary}
                          others={row.cluster.others}
                          busy={busy}
                          fresh={isNewSinceVisit(row.cluster.primary)}
                          selected={index === selectedIndex}
                          innerRef={
                            index === selectedIndex
                              ? (el) => {
                                  selectedRowRef.current = el;
                                }
                              : undefined
                          }
                          onDeepDive={(item) => void handleDeepDive(item)}
                          onReact={reactToStory}
                          onSetSaved={setSavedLocal}
                          onMarkRead={markReadLocal}
                        />
                      </Fragment>
                    ))}

                    {flatRows.length === 0 && (searching || view === "saved" || hasSources) ? (
                      <Text size="2" color="gray">
                        {searching
                          ? "No matches in your news."
                          : view === "saved"
                            ? "No saved stories yet — tap the ☆ on any story to keep it here."
                            : (overview?.untriagedCount ?? 0) > 0
                              ? "Your latest stories are being categorized…"
                              : sourceFilter
                                ? "No stories match this filter."
                                : "No stories yet — hit Refresh, or wait for your next briefing."}
                      </Text>
                    ) : null}

                    {!hasSources && !searching && view !== "saved" && overview ? (
                      <QuickStart
                        busy={busy}
                        hasSources={hasSources}
                        scheduleSummary={overview.setup.scheduleSummary}
                        existingFeedUrls={existingFeedUrls}
                        existingTopics={existingTopics}
                        feedDraft={feedDraft}
                        onFeedDraft={setFeedDraft}
                        onAddFeed={(url) => void callAgent("addFeed", { url })}
                        onFollowTopic={(topic) => void callAgent("followTopic", { topic })}
                        onImportOpml={(opml) => void callAgent("importOpml", { opml })}
                      />
                    ) : null}
                  </Flex>
                </ScrollArea>
              </Flex>
            ) : null}

            {!narrow ? <Separator orientation="vertical" size="4" /> : null}

            {/* ── embedded agentic chat ── */}
            {!narrow || mobilePane === "chat" ? (
              <Box style={{ flex: narrow ? "1 1 auto" : "1 1 45%", minWidth: 0 }}>
                <AgenticChat
                  config={config}
                  channelName={channelName}
                  contextId={resolvedContextId}
                  theme={theme}
                  installedAgents={installedAgents}
                  sandbox={sandboxConfig}
                />
              </Box>
            ) : null}
          </Flex>
        </Flex>
      </Theme>
    </ErrorBoundary>
  );
}

/** Always-available, collapsible view of the reader's persisted configuration
 *  — preferences, feeds, and followed topics — fed by overview.setup (which the
 *  agent DO persists). Keeps your curation visible and editable in the reader
 *  itself, not only in the chat setup card, so it survives any reload. */
function ReaderSettings({
  setup,
  busy,
  callAgent,
}: {
  setup: NewsSetupCardState;
  busy: boolean;
  callAgent: (method: string, args: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [prefsDraft, setPrefsDraft] = useState<string | null>(null);
  const feeds = setup.feeds ?? [];
  const topics = setup.followedTopics ?? [];
  const prefsDirty = prefsDraft !== null && prefsDraft !== (setup.preferencesText ?? "");
  return (
    <Box>
      <Button size="1" variant="ghost" onClick={() => setOpen((value) => !value)}>
        <GearIcon /> {open ? "▾" : "▸"} Sources & preferences
        <Text size="1" color="gray">
          · {feeds.length} feed{feeds.length === 1 ? "" : "s"} · {topics.length} topic
          {topics.length === 1 ? "" : "s"}
        </Text>
      </Button>
      {open ? (
        <Flex direction="column" gap="3" pt="2">
          <Flex direction="column" gap="1">
            <Text size="1" weight="bold" color="gray">
              PREFERENCES
            </Text>
            <Flex gap="2">
              <TextField.Root
                size="1"
                placeholder="e.g. more open source, less crypto, terse blurbs"
                value={prefsDraft ?? setup.preferencesText ?? ""}
                onChange={(event) => setPrefsDraft(event.target.value)}
                style={{ flex: 1 }}
              />
              {prefsDirty ? (
                <Button
                  size="1"
                  disabled={busy}
                  onClick={() => {
                    callAgent("setPreferences", { text: prefsDraft ?? "" });
                    setPrefsDraft(null);
                  }}
                >
                  Save
                </Button>
              ) : null}
            </Flex>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" weight="bold" color="gray">
              FEEDS
            </Text>
            {feeds.map((feed) => (
              <Flex key={feed.feedId} align="center" gap="2" style={{ minWidth: 0 }}>
                <Switch
                  size="1"
                  checked={feed.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    callAgent("setFeedEnabled", { feedId: feed.feedId, enabled })
                  }
                />
                <Text size="1" truncate style={{ flex: 1, minWidth: 0 }}>
                  {feed.title ?? feed.url}
                </Text>
                {feed.failCount > 0 ? (
                  <Badge size="1" color="red" title={feed.lastStatus}>
                    {feed.failCount} fail{feed.failCount === 1 ? "" : "s"}
                  </Badge>
                ) : null}
                <IconButton
                  size="1"
                  variant="ghost"
                  color="red"
                  disabled={busy}
                  title="Remove feed"
                  aria-label="Remove feed"
                  onClick={() => callAgent("removeFeed", { feedId: feed.feedId })}
                >
                  <Cross2Icon />
                </IconButton>
              </Flex>
            ))}
            <Flex gap="2">
              <TextField.Root
                size="1"
                placeholder="https://example.com/feed.xml"
                value={newFeedUrl}
                onChange={(event) => setNewFeedUrl(event.target.value)}
                style={{ flex: 1 }}
              />
              <Button
                size="1"
                disabled={busy || newFeedUrl.trim().length === 0}
                onClick={() => {
                  callAgent("addFeed", { url: newFeedUrl.trim() });
                  setNewFeedUrl("");
                }}
              >
                <PlusIcon /> Add
              </Button>
            </Flex>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" weight="bold" color="gray">
              FOLLOWED TOPICS
            </Text>
            {topics.length > 0 ? (
              <Flex gap="2" wrap="wrap">
                {topics.map((topic) => (
                  <Badge key={topic.topic} size="2" color={topic.enabled ? "blue" : "gray"}>
                    {topic.topic}
                    <IconButton
                      size="1"
                      variant="ghost"
                      color="red"
                      disabled={busy}
                      title="Unfollow topic"
                      aria-label="Unfollow topic"
                      onClick={() => callAgent("unfollowTopic", { topic: topic.topic })}
                    >
                      <Cross2Icon />
                    </IconButton>
                  </Badge>
                ))}
              </Flex>
            ) : null}
            <Flex gap="2">
              <TextField.Root
                size="1"
                placeholder="e.g. AI agents"
                value={newTopic}
                onChange={(event) => setNewTopic(event.target.value)}
                style={{ flex: 1 }}
              />
              <Button
                size="1"
                disabled={busy || newTopic.trim().length === 0}
                onClick={() => {
                  callAgent("followTopic", { topic: newTopic.trim() });
                  setNewTopic("");
                }}
              >
                <PlusIcon /> Follow
              </Button>
            </Flex>
          </Flex>

          <Flex direction="column" gap="1">
            <Text size="1" weight="bold" color="gray">
              BRIEFING
            </Text>
            <Flex align="center" gap="2" wrap="wrap">
              <Text size="1" color="gray">
                Daily at
              </Text>
              <input
                type="time"
                value={minutesToHHMM(setup.briefingAtMinutes)}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value)
                    callAgent("setSchedule", { briefingAt: event.target.value });
                }}
                style={{
                  fontSize: "var(--font-size-1)",
                  padding: "2px 6px",
                  borderRadius: "var(--radius-2)",
                  border: "1px solid var(--gray-a6)",
                  background: "var(--color-surface)",
                  color: "var(--gray-12)",
                }}
              />
              <Box flexGrow="1" />
              <Text size="1" color="gray">
                {setup.briefingPaused ? "Paused" : "Active"}
              </Text>
              <Switch
                size="1"
                checked={!setup.briefingPaused}
                disabled={busy}
                onCheckedChange={(active) => callAgent("setBriefingPaused", { paused: !active })}
              />
            </Flex>
            {setup.scheduleSummary ? (
              <Text size="1" color="gray">
                {setup.scheduleSummary}
              </Text>
            ) : null}
          </Flex>
        </Flex>
      ) : null}
    </Box>
  );
}

/** First-run quick start: one-click curated sources, a paste-a-feed field, and
 *  OPML bulk import. Stays available while the reader is empty. */
function QuickStart({
  busy,
  hasSources,
  scheduleSummary,
  existingFeedUrls,
  existingTopics,
  feedDraft,
  onFeedDraft,
  onAddFeed,
  onFollowTopic,
  onImportOpml,
}: {
  busy: boolean;
  hasSources: boolean;
  scheduleSummary: string;
  existingFeedUrls: Set<string>;
  existingTopics: Set<string>;
  feedDraft: string;
  onFeedDraft: (value: string) => void;
  onAddFeed: (url: string) => void;
  onFollowTopic: (topic: string) => void;
  onImportOpml: (opml: string) => void;
}) {
  const [opmlOpen, setOpmlOpen] = useState(false);
  const [opmlDraft, setOpmlDraft] = useState("");
  return (
    <Card variant="surface">
      <Flex direction="column" gap="3">
        <Flex direction="column" gap="1">
          <Heading size="3">{hasSources ? "Add more sources" : "Welcome to News 📰"}</Heading>
          <Text size="2" color="gray">
            {hasSources
              ? `Sources are set — ${scheduleSummary}. No stories yet; hit Refresh to check now, or add more below.`
              : "Add a few sources and I'll gather them — plus anything you ask me to follow — into a digest and brief you on what matters. Pick a starter below, or just tell me what you're into in the chat."}
          </Text>
        </Flex>

        <Flex direction="column" gap="2">
          <Text size="1" weight="bold" color="gray">
            POPULAR FEEDS
          </Text>
          <Flex gap="2" wrap="wrap">
            {SUGGESTED_FEEDS.map((feed) => {
              const added = existingFeedUrls.has(feed.url);
              return (
                <Button
                  key={feed.url}
                  size="1"
                  variant={added ? "soft" : "outline"}
                  color={added ? "green" : undefined}
                  disabled={busy || added}
                  title={feed.blurb}
                  onClick={() => onAddFeed(feed.url)}
                >
                  {added ? <CheckIcon /> : <PlusIcon />} {feed.label}
                </Button>
              );
            })}
          </Flex>
        </Flex>

        <Flex direction="column" gap="2">
          <Text size="1" weight="bold" color="gray">
            FOLLOW A TOPIC
          </Text>
          <Flex gap="2" wrap="wrap">
            {SUGGESTED_TOPICS.map((topic) => {
              const added = existingTopics.has(topic.toLowerCase());
              return (
                <Button
                  key={topic}
                  size="1"
                  variant={added ? "soft" : "outline"}
                  color={added ? "green" : undefined}
                  disabled={busy || added}
                  onClick={() => onFollowTopic(topic)}
                >
                  {added ? <CheckIcon /> : <PlusIcon />} {topic}
                </Button>
              );
            })}
          </Flex>
        </Flex>

        <Flex direction="column" gap="1">
          <Text size="1" weight="bold" color="gray">
            OR PASTE A FEED URL
          </Text>
          <Flex gap="2">
            <TextField.Root
              size="1"
              placeholder="https://example.com/feed.xml"
              value={feedDraft}
              onChange={(event) => onFeedDraft(event.target.value)}
              style={{ flex: 1 }}
            />
            <Button
              size="1"
              disabled={busy || feedDraft.trim().length === 0}
              onClick={() => {
                onAddFeed(feedDraft.trim());
                onFeedDraft("");
              }}
            >
              <PlusIcon /> Add
            </Button>
          </Flex>
        </Flex>

        <Flex direction="column" gap="1">
          <Button
            size="1"
            variant="ghost"
            onClick={() => setOpmlOpen((open) => !open)}
            style={{ alignSelf: "flex-start" }}
          >
            {opmlOpen ? "▾" : "▸"} Import from OPML
          </Button>
          {opmlOpen ? (
            <Flex direction="column" gap="2">
              <TextArea
                size="1"
                placeholder="Paste an OPML export from another reader…"
                value={opmlDraft}
                onChange={(event) => setOpmlDraft(event.target.value)}
                rows={4}
              />
              <Button
                size="1"
                disabled={busy || opmlDraft.trim().length === 0}
                onClick={() => {
                  onImportOpml(opmlDraft.trim());
                  setOpmlDraft("");
                  setOpmlOpen(false);
                }}
                style={{ alignSelf: "flex-start" }}
              >
                <PlusIcon /> Import feeds
              </Button>
            </Flex>
          ) : null}
        </Flex>
      </Flex>
    </Card>
  );
}
