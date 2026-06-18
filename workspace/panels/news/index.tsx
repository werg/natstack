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
  recoveryCoordinator,
  rpc,
  setStateArgs,
  useStateArgs,
  type DurableObjectServiceClient,
} from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Link,
  ScrollArea,
  SegmentedControl,
  Select,
  Separator,
  Spinner,
  Text,
  TextArea,
  TextField,
  Theme,
} from "@radix-ui/themes";
import {
  CheckIcon,
  ExclamationTriangleIcon,
  GlobeIcon,
  LightningBoltIcon,
  PlusIcon,
  ReloadIcon,
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
import { NEWS_AGENT_CLASS, NEWS_AGENT_HANDLE, NEWS_AGENT_SOURCE, type NewsStateArgs } from "./types.js";

interface ArticleRow {
  articleId: string;
  title: string;
  url: string;
  source: string;
  blurb?: string;
  publishedAt?: string;
  briefedIn?: string;
  read: boolean;
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

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
}

interface Overview {
  setup: NewsSetupCardState;
  articleCount: number;
  unbriefedCount: number;
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
function modelHasMatchingCredential(baseUrl: string | undefined, audiences: UrlAudience[]): boolean {
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

export default function NewsPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<NewsStateArgs>();
  const resolvedContextId = resolveNewsContextId(stateArgs.contextId, runtimeContextId);

  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [agentTarget, setAgentTarget] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [briefings, setBriefings] = useState<BriefingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedDraft, setFeedDraft] = useState("");
  const [modelConnect, setModelConnect] = useState<{ providerId: string; baseUrl: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [pastOpen, setPastOpen] = useState(false);
  const lastSeenEventId = useRef(0);
  const latestTldrRef = useRef<string | undefined>(undefined);
  const bootstrapAttempted = useRef(false);
  const modelServiceRef = useRef<DurableObjectServiceClient | null>(null);
  const modelProbeRef = useRef<{ catalog: ModelCatalog; modelRef: string } | null>(null);

  const channelName = stateArgs.channelName ?? bootstrapChannel;

  // ── bootstrap: mint channel + agent, resolve model, ensure-subscribe ──────
  useEffect(() => {
    if (!resolvedContextId || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    void (async () => {
      try {
        const channel = stateArgs.channelName ?? newsChannelName();
        const agentKey = stateArgs.agentKey ?? newsAgentKey();
        if (!stateArgs.channelName || !stateArgs.agentKey) {
          void setStateArgs({ channelName: channel, agentKey, contextId: resolvedContextId });
        }
        if (!stateArgs.channelName) setBootstrapChannel(channel);

        // Honor the workspace-configured model like the chat panel does.
        modelServiceRef.current ??= createDurableObjectServiceClient(MODEL_SETTINGS_SERVICE_PROTOCOL);
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
        rpc.call<{ articles: ArticleRow[] }>(agentTarget, "listArticles", [channelName, { limit: 60 }]),
        rpc.call<{ briefings: BriefingRow[] }>(agentTarget, "briefingHistory", [channelName, { limit: 12 }]),
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
          if (prev && next && prev.providerId === next.providerId && prev.baseUrl === next.baseUrl) {
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

  // ── deep-dive: fork the channel into a per-story analysis chat ────────────
  const handleDeepDive = useCallback(
    async (story: DeepDiveStory) => {
      if (!channelName || !resolvedContextId) return;
      setBusy(true);
      setError(null);
      try {
        const result = await fork(
          {
            rpc: {
              call: <T,>(target: string, method: string, args: unknown[]) =>
                rpc.call<T>(target, method, args),
            } as never,
            callMain: <T,>(method: string, ...args: unknown[]) =>
              rpc.call<T>("main", method, args),
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
            await rpc.call(`do:${agent.source}:${agent.className}:${agent.objectKey}`, "startDeepDive", [
              result.forkedChannelId,
              {
                articleId: story.articleId,
                url: story.url,
                title: story.title,
                source: story.source,
                briefingTldr: latestTldrRef.current,
              },
            ]);
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
    [channelName, resolvedContextId]
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

  if (!channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
            <Spinner />
            <Text size="2" color="gray">Starting news…</Text>
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
  const readyBriefings = briefings.filter((briefing) => briefing.status === "ready" && briefing.tldr);
  const latestReady = readyBriefings[0];
  const pastReady = readyBriefings.slice(1);

  // A completed briefing is hard proof the model resolved a credential and ran,
  // so never nag to "connect a model" once one exists — the client-side
  // credential probe can false-negative (e.g. OAuth providers like openai-codex
  // whose stored audience doesn't path-match the catalog baseUrl).
  const modelProvenWorking = readyBriefings.length > 0 || Boolean(overview?.lastBriefingId);
  const showConnectNudge = Boolean(modelConnect) && !modelProvenWorking;

  const sources = [...new Set(articles.map((article) => article.source))].sort();
  const visibleArticles = articles.filter(
    (article) =>
      (!unreadOnly || !article.read) && (sourceFilter === "" || article.source === sourceFilter)
  );
  const unreadIds = articles.filter((article) => !article.read).map((article) => article.articleId);

  return (
    <ErrorBoundary>
      <Theme appearance={theme}>
        <Flex style={{ height: "100dvh" }}>
          {/* ── reader region ── */}
          <Flex direction="column" style={{ flex: "1 1 55%", minWidth: 0 }}>
            <Flex align="center" gap="2" p="3">
              <Text size="3" weight="bold">📰 News</Text>
              {overview ? (
                <Badge size="1" color="gray">
                  {overview.articleCount} articles · {overview.unbriefedCount} unbriefed
                </Badge>
              ) : null}
              {failingFeeds.length > 0 ? (
                <Badge size="1" color="red" title={failingFeeds.map((feed) => feed.title ?? feed.url).join("\n")}>
                  <ExclamationTriangleIcon /> {failingFeeds.length} feed{failingFeeds.length > 1 ? "s" : ""} failing
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
              <Text size="1" color="red" style={{ padding: "0 var(--space-3)" }}>{error}</Text>
            ) : null}

            {showConnectNudge && modelConnect ? (
              <Box px="3" pt="2">
                <Callout.Root color="amber" size="1">
                  <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
                  <Callout.Text>
                    <Flex align="center" gap="3" wrap="wrap">
                      <Text size="1">
                        Connect <Text weight="medium">{modelConnect.providerId}</Text> to enable
                        briefings and chat.
                      </Text>
                      <Button size="1" disabled={connecting} onClick={() => void handleConnectModel()}>
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
                {preparing ? (
                  <Card variant="surface">
                    <Flex align="center" gap="2">
                      <Spinner size="2" />
                      <Flex direction="column">
                        <Text size="2" weight="medium">Preparing your briefing…</Text>
                        <Text size="1" color="gray">Scanning sources and writing your digest.</Text>
                      </Flex>
                    </Flex>
                  </Card>
                ) : null}

                {latestReady?.tldr ? (
                  <Flex direction="column" gap="1">
                    <Text size="1" weight="bold" color="gray">
                      LATEST BRIEFING · {new Date(latestReady.createdAt).toLocaleString()}
                    </Text>
                    <Markdown>{latestReady.tldr}</Markdown>
                  </Flex>
                ) : null}

                {pastReady.length > 0 ? (
                  <Box>
                    <Button size="1" variant="ghost" onClick={() => setPastOpen((open) => !open)}>
                      {pastOpen ? "▾" : "▸"} Past briefings ({pastReady.length})
                    </Button>
                    {pastOpen ? (
                      <Flex direction="column" gap="2" pt="2">
                        {pastReady.map((briefing) => (
                          <Flex key={briefing.briefingId} direction="column" gap="1">
                            <Text size="1" weight="bold" color="gray">
                              {new Date(briefing.createdAt).toLocaleString()}
                            </Text>
                            {briefing.tldr ? <Markdown>{briefing.tldr}</Markdown> : null}
                          </Flex>
                        ))}
                      </Flex>
                    ) : null}
                  </Box>
                ) : null}

                {(latestReady || pastReady.length > 0 || articles.length > 0) ? (
                  <Separator size="4" my="1" />
                ) : null}

                {articles.length > 0 ? (
                  <Flex align="center" gap="2" wrap="wrap">
                    <SegmentedControl.Root
                      size="1"
                      value={unreadOnly ? "unread" : "all"}
                      onValueChange={(value) => setUnreadOnly(value === "unread")}
                    >
                      <SegmentedControl.Item value="all">All</SegmentedControl.Item>
                      <SegmentedControl.Item value="unread">Unread</SegmentedControl.Item>
                    </SegmentedControl.Root>
                    {sources.length > 1 ? (
                      <Select.Root size="1" value={sourceFilter || "__all"} onValueChange={(value) => setSourceFilter(value === "__all" ? "" : value)}>
                        <Select.Trigger placeholder="All sources" variant="soft" />
                        <Select.Content>
                          <Select.Item value="__all">All sources</Select.Item>
                          {sources.map((source) => (
                            <Select.Item key={source} value={source}>{source}</Select.Item>
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
                        onClick={() => void callAgent("markRead", { articleIds: unreadIds.slice(0, 200) })}
                      >
                        Mark all read
                      </Button>
                    ) : null}
                  </Flex>
                ) : null}

                {visibleArticles.map((article) => {
                  const age = relativeAge(article.publishedAt);
                  return (
                    <Flex key={article.articleId} direction="column" gap="1" style={{ opacity: article.read ? 0.55 : 1 }}>
                      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                        <GlobeIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />
                        <Link
                          href={article.url}
                          target="_blank"
                          rel="noreferrer"
                          size="2"
                          weight={article.read ? "regular" : "medium"}
                          style={{ minWidth: 0, wordBreak: "break-word" }}
                        >
                          {article.title}
                        </Link>
                      </Flex>
                      {article.blurb ? (
                        <Text size="1" color="gray" style={{ wordBreak: "break-word" }}>
                          {article.blurb}
                        </Text>
                      ) : null}
                      <Flex align="center" gap="2">
                        <Text size="1" color="gray">
                          {article.source}
                          {age ? ` · ${age}` : ""}
                        </Text>
                        <Button size="1" variant="soft" disabled={busy} onClick={() => void handleDeepDive(article)}>
                          Deep-dive
                        </Button>
                        {!article.read ? (
                          <Button
                            size="1"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void callAgent("markRead", { articleIds: [article.articleId] })}
                          >
                            Mark read
                          </Button>
                        ) : null}
                      </Flex>
                    </Flex>
                  );
                })}
                {articles.length > 0 && visibleArticles.length === 0 ? (
                  <Text size="2" color="gray">No articles match this filter.</Text>
                ) : null}

                {articles.length === 0 && overview ? (
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

          <Separator orientation="vertical" size="4" />

          {/* ── embedded agentic chat ── */}
          <Box style={{ flex: "1 1 45%", minWidth: 0 }}>
            <AgenticChat
              config={config}
              channelName={channelName}
              contextId={resolvedContextId}
              theme={theme}
              installedAgents={installedAgents}
              sandbox={sandboxConfig}
            />
          </Box>
        </Flex>
      </Theme>
    </ErrorBoundary>
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
          <Text size="1" weight="bold" color="gray">POPULAR FEEDS</Text>
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
          <Text size="1" weight="bold" color="gray">FOLLOW A TOPIC</Text>
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
          <Text size="1" weight="bold" color="gray">OR PASTE A FEED URL</Text>
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
          <Button size="1" variant="ghost" onClick={() => setOpmlOpen((open) => !open)} style={{ alignSelf: "flex-start" }}>
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
