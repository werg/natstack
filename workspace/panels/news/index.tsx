/**
 * News panel — a reader app wrapped around the reusable agentic stack.
 *
 * Left region: deterministic reader UI (latest TLDR, article list, controls)
 * fed by direct DO method calls on the news agent. Right region: the full
 * AgenticChat component on the same channel, so briefing/setup cards render
 * and "less crypto please" works conversationally. Story deep-dives fork the
 * channel (cloning the agent DO) into a fresh analysis chat panel.
 */

import {
  contextId as runtimeContextId,
  openPanel,
  recoveryCoordinator,
  rpc,
  setStateArgs,
  useStateArgs,
} from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Flex, Link, ScrollArea, Separator, Spinner, Text, Theme } from "@radix-ui/themes";
import { GlobeIcon, LightningBoltIcon, MagnifyingGlassIcon, ReloadIcon } from "@radix-ui/react-icons";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig } from "@workspace/agentic-chat";
import { createPanelSandboxConfig, parseSignalEvent } from "@workspace/agentic-core";
import { connectViaRpc } from "@workspace/pubsub";
import { fork } from "@workspace/channel-fork";
import { NEWS_DEEPDIVE_SIGNAL, type NewsDeepDiveRequested, type NewsSetupCardState } from "@workspace/feeds/card-types";
import { deepDivePrompt, newsAgentKey, newsChannelName, resolveNewsContextId } from "./bootstrap.js";
import { NEWS_AGENT_CLASS, NEWS_AGENT_HANDLE, NEWS_AGENT_SOURCE, type NewsStateArgs } from "./types.js";

interface ArticleRow {
  articleId: string;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  briefedIn?: string;
  read: boolean;
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
  const lastSeenEventId = useRef(0);
  const bootstrapAttempted = useRef(false);

  const channelName = stateArgs.channelName ?? bootstrapChannel;

  // ── bootstrap: mint channel + agent on first open, then ensure-subscribe ──
  useEffect(() => {
    if (!resolvedContextId || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;
    void (async () => {
      try {
        const channel = stateArgs.channelName ?? newsChannelName();
        const agentKey = stateArgs.agentKey ?? newsAgentKey();
        if (!stateArgs.channelName) {
          void setStateArgs({ channelName: channel, agentKey, contextId: resolvedContextId });
          setBootstrapChannel(channel);
        }
        // Idempotent: re-running subscribe re-installs UI and refreshes state.
        const targetId = await ensureAgentSubscribed({
          agentKey,
          channelId: channel,
          channelContextId: resolvedContextId,
          config: stateArgs.agentConfig,
        });
        setAgentTarget(targetId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [resolvedContextId, stateArgs.agentConfig, stateArgs.agentKey, stateArgs.channelName]);

  // ── reader data ────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!agentTarget || !channelName) return;
    try {
      const [nextOverview, articleList, history] = await Promise.all([
        rpc.call<Overview>(agentTarget, "getOverview", [channelName, {}]),
        rpc.call<{ articles: ArticleRow[] }>(agentTarget, "listArticles", [channelName, { limit: 40 }]),
        rpc.call<{ briefings: BriefingRow[] }>(agentTarget, "briefingHistory", [channelName, { limit: 5 }]),
      ]);
      setOverview(nextOverview);
      setArticles(articleList.articles);
      setBriefings(history.briefings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    async (story: { articleId: string; url: string; title: string }) => {
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
        await openPanel("panels/chat", {
          name: `Deep-dive: ${story.title.slice(0, 40)}`,
          focus: true,
          stateArgs: {
            channelName: result.forkedChannelId,
            contextId: resolvedContextId,
            initialPrompt: deepDivePrompt(story),
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
            <Text size="2" color="gray">Starting news...</Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  const latestReady = briefings.find((briefing) => briefing.status === "ready");

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
            <Separator size="4" my="2" />
            <ScrollArea style={{ flex: 1 }}>
              <Flex direction="column" gap="3" p="3" pt="0">
                {latestReady?.tldr ? (
                  <Flex direction="column" gap="1">
                    <Text size="1" weight="bold" color="gray">
                      LATEST BRIEFING · {new Date(latestReady.createdAt).toLocaleString()}
                    </Text>
                    <Text size="2" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {latestReady.tldr}
                    </Text>
                    <Separator size="4" my="1" />
                  </Flex>
                ) : null}
                {articles.map((article) => (
                  <Flex key={article.articleId} direction="column" gap="1" style={{ opacity: article.read ? 0.55 : 1 }}>
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                      {article.briefedIn?.startsWith("dropped:") ? null : article.source === "search" ? (
                        <MagnifyingGlassIcon />
                      ) : (
                        <GlobeIcon />
                      )}
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
                    <Flex align="center" gap="2">
                      <Text size="1" color="gray">
                        {article.source}
                        {article.publishedAt
                          ? ` · ${new Date(article.publishedAt).toLocaleDateString()}`
                          : ""}
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
                ))}
                {articles.length === 0 && overview ? (
                  <Text size="2" color="gray">
                    No articles yet — add feeds or follow topics in the chat, or via the setup card.
                  </Text>
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
