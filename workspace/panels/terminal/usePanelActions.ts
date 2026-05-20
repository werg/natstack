import { useMemo } from "react";
import type { SessionInfo, ShellApi, SplitNode, TerminalState, TerminalTab } from "./types.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";

type SetState = (updater: (state: TerminalState) => TerminalState) => void;
type SetSessions = (updater: (sessions: Record<string, SessionInfo>) => Record<string, SessionInfo>) => void;

export interface PanelActions {
  openTab(command?: string): Promise<string>;
  closeSession(sessionId: string): void;
  splitFocused(direction: "row" | "column", command?: string): Promise<string | undefined>;
  splitSession(sessionId: string, direction: "row" | "column", command?: string): Promise<string | undefined>;
  focusSession(sessionId: string): void;
  sendText(sessionId: string, text: string): Promise<void>;
  runCommand(command: string): Promise<string | undefined>;
  restart(sessionId: string): Promise<string | undefined>;
  restartCommand(sessionId: string): Promise<string | undefined>;
  dispose(sessionId: string): Promise<void>;
  clearScrollback(sessionId: string): Promise<void>;
  setMeta(sessionId: string, key: string, value: unknown): Promise<void>;
  getMeta(sessionId: string, key?: string): Promise<unknown>;
  deleteMeta(sessionId: string, key: string): Promise<void>;
}

export function usePanelActions(args: {
  shell: ShellApi;
  state: TerminalState;
  sessions: Record<string, SessionInfo>;
  setState: SetState;
  setSessions: SetSessions;
}): PanelActions {
  return useMemo(() => createPanelActions(args), [args.shell, args.state, args.sessions, args.setState, args.setSessions]);
}

export function createPanelActions(args: {
  shell: ShellApi;
  state: TerminalState;
  sessions: Record<string, SessionInfo>;
  setState: SetState;
  setSessions: SetSessions;
}): PanelActions {
    const { shell, state, sessions, setState, setSessions } = args;
    const rememberSession = (info: SessionInfo) => {
      setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
      setState((prev) => ({
        ...prev,
        perSession: {
          ...prev.perSession,
          [info.sessionId]: {
            cwd: info.command.cwd,
            originalArgv: info.command.argv,
            readCursor: prev.perSession[info.sessionId]?.readCursor ?? 0,
            lastSeenAt: Date.now(),
            label: prev.perSession[info.sessionId]?.label ?? info.label,
          },
        },
      }));
    };

    const applyScrollbackLimit = async (sessionId: string) => {
      await shell.setScrollbackLimit?.(sessionId, state.scrollbackBytes);
    };

    const forgetSession = (sessionId: string) => {
      setSessions((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      setState((prev) => {
        const { [sessionId]: _removed, ...perSession } = prev.perSession;
        return { ...prev, perSession };
      });
    };

    const disposeReplacedSession = async (sessionId: string) => {
      forgetSession(sessionId);
      await shell.dispose?.(sessionId).catch(() => {});
    };

    const openTab = async (command?: string): Promise<string> => {
      const req = command ? { command: "/bin/sh", args: ["-c", command], label: command } : {};
      const { sessionId } = await shell.open(req);
      const info = await shell.get(sessionId);
      await applyScrollbackLimit(sessionId);
      rememberSession(info);
      const tab: TerminalTab = {
        tabId: crypto.randomUUID(),
        label: info.label || "Shell",
        tree: { kind: "leaf", sessionId },
        focusedSessionId: sessionId,
      };
      setState((prev) => prev.tabs.length ? {
        ...prev,
        tabs: [...prev.tabs, tab],
        activeTabId: tab.tabId,
      } : {
        ...prev,
        tabs: [tab],
        activeTabId: tab.tabId,
      });
      return sessionId;
    };

    const focusSession = (sessionId: string) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => containsSession(tab.tree, sessionId) ? { ...tab, focusedSessionId: sessionId } : tab),
        activeTabId: prev.tabs.find((tab) => containsSession(tab.tree, sessionId))?.tabId ?? prev.activeTabId,
      }));
    };

    const closeSession = (sessionId: string) => {
      if (sessions[sessionId]?.alive) void shell.kill(sessionId).catch(() => {});
      void shell.dispose?.(sessionId).catch(() => {});
      forgetSession(sessionId);
      setState((prev) => {
        const tabs = prev.tabs
          .map((tab) => {
            const tree = removeLeaf(tab.tree, sessionId);
            return { ...tab, tree, focusedSessionId: tab.focusedSessionId === sessionId ? firstLeaf(tree) ?? "" : tab.focusedSessionId };
          })
          .filter((tab): tab is TerminalTab => !!tab.tree && !!tab.focusedSessionId);
        return { ...prev, tabs, activeTabId: tabs.some((tab) => tab.tabId === prev.activeTabId) ? prev.activeTabId : tabs[0]?.tabId };
      });
    };

    const splitSession = async (targetSessionId: string, direction: "row" | "column", command?: string): Promise<string | undefined> => {
      const targetTab = state.tabs.find((tab) => containsSession(tab.tree, targetSessionId));
      if (!targetTab) return openTab(command);
      const focusedInfo = sessions[targetSessionId];
      const cwd = liveSessionCwd(focusedInfo);
      const req = command
        ? { command: "/bin/sh", args: ["-c", command], label: command, cwd }
        : { cwd };
      const { sessionId } = await shell.open(req);
      const info = await shell.get(sessionId);
      await applyScrollbackLimit(sessionId);
      rememberSession(info);
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => tab.tabId === targetTab.tabId ? {
          ...tab,
          tree: splitLeaf(tab.tree, targetSessionId, direction, sessionId),
          focusedSessionId: sessionId,
        } : tab),
        activeTabId: targetTab.tabId,
      }));
      return sessionId;
    };

    const splitFocused = async (direction: "row" | "column", command?: string): Promise<string | undefined> => {
      const activeTab = state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? state.tabs[0];
      if (!activeTab) return openTab(command);
      return splitSession(activeTab.focusedSessionId, direction, command);
    };

    const runCommand = async (command: string): Promise<string | undefined> => splitFocused("row", command);

    const replaceSessionWithOpen = async (sessionId: string, req: Parameters<ShellApi["open"]>[0]): Promise<string | undefined> => {
      const { sessionId: nextSessionId } = await shell.open(req);
      const info = await shell.get(nextSessionId);
      await applyScrollbackLimit(nextSessionId);
      rememberSession(info);
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => containsSession(tab.tree, sessionId)
          ? { ...tab, tree: replaceLeaf(tab.tree, sessionId, nextSessionId), focusedSessionId: nextSessionId }
          : tab),
      }));
      await disposeReplacedSession(sessionId);
      return nextSessionId;
    };

    return {
      openTab,
      closeSession,
      splitFocused,
      splitSession,
      focusSession,
      sendText: (sessionId, text) => shell.write(sessionId, text),
      runCommand,
      restart: async (sessionId) => {
        const result = await shell.restart?.(sessionId);
        if (!result) return undefined;
        const info = await shell.get(result.sessionId);
        await applyScrollbackLimit(result.sessionId);
        rememberSession(info);
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) => containsSession(tab.tree, sessionId)
            ? { ...tab, tree: replaceLeaf(tab.tree, sessionId, result.sessionId), focusedSessionId: result.sessionId }
            : tab),
        }));
        await disposeReplacedSession(sessionId);
        return result.sessionId;
      },
      restartCommand: async (sessionId) => {
        const saved = state.perSession[sessionId];
        const argv = saved?.originalArgv;
        if (!argv?.length) return undefined;
        const [command, ...args] = argv;
        if (!command) return undefined;
        const cwd = liveSessionCwd(sessions[sessionId]) || saved?.cwd || sessions[sessionId]?.command.cwd;
        return replaceSessionWithOpen(sessionId, {
          command,
          args,
          cwd,
          label: argv.join(" "),
        });
      },
      dispose: async (sessionId) => {
        await shell.dispose?.(sessionId);
      },
      clearScrollback: async (sessionId) => {
        await shell.clearScrollback?.(sessionId);
      },
      setMeta: async (sessionId, key, value) => {
        await shell.setMeta?.(sessionId, key, value);
      },
      getMeta: async (sessionId, key) => shell.getMeta?.(sessionId, key),
      deleteMeta: async (sessionId, key) => {
        await shell.deleteMeta?.(sessionId, key);
      },
    };
}

export function containsSession(node: SplitNode | undefined, sessionId: string): boolean {
  if (!node) return false;
  if (node.kind === "leaf") return node.sessionId === sessionId;
  return containsSession(node.a, sessionId) || containsSession(node.b, sessionId);
}

export function splitLeaf(node: SplitNode, targetSessionId: string, direction: "row" | "column", newSessionId: string): SplitNode {
  if (node.kind === "leaf") {
    return node.sessionId === targetSessionId
      ? { kind: "split", direction, ratio: 0.5, a: node, b: { kind: "leaf", sessionId: newSessionId } }
      : node;
  }
  return { ...node, a: splitLeaf(node.a, targetSessionId, direction, newSessionId), b: splitLeaf(node.b, targetSessionId, direction, newSessionId) };
}

export function replaceLeaf(node: SplitNode, oldSessionId: string, newSessionId: string): SplitNode {
  if (node.kind === "leaf") return node.sessionId === oldSessionId ? { kind: "leaf", sessionId: newSessionId } : node;
  return { ...node, a: replaceLeaf(node.a, oldSessionId, newSessionId), b: replaceLeaf(node.b, oldSessionId, newSessionId) };
}

export function updateSplitRatio(node: SplitNode, path: Array<"a" | "b">, ratio: number): SplitNode {
  if (path.length === 0) return node.kind === "split" ? { ...node, ratio } : node;
  if (node.kind === "leaf") return node;
  const [head, ...rest] = path;
  if (!head) return node;
  return { ...node, [head]: updateSplitRatio(node[head], rest, ratio) };
}

function removeLeaf(node: SplitNode, sessionId: string): SplitNode | undefined {
  if (node.kind === "leaf") return node.sessionId === sessionId ? undefined : node;
  const a = removeLeaf(node.a, sessionId);
  const b = removeLeaf(node.b, sessionId);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

function firstLeaf(node: SplitNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "leaf") return node.sessionId;
  return firstLeaf(node.a) ?? firstLeaf(node.b);
}
