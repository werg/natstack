/**
 * Top-level layout for Spectrolite.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Header: title + flush status + agent roster                    │
 *   ├──────────┬─────────────────────────────────────────────────────┤
 *   │ FileTree │ DocumentEditor (Edit ↔ Preview)                     │
 *   │ Backlnks │                                                     │
 *   ├──────────┴─────────────────────────────────────────────────────┤
 *   │ CommitStrip                                                    │
 *   ├────────────────────────────────────────────────────────────────┤
 *   │ ChannelDrawer (collapsed by default)                           │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Owns:
 *   - active-file state + file-buffer map
 *   - PubSubClient lifecycle
 *   - flush controller
 *   - publishing kb.user_edit messages (+ enriched parallel send on mention)
 *   - commit-message state shared between drawer and CommitStrip
 *   - wikilink resolution + create-on-click
 *   - frontmatter title extraction for the breadcrumb
 *   - empty-state onboarding (creates a starter doc)
 */

import { promises as fs } from "fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, Heading, Text, Theme } from "@radix-ui/themes";
import { CheckCircledIcon, FilePlusIcon, LightningBoltIcon } from "@radix-ui/react-icons";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { rpc, recoveryCoordinator, useStateArgs, setStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import {
  buildEvalTool,
  createPanelSandboxConfig,
  unwrapChatMethodResult,
  type ChatMethodResult,
  type ChatSandboxValue,
  type SandboxConfig,
} from "@workspace/agentic-core";
import { executeSandbox, RpcScopePersistence, ScopeManager, type SandboxOptions, type SandboxResult } from "@workspace/eval";
import type { AvailableAgent } from "../bootstrap";
import { listAvailableAgents } from "../bootstrap";
import { FileTree } from "./FileTree";
import { DocumentEditor, writeBufferToDisk } from "./DocumentEditor";
import { ChannelDrawer } from "./ChannelDrawer";
import { CommitStrip } from "./CommitStrip";
import { AgentRoster, type RosterAgent } from "./AgentRoster";
import { AgentMessageNotifier } from "./AgentMessageNotifier";
import { BacklinksPanel } from "./BacklinksPanel";
import { BranchPicker } from "./BranchPicker";
import { VaultPicker } from "./VaultPicker";
import type { MentionCandidate } from "./MentionAutocomplete";
import { createFlushController } from "../flush/flush-controller";
import { buildFlushPayload } from "../flush/diff";
import { createBufferEntry, hasUnflushedChanges, type FileBufferEntry } from "../state/fileBuffer";
import { KB_USER_EDIT_TYPE, registerSpectroliteMessageTypes } from "../messages/register";
import { WikilinkContext } from "../mdx/components";
import { resolveWikilinkTarget, wikilinksFromJsx } from "../mdx/wikilink";
import { parseFrontmatter, diffDependencies } from "../mdx/frontmatter";
import { prefetchDependencies } from "../mdx/depPrefetch";
import { joinSafe, parentDir } from "../state/safePath";

export interface WorkspaceProps {
  channelName: string;
  channelContextId: string;
  /** Path to the currently-selected vault, or null when the user hasn't picked one yet. */
  repoRoot: string | null;
  primaryAgentHandle?: string;
  onAddAgent: (agentId: string) => Promise<void>;
  onRemoveAgent: (handle: string) => Promise<void>;
  /** Persist a newly-picked vault path. */
  onSelectVault: (contextPath: string) => void;
  /** Forget the current vault selection so the picker shows again. */
  onSwitchVault: () => void;
}

const PANEL_METADATA = {
  name: "Spectrolite",
  type: "panel" as const,
  handle: "spectrolite",
};

interface SpectroliteStateArgs {
  openPath?: string;
  channelName?: string;
  contextId?: string;
  pendingAgents?: Array<{ handle: string }>;
}

const SAMPLE_DOC_NAME = "Welcome.mdx";

const SAMPLE_DOC = `---
title: Welcome to Spectrolite
dependencies: {}
---

# Welcome to Spectrolite

This is an **MDX** knowledge base backed by a git repo. Try the following:

1. **Edit prose** like you would in any rich-text editor.
2. **@-mention an agent** to ask for help — type \`@\` to bring up the
   autocomplete. The agent sees the diff after you click **Flush** (or
   1.5 s of inactivity) and edits the file in-place.
3. **Link between notes** with double brackets — for example,
   [[Another Note]] (click to create it).
4. **Commit** dirty files from the strip at the bottom; click
   "Suggest message" to have the agent draft a commit message.

<Callout color="blue">
  <Callout.Icon><Icons.InfoCircledIcon /></Callout.Icon>
  <Callout.Text>
    Components like this Callout render live inline. Switch to **Preview**
    mode (top-right) to see the page rendered with full runtime access.
  </Callout.Text>
</Callout>

## Declaring dependencies

Add npm or workspace packages to this file via the YAML frontmatter:

\`\`\`yaml
dependencies:
  "date-fns": "npm:^2.30.0"
  lodash: "npm:^4.17.21"
  "@workspace/agentic-chat": latest
\`\`\`

The panel prefetches them into the sandbox module map. The resident agent's
\`eval\` tool picks them up automatically, and you can use them in inline
JSX blocks in this doc without redeclaring imports.

Delete this file or replace its contents when you're ready.
`;

function pathToTitle(relPath: string): string {
  const name = relPath.split("/").pop() ?? relPath;
  return name.replace(/\.mdx$/, "");
}

function formatTimeAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 0) return "just now";
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function Workspace({
  channelName,
  channelContextId,
  repoRoot,
  primaryAgentHandle,
  onAddAgent,
  onRemoveAgent,
  onSelectVault,
  onSwitchVault,
}: WorkspaceProps) {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<SpectroliteStateArgs>();
  const [client, setClient] = useState<PubSubClient | null>(null);
  const [activePath, setActivePath] = useState<string | null>(stateArgs.openPath ?? null);
  const [buffers, setBuffers] = useState<Record<string, FileBufferEntry>>({});
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [lastFlushedAt, setLastFlushedAt] = useState<Record<string, number>>({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [drawerOpenSignal, setDrawerOpenSignal] = useState(0);
  const requestDrawerOpen = useCallback(() => setDrawerOpenSignal((n) => n + 1), []);

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const pathsRef = useRef(workspacePaths);
  pathsRef.current = workspacePaths;

  // Sandbox config + scope manager — same primitives the chat panel uses
  // for its eval tool. Recreated whenever the channel name changes so the
  // scope is per-session.
  const sandbox: SandboxConfig = useMemo(() => createPanelSandboxConfig(rpc), []);
  const scopeManager = useMemo(() => new ScopeManager({
    channelId: channelName,
    panelId: PANEL_METADATA.handle,
    persistence: new RpcScopePersistence(rpc as unknown as { call(targetId: string, method: string, ...args: unknown[]): Promise<unknown> }),
  }), [channelName]);
  useEffect(() => () => { scopeManager.dispose?.(); }, [scopeManager]);

  // Frontmatter-declared dependencies merged across all open buffers. When
  // a buffer's frontmatter changes we diff and prefetch the new entries
  // through the panel sandbox so they're in the module map for inline JSX,
  // Preview-mode compilation, and the agent's eval tool calls.
  const [activeDeps, setActiveDeps] = useState<Record<string, string>>({});
  const lastDepsRef = useRef<Record<string, string>>({});

  // Tick every 5s so "flushed Ns ago" stays fresh
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  // We need a stable handle to the live client for the eval tool's
  // ChatSandboxValue (the tool definition is captured once at connect-time,
  // but the agent may invoke it across reconnections).
  const clientRef = useRef<PubSubClient | null>(null);

  // Build the ChatSandboxValue lazily — `eval` code can do channel work,
  // call other participants' methods, and read contextId/channelId.
  const chatSandboxValue: ChatSandboxValue = useMemo(() => ({
    publish: async (eventType, payload, options) =>
      clientRef.current ? clientRef.current.publish(eventType, payload, options) : undefined,
    send: async (content, options) =>
      clientRef.current ? clientRef.current.send(content, options) : undefined,
    callMethod: async (pid, method, callArgs) => {
      const c = clientRef.current;
      if (!c) throw new Error("Channel client not ready");
      const handle = c.callMethod(pid, method, callArgs);
      const result = await (handle as unknown as { result: Promise<ChatMethodResult> }).result;
      return unwrapChatMethodResult(result);
    },
    callMethodResult: async (pid, method, callArgs) => {
      const c = clientRef.current;
      if (!c) throw new Error("Channel client not ready");
      const handle = c.callMethod(pid, method, callArgs);
      return (handle as unknown as { result: Promise<ChatMethodResult> }).result;
    },
    contextId: channelContextId,
    channelId: channelName,
    rpc: sandbox.rpc,
  }), [channelContextId, channelName, sandbox]);

  // Wrap executeSandbox with scope lifecycle hooks so REPL state persists
  // across eval calls — same idiom as agentic-chat's useAgenticChat.
  // Also merges the active doc's frontmatter dependencies into the
  // per-call imports so the agent doesn't need to redeclare them.
  const wrappedExecuteSandbox = useMemo(() => {
    return async (code: string, opts: SandboxOptions = {}): Promise<SandboxResult> => {
      scopeManager.enterEval();
      try {
        const mergedImports = { ...lastDepsRef.current, ...(opts.imports ?? {}) };
        return await executeSandbox(code, {
          ...opts,
          imports: Object.keys(mergedImports).length > 0 ? mergedImports : opts.imports,
        });
      } finally {
        await scopeManager.exitEval();
      }
    };
  }, [scopeManager]);

  const evalTool = useMemo(() => buildEvalTool({
    sandbox,
    rpc: sandbox.rpc,
    runtimeTarget: "panel",
    scopeManager,
    executeSandbox: wrappedExecuteSandbox,
    getChatSandboxValue: () => chatSandboxValue,
    getScope: () => scopeManager.current,
  }), [sandbox, scopeManager, wrappedExecuteSandbox, chatSandboxValue]);

  // Connect to the channel — advertise the `eval` method so the resident
  // agent can call it like any other participant method. Same shape as the
  // chat panel's ToolProvider.eval.
  useEffect(() => {
    let cancelled = false;
    const c = connectViaRpc({
      rpc,
      channel: channelName,
      contextId: channelContextId,
      metadata: PANEL_METADATA,
      methods: { eval: evalTool },
      recoveryCoordinator,
    });
    clientRef.current = c;
    void c.ready().then(() => registerSpectroliteMessageTypes(c)).catch((err) => {
      console.warn("[Spectrolite] message type registration failed:", err);
    });
    if (!cancelled) setClient(c);
    return () => {
      cancelled = true;
      clientRef.current = null;
      c.close();
    };
  }, [channelName, channelContextId, evalTool]);

  useEffect(() => {
    if (!client) return;
    const unsubscribe = client.onRoster(() => {
      const next: RosterAgent[] = [];
      for (const p of Object.values(client.roster)) {
        const meta = p.metadata as { handle?: string; type?: string };
        if (meta.type === "panel") continue;
        if (!meta.handle) continue;
        next.push({ handle: meta.handle, participantId: p.id, status: "live" });
      }
      setRoster(next);
    });
    return unsubscribe;
  }, [client]);

  useEffect(() => { void listAvailableAgents().then(setAvailableAgents).catch(() => {}); }, []);

  useEffect(() => {
    if (activePath && activePath !== stateArgs.openPath) {
      void setStateArgs({ openPath: activePath });
    }
  }, [activePath, stateArgs.openPath]);

  // Parse the active doc's frontmatter and trigger a dep prefetch when it
  // changes. `activeDeps` feeds the eval tool's `imports` merge AND the
  // inline JSX / preview compilers via the same dep map.
  useEffect(() => {
    const buffer = activePath ? buffers[activePath] : undefined;
    if (!buffer) {
      setActiveDeps({});
      lastDepsRef.current = {};
      return;
    }
    const fm = parseFrontmatter(buffer.currentMdx);
    const next = fm.dependencies;
    const before = lastDepsRef.current;
    const { added, changed, removed } = diffDependencies(before, next);
    if (Object.keys(added).length === 0 && Object.keys(changed).length === 0 && removed.length === 0) {
      return;
    }
    lastDepsRef.current = next;
    setActiveDeps(next);
    const toFetch = { ...added, ...changed };
    if (Object.keys(toFetch).length > 0) {
      void prefetchDependencies(sandbox, toFetch, (line) => { console.info(line); });
    }
  }, [activePath, buffers, sandbox]);

  // Flush: write buffer to disk, compute diff vs lastFlushedMdx, publish
  // kb.user_edit, then if @-mentions resolved send a parallel chat message
  // with the diff inlined so the agent has full context for its response.
  const flush = useCallback(async (relPath: string) => {
    const c = client;
    const entry = buffersRef.current[relPath];
    if (!entry || !c || !repoRoot) return;
    if (!hasUnflushedChanges(entry)) return;

    const before = entry.lastFlushedMdx;
    const after = entry.currentMdx;
    try {
      await writeBufferToDisk(repoRoot, relPath, after);
    } catch (err) {
      console.warn(`[Spectrolite] write failed for ${relPath}:`, err);
      return;
    }

    const knownHandles = Object.values(c.roster)
      .map((p) => (p.metadata as { handle?: string }).handle)
      .filter((h): h is string => Boolean(h) && h !== PANEL_METADATA.handle);
    const beforeOnDisk = wikilinksFromJsx(before);
    const afterOnDisk = wikilinksFromJsx(after);
    const payload = buildFlushPayload({ path: relPath, before: beforeOnDisk, after: afterOnDisk, knownHandles });
    const flushedAt = payload?.at ?? Date.now();

    // We've successfully written to disk; mark the buffer flushed *even
    // when the on-disk forms compare equal* (payload === null). Otherwise
    // hasUnflushedChanges would stay true forever and we'd re-flush this
    // same null-diff on every quiescence.
    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) return prev;
      return { ...prev, [relPath]: { ...cur, savedMdx: after, lastFlushedMdx: after } };
    });
    setLastFlushedAt((prev) => ({ ...prev, [relPath]: flushedAt }));

    if (!payload) return;

    try {
      await c.publishCustomMessage({
        typeId: KB_USER_EDIT_TYPE,
        initialState: {
          path: relPath,
          unifiedDiff: payload.unifiedDiff,
          addedLines: payload.addedLines,
          removedLines: payload.removedLines,
          mentions: payload.mentions,
          at: payload.at,
          editorContextId: channelContextId,
        },
        displayMode: "row",
      });
    } catch (err) {
      console.warn("[Spectrolite] kb.user_edit publish failed:", err);
    }

    // Mentioned-agent fast path: send a normal chat message with the diff
    // inlined so the agent's mention-respond policy fires AND it has full
    // context without having to re-read the file.
    if (payload.mentions.length > 0) {
      try {
        const handles = payload.mentions.map((h) => `@${h}`).join(" ");
        const message = [
          `${handles} I just edited \`${relPath}\`. Diff:`,
          "```diff",
          payload.unifiedDiff,
          "```",
        ].join("\n");
        await c.send(message, { mentions: payload.mentions });
      } catch (err) {
        console.warn("[Spectrolite] mention send failed:", err);
      }
    }
  }, [client, repoRoot, channelContextId]);

  const flushController = useMemo(() => createFlushController({ onFlush: flush }), [flush]);
  useEffect(() => () => flushController.dispose(), [flushController]);

  const handleEditorChange = useCallback((relPath: string, next: string) => {
    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) return prev;
      if (cur.currentMdx === next) return prev;
      return { ...prev, [relPath]: { ...cur, currentMdx: next } };
    });
    flushController.noteChange(relPath);
  }, [flushController]);

  const handleEditorReload = useCallback((relPath: string, content: string) => {
    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) {
        return { ...prev, [relPath]: createBufferEntry(relPath, content) };
      }
      return {
        ...prev,
        [relPath]: { ...cur, savedMdx: content, currentMdx: content, lastFlushedMdx: content },
      };
    });
  }, []);

  const handleFlushClick = useCallback((relPath: string) => {
    flushController.flushNow(relPath);
  }, [flushController]);

  // Create-on-click for unresolved wikilinks. Resolves the path safely
  // (rejects `../` escapes), refuses to clobber existing files, then
  // refreshes the path index so backlinks pick up the new file.
  const createFileAt = useCallback(async (relPath: string, initialContent: string): Promise<string | null> => {
    if (!repoRoot) return null;
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const full = joinSafe(repoRoot, finalPath);
    if (!full) {
      console.warn(`[Spectrolite] create rejected — "${finalPath}" escapes workspace root`);
      return null;
    }
    // Refuse to overwrite. If the file already exists, just open it.
    try {
      await fs.stat(full);
      // Exists — return the path so the caller opens it.
      return finalPath;
    } catch {
      // ENOENT — safe to create.
    }
    const parent = parentDir(full);
    if (parent) {
      try { await fs.mkdir(parent, { recursive: true }); } catch { /* ignore */ }
    }
    try {
      // Exclusive-create. If the file appeared between our stat() above
      // and now (race), `wx` fails with EEXIST and we just open the
      // existing file. We do NOT silently fall back to plain writeFile
      // on other errors — that would risk clobbering a file that exists
      // but couldn't be stat'd (permissions, transient I/O).
      const fsWithFlags = fs as unknown as { writeFile(p: string, data: string, opts?: { flag?: string }): Promise<void> };
      try {
        await fsWithFlags.writeFile(full, initialContent, { flag: "wx" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/eexist/i.test(msg)) return finalPath;
        throw err;
      }
      setRefreshNonce((n) => n + 1);
      return finalPath;
    } catch (err) {
      console.warn(`[Spectrolite] create failed for ${finalPath}:`, err);
      return null;
    }
  }, [repoRoot]);

  const activeBuffer = activePath ? buffers[activePath] : undefined;
  const activeDirty = activeBuffer ? hasUnflushedChanges(activeBuffer) : false;
  const activeTitle = activeBuffer
    ? (parseFrontmatter(activeBuffer.currentMdx).title ?? (activePath ? pathToTitle(activePath) : null))
    : null;
  const activeLastFlushed = activePath ? lastFlushedAt[activePath] : undefined;

  const mentionCandidates: MentionCandidate[] = useMemo(() => roster.map((a) => ({ handle: a.handle })), [roster]);

  // Wikilink context — resolves [[Page]] to a path, opens it, OR creates
  // a stub when no match exists (Obsidian-style click-to-create).
  const wikilinkContext = useMemo(() => ({
    resolve: (target: string) => resolveWikilinkTarget(target, pathsRef.current),
    open: (path: string) => setActivePath(path),
    openOrCreate: async (target: string) => {
      const resolved = resolveWikilinkTarget(target, pathsRef.current);
      if (resolved) {
        setActivePath(resolved);
        return;
      }
      const created = await createFileAt(target, `# ${target}\n\n`);
      if (created) setActivePath(created);
    },
  }), [createFileAt]);

  const handleCreateWelcomeDoc = useCallback(async () => {
    const created = await createFileAt(SAMPLE_DOC_NAME, SAMPLE_DOC);
    if (created) setActivePath(created);
  }, [createFileAt]);

  // No vault selected yet — show the picker. Channel + agent are already
  // connected (so the user can chat about which vault to open), but we
  // don't render the editor surface until the user has picked.
  if (!repoRoot) {
    return (
      <Theme appearance={theme} radius="medium" style={{ height: "100dvh" }}>
        <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
          <Flex
            align="center"
            justify="between"
            gap="3"
            px="3"
            py="2"
            style={{ borderBottom: "1px solid var(--gray-5)", flexShrink: 0 }}
          >
            <Heading size="3">Spectrolite</Heading>
            <AgentRoster
              agents={roster}
              availableAgents={availableAgents}
              onAdd={async (id) => { await onAddAgent(id); }}
              onRemove={async (handle) => { await onRemoveAgent(handle); }}
            />
          </Flex>
          <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <VaultPicker
              agentHandle={roster[0]?.handle ?? primaryAgentHandle}
              onSelect={onSelectVault}
            />
          </Box>
          <ChannelDrawer
            client={client}
            onUseAsCommitMessage={setCommitMessage}
            openSignal={drawerOpenSignal}
          />
          <AgentMessageNotifier
            client={client}
            onOpenDrawer={requestDrawerOpen}
            selfHandle={PANEL_METADATA.handle}
          />
        </Flex>
      </Theme>
    );
  }

  return (
    <Theme appearance={theme} radius="medium" style={{ height: "100dvh" }}>
      <WikilinkContext.Provider value={wikilinkContext}>
        <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
          <Flex
            align="center"
            justify="between"
            gap="3"
            px="3"
            py="2"
            style={{ borderBottom: "1px solid var(--gray-5)", flexShrink: 0 }}
          >
            <Flex align="center" gap="2">
              <Heading size="3">Spectrolite</Heading>
              <Button
                size="1"
                variant="ghost"
                color="gray"
                onClick={onSwitchVault}
                title="Switch to a different vault"
              >
                {repoRoot.replace(/^\//, "")}
              </Button>
              <BranchPicker repoRoot={repoRoot} refreshNonce={refreshNonce} />
              {activeTitle ? <Text size="1" color="gray">/ {activeTitle}</Text> : null}
              {activeDirty ? (
                <Flex align="center" gap="1" title="Unflushed edits">
                  <LightningBoltIcon color="orange" />
                  <Text size="1" color="amber">unflushed</Text>
                </Flex>
              ) : activeLastFlushed ? (
                <Flex align="center" gap="1" title={`Last flushed at ${new Date(activeLastFlushed).toLocaleString()}`}>
                  <CheckCircledIcon color="green" />
                  <Text size="1" color="gray">flushed {formatTimeAgo(activeLastFlushed, nowTick)}</Text>
                </Flex>
              ) : null}
            </Flex>
            <AgentRoster
              agents={roster}
              availableAgents={availableAgents}
              onAdd={async (id) => { await onAddAgent(id); }}
              onRemove={async (handle) => { await onRemoveAgent(handle); }}
            />
          </Flex>
          <Flex style={{ flex: 1, minHeight: 0 }}>
            <Flex direction="column" style={{ width: 260, borderRight: "1px solid var(--gray-5)", flexShrink: 0 }}>
              <Box style={{ flex: 1, minHeight: 0 }}>
                <FileTree
                  root={repoRoot}
                  activePath={activePath}
                  onOpen={setActivePath}
                  refreshNonce={refreshNonce}
                  onPathsRefreshed={setWorkspacePaths}
                />
              </Box>
              <BacklinksPanel
                root={repoRoot}
                activePath={activePath}
                paths={workspacePaths}
                refreshKey={refreshNonce}
                onOpen={setActivePath}
              />
            </Flex>
            <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              {activePath ? (
                <DocumentEditor
                  repoRoot={repoRoot}
                  relPath={activePath}
                  theme={theme}
                  onChange={handleEditorChange}
                  onReload={handleEditorReload}
                  onFlushClick={handleFlushClick}
                  hasUnflushedChanges={activeDirty}
                  mentionCandidates={mentionCandidates}
                  dependencies={activeDeps}
                />
              ) : workspacePaths.length === 0 ? (
                <EmptyVault onCreateWelcomeDoc={handleCreateWelcomeDoc} />
              ) : (
                <Flex align="center" justify="center" style={{ height: "100%" }}>
                  <Text size="2" color="gray">
                    Select a file from the sidebar to start editing.
                  </Text>
                </Flex>
              )}
            </Box>
          </Flex>
          <CommitStrip
            repoRoot={repoRoot}
            client={client}
            primaryAgentHandle={primaryAgentHandle ?? roster[0]?.handle}
            onCommitted={() => setRefreshNonce((n) => n + 1)}
            message={commitMessage}
            onMessageChange={setCommitMessage}
          />
          <ChannelDrawer
            client={client}
            onUseAsCommitMessage={setCommitMessage}
            openSignal={drawerOpenSignal}
          />
          <AgentMessageNotifier
            client={client}
            onOpenDrawer={requestDrawerOpen}
            selfHandle={PANEL_METADATA.handle}
          />
        </Flex>
      </WikilinkContext.Provider>
    </Theme>
  );
}

function EmptyVault({ onCreateWelcomeDoc }: { onCreateWelcomeDoc: () => void }) {
  return (
    <Flex align="center" justify="center" style={{ height: "100%" }} p="6">
      <Flex direction="column" align="center" gap="3" style={{ maxWidth: 480, textAlign: "center" }}>
        <Heading size="3">This vault is empty</Heading>
        <Text size="2" color="gray">
          Create your first note to get started — or use the <strong>+ New</strong> field
          in the sidebar to name your own.
        </Text>
        <Button onClick={onCreateWelcomeDoc} variant="solid">
          <FilePlusIcon /> Create starter note
        </Button>
      </Flex>
    </Flex>
  );
}
