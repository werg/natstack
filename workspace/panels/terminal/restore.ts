import type { PerSessionState, SavedLayout, SessionInfo, ShellApi, SplitNode, TerminalState, TerminalTab } from "./types.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";

export interface RestoreResult {
  tabs: TerminalTab[];
  activeTabId?: string;
  sessions: Record<string, SessionInfo>;
  perSession: Record<string, PerSessionState>;
}

export async function restoreTerminalState(shell: ShellApi, state: TerminalState): Promise<RestoreResult> {
  const sessions: Record<string, SessionInfo> = {};
  const perSession: Record<string, PerSessionState> = {};
  const tabs: TerminalTab[] = [];

  for (const tab of state.tabs) {
    const restored = await restoreTree(shell, tab.tree, state.perSession, sessions, perSession, {
      scrollbackBytes: state.scrollbackBytes,
      disposeOriginalLeaves: true,
    });
    if (!restored) continue;
    const focusedSessionId = restored.sessionMap[tab.focusedSessionId] ?? firstLeaf(restored.node);
    if (!focusedSessionId) continue;
    tabs.push({ ...tab, tree: restored.node, focusedSessionId });
  }

  return {
    tabs,
    activeTabId: tabs.some((tab) => tab.tabId === state.activeTabId) ? state.activeTabId : tabs[0]?.tabId,
    sessions,
    perSession,
  };
}

export async function instantiateSavedLayout(shell: ShellApi, layout: SavedLayout, opts: { scrollbackBytes?: number } = {}): Promise<{ tab: TerminalTab; sessions: Record<string, SessionInfo>; perSession: Record<string, PerSessionState> } | undefined> {
  const sessions: Record<string, SessionInfo> = {};
  const perSession: Record<string, PerSessionState> = {};
  const restored = await restoreTree(shell, layout.tree, Object.fromEntries(Object.entries(layout.cwds).map(([sessionId, cwd]) => [sessionId, { cwd, label: layout.labels[sessionId], readCursor: 0, lastSeenAt: 0 }])), sessions, perSession, {
    scrollbackBytes: opts.scrollbackBytes,
    disposeOriginalLeaves: false,
  });
  const focusedSessionId = restored ? firstLeaf(restored.node) : undefined;
  if (!restored || !focusedSessionId) return undefined;
  return {
    tab: {
      tabId: crypto.randomUUID(),
      label: layout.name,
      tree: restored.node,
      focusedSessionId,
      icon: layout.icon,
      accent: layout.accent,
    },
    sessions,
    perSession,
  };
}

export function saveLayoutFromTab(
  tab: TerminalTab,
  perSession: TerminalState["perSession"],
  name: string,
  sessions: Record<string, SessionInfo> = {},
): SavedLayout {
  const slots: Array<{ slotId: string; sessionId: string }> = [];
  const tree = anonymizeTree(tab.tree, slots);
  return {
    id: crypto.randomUUID(),
    name,
    tree,
    cwds: Object.fromEntries(slots.map(({ slotId, sessionId }) => [slotId, liveSessionCwd(sessions[sessionId]) ?? perSession[sessionId]?.cwd ?? "."])),
    labels: Object.fromEntries(slots.map(({ slotId, sessionId }) => [slotId, sessions[sessionId]?.label ?? perSession[sessionId]?.label ?? sessionId.slice(0, 8)])),
    icon: tab.icon,
    accent: tab.accent,
    updatedAt: Date.now(),
  };
}

async function restoreTree(
  shell: ShellApi,
  node: SplitNode,
  perSession: TerminalState["perSession"],
  sessions: Record<string, SessionInfo>,
  nextPerSession: Record<string, PerSessionState>,
  opts: { scrollbackBytes?: number; disposeOriginalLeaves: boolean },
): Promise<{ node: SplitNode; sessionMap: Record<string, string> } | undefined> {
  if (node.kind === "leaf") {
    const saved = perSession[node.sessionId];
    let openedSessionId: string | undefined;
    try {
      const { sessionId } = await shell.open({ cwd: saved?.cwd, label: saved?.label });
      openedSessionId = sessionId;
      const info = await shell.get(sessionId);
      if (opts.scrollbackBytes) await shell.setScrollbackLimit?.(sessionId, opts.scrollbackBytes);
      sessions[sessionId] = info;
      nextPerSession[sessionId] = {
        cwd: info.command.cwd,
        originalArgv: saved?.originalArgv ?? info.command.argv,
        readCursor: saved?.readCursor ?? 0,
        lastSeenAt: Date.now(),
        label: saved?.label,
      };
      if (opts.disposeOriginalLeaves) void shell.dispose?.(node.sessionId).catch(() => {});
      return { node: { kind: "leaf", sessionId }, sessionMap: { [node.sessionId]: sessionId } };
    } catch {
      if (openedSessionId) void shell.dispose?.(openedSessionId).catch(() => {});
      if (opts.disposeOriginalLeaves) void shell.dispose?.(node.sessionId).catch(() => {});
      return undefined;
    }
  }
  const a = await restoreTree(shell, node.a, perSession, sessions, nextPerSession, opts);
  const b = await restoreTree(shell, node.b, perSession, sessions, nextPerSession, opts);
  if (!a) return b;
  if (!b) return a;
  return {
    node: { ...node, a: a.node, b: b.node },
    sessionMap: { ...a.sessionMap, ...b.sessionMap },
  };
}

function anonymizeTree(node: SplitNode, slots: Array<{ slotId: string; sessionId: string }>): SplitNode {
  if (node.kind === "leaf") {
    const slotId = `slot-${slots.length + 1}`;
    slots.push({ slotId, sessionId: node.sessionId });
    return { kind: "leaf", sessionId: slotId };
  }
  return { ...node, a: anonymizeTree(node.a, slots), b: anonymizeTree(node.b, slots) };
}

function firstLeaf(node: SplitNode): string | undefined {
  if (node.kind === "leaf") return node.sessionId;
  return firstLeaf(node.a) ?? firstLeaf(node.b);
}
