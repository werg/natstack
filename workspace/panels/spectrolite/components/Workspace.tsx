/**
 * Top-level layout for Spectrolite.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Header: title + agent roster                                   │
 *   ├──────────┬─────────────────────────────────────────────────────┤
 *   │ FileTree │ DocumentEditor                                      │
 *   │          │                                                     │
 *   │          │                                                     │
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
 *   - publishing kb.user_edit messages
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, Heading, Text, Theme } from "@radix-ui/themes";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { rpc, recoveryCoordinator, contextId as runtimeContextId, useStateArgs, setStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import type { AvailableAgent } from "../bootstrap";
import { listAvailableAgents } from "../bootstrap";
import { FileTree } from "./FileTree";
import { DocumentEditor, writeBufferToDisk } from "./DocumentEditor";
import { ChannelDrawer } from "./ChannelDrawer";
import { CommitStrip } from "./CommitStrip";
import { AgentRoster, type RosterAgent } from "./AgentRoster";
import { createFlushController } from "../flush/flush-controller";
import { buildFlushPayload } from "../flush/diff";
import { createBufferEntry, hasUnflushedChanges, type FileBufferEntry } from "../state/fileBuffer";
import { KB_USER_EDIT_TYPE, registerSpectroliteMessageTypes } from "../messages/register";

export interface WorkspaceProps {
  channelName: string;
  channelContextId: string;
  /** Workspace root (= the context's filesystem root for this panel). */
  repoRoot: string;
  /** Handle of the resident agent we ask for commit messages. */
  primaryAgentHandle?: string;
  /** Handlers for adding/removing agents — wired to bootstrap helpers. */
  onAddAgent: (agentId: string) => Promise<void>;
  onRemoveAgent: (handle: string) => Promise<void>;
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

export function Workspace({
  channelName,
  channelContextId,
  repoRoot,
  primaryAgentHandle,
  onAddAgent,
  onRemoveAgent,
}: WorkspaceProps) {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<SpectroliteStateArgs>();
  const [client, setClient] = useState<PubSubClient | null>(null);
  const [activePath, setActivePath] = useState<string | null>(stateArgs.openPath ?? null);
  const [buffers, setBuffers] = useState<Record<string, FileBufferEntry>>({});
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  // Connect to the channel
  useEffect(() => {
    let cancelled = false;
    const c = connectViaRpc({
      rpc,
      channel: channelName,
      contextId: channelContextId,
      metadata: PANEL_METADATA,
      recoveryCoordinator,
    });
    void c.ready().then(() => registerSpectroliteMessageTypes(c)).catch((err) => {
      console.warn("[Spectrolite] message type registration failed:", err);
    });
    if (!cancelled) setClient(c);
    return () => {
      cancelled = true;
      c.close();
    };
  }, [channelName, channelContextId]);

  // Roster — subscribe to participants and surface non-panel agents
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

  // Persist active file in stateArgs so reload reopens it
  useEffect(() => {
    if (activePath && activePath !== stateArgs.openPath) {
      void setStateArgs({ openPath: activePath });
    }
  }, [activePath, stateArgs.openPath]);

  // Flush: write buffer to disk, compute diff vs lastFlushedMdx, publish
  const flush = useCallback(async (relPath: string) => {
    const c = client;
    const entry = buffersRef.current[relPath];
    if (!entry || !c) return;
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
    const payload = buildFlushPayload({ path: relPath, before, after, knownHandles });
    if (!payload) return;

    setBuffers((prev) => {
      const cur = prev[relPath];
      if (!cur) return prev;
      return { ...prev, [relPath]: { ...cur, savedMdx: after, lastFlushedMdx: after } };
    });

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

    // If the user explicitly @-mentioned someone in the diff, send a normal
    // chat message too so the agent's mention-respond policy fires.
    if (payload.mentions.length > 0) {
      try {
        await c.send(
          `@${payload.mentions.join(" @")} please look at the edit I just made to \`${relPath}\`.`,
          { mentions: payload.mentions },
        );
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
      // Disk content changed (e.g. agent wrote to it). Reset both saved and
      // lastFlushedMdx so subsequent user edits diff cleanly against what's
      // now on disk.
      return {
        ...prev,
        [relPath]: { ...cur, savedMdx: content, currentMdx: content, lastFlushedMdx: content },
      };
    });
  }, []);

  const handleFlushClick = useCallback((relPath: string) => {
    flushController.flushNow(relPath);
  }, [flushController]);

  const activeBuffer = activePath ? buffers[activePath] : undefined;
  const activeDirty = activeBuffer ? hasUnflushedChanges(activeBuffer) : false;

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
          <Flex align="center" gap="2">
            <Heading size="3">Spectrolite</Heading>
            {activePath ? <Text size="1" color="gray">/ {activePath}</Text> : null}
          </Flex>
          <AgentRoster
            agents={roster}
            availableAgents={availableAgents}
            onAdd={async (id) => { await onAddAgent(id); }}
            onRemove={async (handle) => { await onRemoveAgent(handle); }}
          />
        </Flex>
        <Flex style={{ flex: 1, minHeight: 0 }}>
          <Box style={{ width: 240, borderRight: "1px solid var(--gray-5)", flexShrink: 0 }}>
            <FileTree
              root={repoRoot}
              activePath={activePath}
              onOpen={setActivePath}
              refreshNonce={refreshNonce}
            />
          </Box>
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
              />
            ) : (
              <Flex align="center" justify="center" style={{ height: "100%" }}>
                <Text size="2" color="gray">
                  Select or create a file to start editing.
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
        />
        <ChannelDrawer client={client} />
      </Flex>
    </Theme>
  );
}
