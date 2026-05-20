import { Box, Button, Flex, Text, Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";
import { exposeMethod, getStateArgs, setStateArgs, workspace, type WorkspaceUnitStatus } from "@workspace/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandLauncher } from "./CommandLauncher.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { Settings } from "./Settings.js";
import { Sidebar } from "./Sidebar.js";
import { SplitTree } from "./SplitTree.js";
import { SessionStore, sessionIdsConnectKey, useAllSessions } from "./SessionStore.js";
import { TabStrip } from "./TabStrip.js";
import { Toast, useToast } from "./Toast.js";
import { parseApprovedOpenUrl } from "./approvedOpenUrl.js";
import { migrateState } from "./migrateState.js";
import { disposePanelSessions } from "./panelLifecycle.js";
import { findDirectionalPane, type PaneFocusDirection } from "./paneFocus.js";
import { openPort, openUrl } from "./portClick.js";
import { instantiateSavedLayout, restoreTerminalState, saveLayoutFromTab } from "./restore.js";
import { deleteSavedLayout, renameSavedLayout, touchSavedLayout, upsertSavedLayout } from "./savedLayouts.js";
import { settingsToastMessage } from "./settingsFeedback.js";
import { terminalStartupDetail, terminalStartupPendingLabel } from "./startupModel.js";
import { updateTabBadge } from "./tabStripModel.js";
import { containsSession, splitLeaf, updateSplitRatio, usePanelActions } from "./usePanelActions.js";
import { useKeybindings } from "./useKeybindings.js";
import { useShellExtension } from "./useShellExtension.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";
import { isPlainEscapeEvent } from "./keybindings.js";
import type { NotificationSeverity, SessionInfo, SplitNode, TerminalState, TerminalTab } from "./types.js";

declare global {
  interface Window {
    __natstackTerminalTestApi?: {
      openSession(args?: { command?: string }): Promise<{ sessionId: string | undefined }>;
      splitPane(args?: { direction?: "right" | "down"; command?: string }): Promise<{ sessionId: string | undefined }>;
      sendText(args: { sessionId: string; text: string }): Promise<void>;
      getScrollback(args: { sessionId: string; maxBytes?: number }): Promise<{ text: string; cursor: string }>;
      getRenderedText(args: { sessionId: string }): Promise<string>;
      focusSession(args: { sessionId: string }): Promise<void>;
      runCommand(args: { command: string; target?: "here" | "splitRight" | "splitDown" | "tab" }): Promise<{ sessionId: string | undefined }>;
      getMeta(args: { sessionId: string; key?: string }): Promise<unknown>;
      listSessions(): Promise<SessionInfo[]>;
    };
  }
}

export function TerminalApp() {
  const panelAppearance = usePanelTheme();
  const shell = useShellExtension();
  const sessionStore = useMemo(() => new SessionStore(), []);
  const sessions = useAllSessions(sessionStore);
  const [state, setState] = useState<TerminalState>(() => migrateState(getStateArgs<TerminalState>()));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarSearchFocusToken, setSidebarSearchFocusToken] = useState(0);
  const [restored, setRestored] = useState(false);
  const [initialOpenStatus, setInitialOpenStatus] = useState<"idle" | "opening" | "waitingApproval" | "failed">("idle");
  const [initialOpenError, setInitialOpenError] = useState<string | null>(null);
  const [initialOpenStartedAt, setInitialOpenStartedAt] = useState<number | null>(null);
  const [newTabPending, setNewTabPending] = useState(false);
  const [newTabStartedAt, setNewTabStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shellUnit, setShellUnit] = useState<ShellUnitStatus | null>(null);
  const [resizeKey, setResizeKey] = useState(0);
  const initialOpenPendingRef = useRef(state.tabs.length === 0);
  const initialOpenInFlightRef = useRef(false);
  const initialOpenHintTimerRef = useRef<number | null>(null);
  const defaultOpenInFlightRef = useRef(false);
  const approvedOpenUrlIdsRef = useRef(new Set<string>());
  const latestStateRef = useRef(state);
  const latestShellRef = useRef(shell);
  const { toast, showToast } = useToast();

  const activeTab = state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? state.tabs[0];
  const appearance = state.themeOverride === "auto" ? panelAppearance : state.themeOverride;
  const sessionIds = useMemo(() => Object.keys(sessions), [sessions]);
  const sessionIdsKey = sessionIdsConnectKey(sessionIds);
  const initialOpenBusy = initialOpenStatus === "opening" || initialOpenStatus === "waitingApproval";
  const sessionOpenPending = newTabPending || initialOpenBusy;
  const sessionOpenElapsedSeconds = newTabStartedAt
    ? Math.max(0, Math.floor((now - newTabStartedAt) / 1000))
    : initialOpenStartedAt
      ? Math.max(0, Math.floor((now - initialOpenStartedAt) / 1000))
      : 0;
  const sessionOpenPendingLabel = terminalStartupPendingLabel({
    pending: sessionOpenPending,
    elapsedSeconds: sessionOpenElapsedSeconds,
    shellUnit,
  });
  const setSessions = useCallback((updater: (sessions: Record<string, SessionInfo>) => Record<string, SessionInfo>) => {
    sessionStore.replace(updater(sessionStore.getSnapshot()));
  }, [sessionStore]);
  const actions = usePanelActions({ shell, state, sessions, setState, setSessions });
  const visibleTree: SplitNode | undefined = activeTab
    ? state.zoomedSessionId && containsSession(activeTab.tree, state.zoomedSessionId)
      ? { kind: "leaf", sessionId: state.zoomedSessionId }
      : activeTab.tree
    : undefined;

  useEffect(() => {
    latestStateRef.current = state;
    latestShellRef.current = shell;
  }, [shell, state]);

  useEffect(() => () => {
    disposePanelSessions(latestShellRef.current, latestStateRef.current);
  }, []);

  useEffect(() => sessionStore.connect(shell, sessionIdsKey ? sessionIdsKey.split("\0") : []), [sessionIdsKey, sessionStore, shell]);

  useEffect(() => {
    void setStateArgs(state as unknown as Record<string, unknown>);
  }, [state]);

  const openInitialTab = useCallback(async (force = false): Promise<string | undefined> => {
    if (force) initialOpenPendingRef.current = true;
    if (initialOpenInFlightRef.current || !initialOpenPendingRef.current) return undefined;
    initialOpenInFlightRef.current = true;
    setInitialOpenStartedAt(Date.now());
    setInitialOpenStatus("opening");
    setInitialOpenError(null);
    if (initialOpenHintTimerRef.current) window.clearTimeout(initialOpenHintTimerRef.current);
    initialOpenHintTimerRef.current = window.setTimeout(() => {
      setInitialOpenStatus("waitingApproval");
    }, 1000);
    try {
      const sessionId = await actions.openTab();
      initialOpenPendingRef.current = false;
      setInitialOpenStatus("idle");
      setInitialOpenStartedAt(null);
      return sessionId;
    } catch (err) {
      setInitialOpenError(err instanceof Error ? err.message : "Terminal session failed to start");
      initialOpenPendingRef.current = false;
      setInitialOpenStatus("failed");
      setInitialOpenStartedAt(null);
      return undefined;
    } finally {
      if (initialOpenHintTimerRef.current) {
        window.clearTimeout(initialOpenHintTimerRef.current);
        initialOpenHintTimerRef.current = null;
      }
      initialOpenInFlightRef.current = false;
    }
  }, [actions]);

  const runInteractiveOpen = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    if (defaultOpenInFlightRef.current || initialOpenInFlightRef.current) {
      showToast(sessionOpenPendingLabel ?? "Terminal request already in progress");
      return undefined;
    }
    defaultOpenInFlightRef.current = true;
    setNewTabPending(true);
    setNewTabStartedAt(Date.now());
    try {
      return await operation();
    } catch (err) {
      showToast(err instanceof Error ? `Terminal failed to start: ${err.message}` : "Terminal failed to start");
      return undefined;
    } finally {
      defaultOpenInFlightRef.current = false;
      setNewTabPending(false);
      setNewTabStartedAt(null);
    }
  }, [sessionOpenPendingLabel, showToast]);

  const openDefaultTab = useCallback(async (): Promise<string | undefined> => {
    if (state.tabs.length === 0 || initialOpenInFlightRef.current || initialOpenStatus === "opening" || initialOpenStatus === "waitingApproval" || initialOpenStatus === "failed") {
      return openInitialTab(initialOpenStatus === "failed");
    }
    return runInteractiveOpen(() => actions.openTab());
  }, [actions, initialOpenStatus, openInitialTab, runInteractiveOpen, state.tabs.length]);

  useEffect(() => () => {
    if (initialOpenHintTimerRef.current) window.clearTimeout(initialOpenHintTimerRef.current);
  }, []);

  useEffect(() => {
    if (initialOpenStatus !== "opening" && initialOpenStatus !== "waitingApproval" && !newTabPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [initialOpenStatus, newTabPending]);

  useEffect(() => {
    let cancelled = false;
    function pickShellUnit(units: WorkspaceUnitStatus[]) {
      const match = units.find((unit) => unit.name === "@workspace-extensions/shell" || unit.source.endsWith("/@workspace-extensions/shell"));
      if (!cancelled) setShellUnit(match ? normalizeShellUnit(match) : null);
    }
    void workspace.units.list().then(pickShellUnit).catch(() => {});
    (async () => {
      try {
        for await (const units of workspace.units.watch()) {
          if (cancelled) break;
          pickShellUnit(units);
        }
      } catch {
        // Unit status is advisory; terminal startup still works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    for (const session of Object.values(sessions)) {
      if (state.tabs.some((tab) => containsSession(tab.tree, session.sessionId))) continue;
      const spawn = parseSnugSpawn(session.meta["snugSpawn"]);
      if (!spawn) continue;
      const parentTab = state.tabs.find((tab) => containsSession(tab.tree, spawn.parentSessionId));
      if (!parentTab) continue;
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => tab.tabId === parentTab.tabId ? {
          ...tab,
          tree: splitLeaf(tab.tree, spawn.parentSessionId, spawn.direction, session.sessionId),
          focusedSessionId: session.sessionId,
        } : tab),
        activeTabId: parentTab.tabId,
        perSession: {
          ...prev.perSession,
          [session.sessionId]: {
            cwd: liveSessionCwd(session) ?? session.command.cwd,
            originalArgv: session.command.argv,
            readCursor: 0,
            lastSeenAt: Date.now(),
          },
        },
      }));
    }
  }, [sessions, state.tabs]);

  useEffect(() => {
    for (const session of Object.values(sessions)) {
      const approved = parseApprovedOpenUrl(session.meta["snugOpenUrl"]);
      if (!approved || approvedOpenUrlIdsRef.current.has(approved.id)) continue;
      approvedOpenUrlIdsRef.current.add(approved.id);
      void openUrl(approved.url);
      void actions.deleteMeta(session.sessionId, "snugOpenUrl").catch(() => {});
      setState((prev) => ({
        ...prev,
        notifications: [{
          notifId: crypto.randomUUID(),
          sessionId: session.sessionId,
          severity: "info",
          title: "Open URL",
          message: approved.url,
          timestamp: approved.requestedAt,
          read: false,
          source: "snug",
        }, ...prev.notifications],
      }));
    }
  }, [actions, sessions]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (restored) return;
      setRestored(true);
      if (state.tabs.length === 0) {
        await openInitialTab();
        return;
      }
      initialOpenPendingRef.current = false;
      const result = await restoreTerminalState(shell, state);
      if (cancelled) return;
      setSessions((prev) => ({ ...prev, ...result.sessions }));
      setState((prev) => ({
        ...prev,
        tabs: result.tabs,
        activeTabId: result.activeTabId,
        perSession: result.perSession,
      }));
      if (result.tabs.length === 0) {
        initialOpenPendingRef.current = true;
        await openInitialTab();
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.tabs.length > 0) return;
    let cancelled = false;
    const retryOpen = async () => {
      if (initialOpenStatus === "failed") return;
      if (cancelled || initialOpenInFlightRef.current) return;
      initialOpenPendingRef.current = true;
      await openInitialTab();
    };
    void retryOpen();
    const timer = setInterval(() => void retryOpen(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initialOpenStatus, openInitialTab, state.tabs.length]);

  useKeybindings(state.keybindings, {
    palette: () => setPaletteOpen(true),
    sessionSearch: () => {
      setState((prev) => ({ ...prev, sidebarCollapsed: false }));
      setSidebarSearchFocusToken((token) => token + 1);
    },
    newTab: () => void openDefaultTab(),
    closeTab: () => activeTab && closeTab(activeTab.tabId),
    splitRight: () => void runInteractiveOpen(() => actions.splitFocused("row")),
    splitDown: () => void runInteractiveOpen(() => actions.splitFocused("column")),
    closePane: () => activeTab && closeFocusedPane(activeTab),
    nextTab: () => selectTabByOffset(1),
    prevTab: () => selectTabByOffset(-1),
    toggleSidebar: () => setState((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed })),
    toggleNotifications: () => setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen })),
    settings: () => setSettingsOpen((open) => !open),
    find: () => window.dispatchEvent(new CustomEvent("terminal:find")),
    findNext: () => window.dispatchEvent(new CustomEvent("terminal:find-next")),
    findPrev: () => window.dispatchEvent(new CustomEvent("terminal:find-previous")),
    copy: () => window.dispatchEvent(new CustomEvent("terminal:copy")),
    paste: () => window.dispatchEvent(new CustomEvent("terminal:paste")),
    clear: () => activeTab && void actions.clearScrollback(activeTab.focusedSessionId),
    zoom: () => setState((prev) => ({ ...prev, zoomedSessionId: prev.zoomedSessionId ? undefined : activeTab?.focusedSessionId })),
    focusUp: () => activeTab && focusPaneByDirection(activeTab, "up"),
    focusDown: () => activeTab && focusPaneByDirection(activeTab, "down"),
    focusLeft: () => activeTab && focusPaneByDirection(activeTab, "left"),
    focusRight: () => activeTab && focusPaneByDirection(activeTab, "right"),
    jumpToLatestUnread: () => focusUnreadSession("latest"),
    nextUnread: () => focusUnreadSession("next"),
    fontUp: () => setState((prev) => {
      const fontSize = Math.min(24, prev.fontSize + 1);
      showToast(`Font ${fontSize}px`);
      return { ...prev, fontSize };
    }),
    fontDown: () => setState((prev) => {
      const fontSize = Math.max(9, prev.fontSize - 1);
      showToast(`Font ${fontSize}px`);
      return { ...prev, fontSize };
    }),
    fontReset: () => {
      showToast("Font 13px");
      setState((prev) => ({ ...prev, fontSize: 13 }));
    },
  });

  useEffect(() => {
    if (!state.zoomedSessionId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscapeEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setState((prev) => ({ ...prev, zoomedSessionId: undefined }));
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [state.zoomedSessionId]);

  useEffect(() => {
    const terminalApi = {
      openSession: async (args?: { command?: string }) => ({ sessionId: args?.command ? await runInteractiveOpen(() => actions.openTab(args.command)) : await openDefaultTab() }),
      splitPane: async (args?: { direction?: "right" | "down"; command?: string }) => {
        const direction = args?.direction === "down" ? "column" : "row";
        return { sessionId: await runInteractiveOpen(() => actions.splitFocused(direction, args?.command)) };
      },
      sendText: async (args: { sessionId: string; text: string }) => actions.sendText(args.sessionId, args.text),
      getScrollback: async (args: { sessionId: string; maxBytes?: number }) => shell.getScrollback(args.sessionId, args.maxBytes),
      getRenderedText: async (args: { sessionId: string }) =>
        window.__natstackTerminalPaneTestRegistry?.[args.sessionId]?.serialize() ?? "",
      focusSession: async (args: { sessionId: string }) => actions.focusSession(args.sessionId),
      runCommand: async (args: { command: string; target?: "here" | "splitRight" | "splitDown" | "tab" }) => ({ sessionId: await runCommand(args.command, args.target ?? "splitRight") }),
      getMeta: async (args: { sessionId: string; key?: string }) => actions.getMeta(args.sessionId, args.key),
      listSessions: async () => Object.values(sessions),
    };

    exposeMethod("terminal.openSession", terminalApi.openSession);
    exposeMethod("terminal.splitPane", terminalApi.splitPane);
    exposeMethod("terminal.sendText", terminalApi.sendText);
    exposeMethod("terminal.getScrollback", terminalApi.getScrollback);
    exposeMethod("terminal.getRenderedText", terminalApi.getRenderedText);
    exposeMethod("terminal.focusSession", terminalApi.focusSession);
    exposeMethod("terminal.runCommand", terminalApi.runCommand);
    exposeMethod("terminal.listSessions", terminalApi.listSessions);
    window.__natstackTerminalTestApi = terminalApi;
    exposeMethod("terminal.setBadge", async (args: { tabId?: string; text?: string; color?: string; severity?: NotificationSeverity }) => {
      setState((prev) => ({
        ...prev,
        tabs: updateTabBadge(prev.tabs, prev.activeTabId, args),
      }));
    });
    exposeMethod("terminal.getMeta", async (args: { sessionId: string; key?: string }) => actions.getMeta(args.sessionId, args.key));
    exposeMethod("terminal.setMeta", async (args: { sessionId: string; key: string; value: unknown }) => actions.setMeta(args.sessionId, args.key, args.value));
    exposeMethod("terminal.deleteMeta", async (args: { sessionId: string; key: string }) => actions.deleteMeta(args.sessionId, args.key));
    return () => {
      if (window.__natstackTerminalTestApi === terminalApi) {
        delete window.__natstackTerminalTestApi;
      }
    };
  }, [actions, openDefaultTab, runInteractiveOpen, sessions]);

  async function runCommand(commandLine: string, target: "here" | "splitRight" | "splitDown" | "tab"): Promise<string | undefined> {
    setState((prev) => ({ ...prev, paletteHistory: [commandLine, ...prev.paletteHistory.filter((item) => item !== commandLine)].slice(0, 20) }));
    if (target === "here") {
      if (!activeTab) return undefined;
      await actions.sendText(activeTab.focusedSessionId, commandLine.endsWith("\n") ? commandLine : `${commandLine}\n`);
      return activeTab.focusedSessionId;
    }
    if (target === "tab") return runInteractiveOpen(() => actions.openTab(commandLine));
    return runInteractiveOpen(() => actions.splitFocused(target === "splitDown" ? "column" : "row", commandLine));
  }

  function runBuiltin(action: string) {
    if (action === "newTab") void openDefaultTab();
    else if (action === "splitRight") void runInteractiveOpen(() => actions.splitFocused("row"));
    else if (action === "splitDown") void runInteractiveOpen(() => actions.splitFocused("column"));
    else if (action === "clear" && activeTab) void actions.clearScrollback(activeTab.focusedSessionId);
    else if (action === "toggleFind") window.dispatchEvent(new CustomEvent("terminal:find"));
    else if (action === "toggleNotifications") setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen }));
  }

  function closeTab(tabId: string) {
    const tab = state.tabs.find((item) => item.tabId === tabId);
    if (tab) {
      const running = collectSessionIds(tab.tree).filter((sessionId) => sessions[sessionId]?.alive);
      if (running.length > 0 && !window.confirm(`Close ${running.length} running terminal${running.length === 1 ? "" : "s"}?`)) return;
      for (const sessionId of collectSessionIds(tab.tree)) actions.closeSession(sessionId);
    }
    setState((prev) => {
      const tabs = prev.tabs.filter((item) => item.tabId !== tabId);
      return { ...prev, tabs, activeTabId: prev.activeTabId === tabId ? tabs[0]?.tabId : prev.activeTabId };
    });
  }

  function closeFocusedPane(tab: TerminalTab) {
    const session = sessions[tab.focusedSessionId];
    if (session?.alive && !window.confirm("Close this running terminal?")) return;
    actions.closeSession(tab.focusedSessionId);
  }

  function selectTabByOffset(offset: number) {
    if (state.tabs.length === 0) return;
    const current = Math.max(0, state.tabs.findIndex((tab) => tab.tabId === state.activeTabId));
    const next = state.tabs[(current + offset + state.tabs.length) % state.tabs.length];
    if (!next) return;
    setState((prev) => markTabRead({ ...prev, activeTabId: next.tabId }, next.tabId));
  }

  function focusPaneByDirection(tab: TerminalTab, direction: PaneFocusDirection) {
    const nextSessionId = findDirectionalPane(tab.tree, tab.focusedSessionId, direction);
    if (!nextSessionId) return;
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((item) => item.tabId === tab.tabId ? { ...item, focusedSessionId: nextSessionId } : item),
    }));
  }

  function focusUnreadSession(mode: "latest" | "next") {
    const unread = state.notifications
      .filter((item) => !item.read && state.tabs.some((tab) => containsSession(tab.tree, item.sessionId)))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (unread.length === 0) return;
    const currentSessionId = activeTab?.focusedSessionId;
    const target = mode === "next" && currentSessionId
      ? unread[(unread.findIndex((item) => item.sessionId === currentSessionId) + 1 + unread.length) % unread.length] ?? unread[0]
      : unread[0];
    if (!target) return;
    const tab = state.tabs.find((item) => containsSession(item.tree, target.sessionId));
    if (!tab) return;
    setState((prev) => markSessionRead({
      ...prev,
      activeTabId: tab.tabId,
      tabs: prev.tabs.map((item) => item.tabId === tab.tabId ? { ...item, focusedSessionId: target.sessionId } : item),
    }, target.sessionId));
  }

  function saveCurrentLayout(tabId: string) {
    const tab = state.tabs.find((item) => item.tabId === tabId);
    if (!tab) return;
    const name = window.prompt("Layout name", tab.label);
    if (!name?.trim()) return;
    const layout = saveLayoutFromTab(tab, state.perSession, name.trim(), sessions);
    setState((prev) => ({ ...prev, savedLayouts: upsertSavedLayout(prev.savedLayouts, layout) }));
  }

  function renameTab(tabId: string) {
    const tab = state.tabs.find((item) => item.tabId === tabId);
    if (!tab) return;
    const label = window.prompt("Tab name", tab.label);
    if (!label?.trim()) return;
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((item) => item.tabId === tabId ? { ...item, label: label.trim() } : item),
    }));
  }

  function customizeTab(tabId: string) {
    const tab = state.tabs.find((item) => item.tabId === tabId);
    if (!tab) return;
    const iconInput = window.prompt("Tab icon (optional)", tab.icon ?? "");
    if (iconInput === null) return;
    const accentInput = window.prompt("Tab color (Radix scale, e.g. blue, green, amber, red)", tab.accent ?? "");
    if (accentInput === null) return;
    const accent = normalizeRadixScale(accentInput);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((item) => item.tabId === tabId ? {
        ...item,
        icon: iconInput.trim() || undefined,
        accent,
      } : item),
    }));
  }

  async function duplicateTab(tabId: string) {
    const tab = state.tabs.find((item) => item.tabId === tabId);
    if (!tab) return;
    const layout = saveLayoutFromTab(tab, state.perSession, `${tab.label} copy`, sessions);
    const result = await runInteractiveOpen(() => instantiateSavedLayout(shell, { ...layout, id: crypto.randomUUID(), updatedAt: Date.now() }, { scrollbackBytes: state.scrollbackBytes }));
    if (!result) return;
    setSessions((prev) => ({ ...prev, ...result.sessions }));
    setState((prev) => ({
      ...prev,
      tabs: [...prev.tabs, { ...result.tab, label: `${tab.label} copy`, icon: tab.icon, accent: tab.accent }],
      activeTabId: result.tab.tabId,
      perSession: { ...prev.perSession, ...result.perSession },
    }));
  }

  function closeOtherTabs(tabId: string) {
    const others = state.tabs.filter((tab) => tab.tabId !== tabId);
    const running = others.flatMap((tab) => collectSessionIds(tab.tree)).filter((sessionId) => sessions[sessionId]?.alive);
    if (running.length > 0 && !window.confirm(`Close ${running.length} running terminal${running.length === 1 ? "" : "s"} in other tabs?`)) return;
    for (const tab of others) {
      for (const sessionId of collectSessionIds(tab.tree)) actions.closeSession(sessionId);
    }
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.filter((tab) => tab.tabId === tabId),
      activeTabId: tabId,
    }));
  }

  async function loadLayout(layoutId: string) {
    const layout = state.savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    const result = await runInteractiveOpen(() => instantiateSavedLayout(shell, layout, { scrollbackBytes: state.scrollbackBytes }));
    if (!result) return;
    setSessions((prev) => ({ ...prev, ...result.sessions }));
    setState((prev) => ({
      ...prev,
      tabs: [...prev.tabs, result.tab],
      activeTabId: result.tab.tabId,
      perSession: { ...prev.perSession, ...result.perSession },
      savedLayouts: touchSavedLayout(prev.savedLayouts, layoutId),
    }));
  }

  function renameLayout(layoutId: string) {
    const layout = state.savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    const name = window.prompt("Layout name", layout.name);
    if (!name?.trim()) return;
    setState((prev) => ({ ...prev, savedLayouts: renameSavedLayout(prev.savedLayouts, layoutId, name.trim()) }));
  }

  function deleteLayout(layoutId: string) {
    const layout = state.savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    if (!window.confirm(`Delete saved layout "${layout.name}"?`)) return;
    setState((prev) => ({ ...prev, savedLayouts: deleteSavedLayout(prev.savedLayouts, layoutId) }));
  }

  return (
    <Theme appearance={appearance}>
      <Flex height="100vh" width="100vw" style={{ overflow: "hidden", background: "var(--gray-2)" }}>
        <Sidebar
          tabs={state.tabs}
          sessions={sessions}
          notifications={state.notifications}
          activeTabId={state.activeTabId}
          collapsed={state.sidebarCollapsed}
          focusSearchToken={sidebarSearchFocusToken}
          newTabPending={sessionOpenPending}
          newTabPendingLabel={sessionOpenPendingLabel}
          onCollapsedChange={(collapsed) => setState((prev) => ({ ...prev, sidebarCollapsed: collapsed }))}
          onSelect={(tabId) => setState((prev) => markTabRead({ ...prev, activeTabId: tabId }, tabId))}
          onFocusSession={actions.focusSession}
          onNewTab={() => void openDefaultTab()}
          onOpenPort={(sessionId, port) => void openPort(port, sessions[sessionId]?.detectedUrls)}
        />
        <Flex direction="column" style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--color-page-background)", position: "relative" }}>
          <TabStrip
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            sessions={sessions}
            notifications={state.notifications}
            newTabPending={sessionOpenPending}
            newTabPendingLabel={sessionOpenPendingLabel}
            onSelect={(tabId) => setState((prev) => markTabRead({ ...prev, activeTabId: tabId }, tabId))}
            onNewTab={() => void openDefaultTab()}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            onDuplicate={(tabId) => void duplicateTab(tabId)}
            onRename={renameTab}
            onCustomize={customizeTab}
            onToggleNotifications={() => setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen }))}
            onSaveLayout={saveCurrentLayout}
          />
          <Flex align="center" justify="end" px="2" py="1" style={{ borderBottom: "1px solid var(--gray-4)" }}>
            <Settings
              open={settingsOpen}
              fontSize={state.fontSize}
              fontFamily={state.fontFamily}
              scrollbackBytes={state.scrollbackBytes}
              themeOverride={state.themeOverride}
              pasteMode={state.pasteMode}
              imagePasteRelative={state.imagePasteRelative}
              keybindings={state.keybindings}
              onOpenChange={setSettingsOpen}
              onChange={(next) => {
                const message = settingsToastMessage(next);
                if (message) showToast(message);
                setState((prev) => ({ ...prev, ...next }));
                if (next.scrollbackBytes) {
                  for (const sessionId of Object.keys(sessions)) void shell.setScrollbackLimit?.(sessionId, next.scrollbackBytes);
                }
              }}
            />
          </Flex>
        <Box p="2" style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0, height: "100%", overflow: "hidden" }}>
          {activeTab && visibleTree ? (
            <SplitTree
              node={visibleTree}
              sessions={sessions}
              notifications={state.notifications}
              focusedSessionId={activeTab.focusedSessionId}
              shell={shell}
              fontSize={state.fontSize}
              fontFamily={state.fontFamily}
              appearance={appearance}
              pasteMode={state.pasteMode}
              imagePasteRelative={state.imagePasteRelative}
              resizeKey={resizeKey}
              onFocus={(sessionId) => setState((prev) => ({
                ...prev,
                tabs: prev.tabs.map((tab) => tab.tabId === activeTab.tabId ? { ...tab, focusedSessionId: sessionId } : tab),
              }))}
              onClose={(sessionId) => {
                const session = sessions[sessionId];
                if (session?.alive && !window.confirm("Close this running terminal?")) return;
                actions.closeSession(sessionId);
              }}
              onSplit={(sessionId, direction) => {
                void runInteractiveOpen(() => actions.splitSession(sessionId, direction));
              }}
              onOpenPort={(sessionId, port) => void openPort(port, sessions[sessionId]?.detectedUrls)}
              onOpenUrl={(_sessionId, url) => void openUrl(url)}
              onClear={(sessionId) => void actions.clearScrollback(sessionId)}
              onDuplicate={(sessionId) => void runInteractiveOpen(() => actions.splitSession(sessionId, "row"))}
              onRestart={(sessionId) => void actions.restart(sessionId)}
              onRestartCommand={(sessionId) => void actions.restartCommand(sessionId)}
              onFind={(sessionId) => {
                setState((prev) => ({
                  ...prev,
                  tabs: prev.tabs.map((tab) => tab.tabId === activeTab.tabId ? { ...tab, focusedSessionId: sessionId } : tab),
                }));
                window.dispatchEvent(new CustomEvent("terminal:find"));
              }}
              onZoom={(sessionId) => setState((prev) => ({
                ...prev,
                tabs: prev.tabs.map((tab) => containsSession(tab.tree, sessionId) ? { ...tab, focusedSessionId: sessionId } : tab),
                zoomedSessionId: prev.zoomedSessionId === sessionId ? undefined : sessionId,
              }))}
              onRatioChange={(path, ratio) => {
                setState((prev) => ({
                  ...prev,
                  tabs: prev.tabs.map((tab) => tab.tabId === activeTab.tabId ? { ...tab, tree: updateSplitRatio(tab.tree, path, ratio) } : tab),
                }));
                setResizeKey((value) => value + 1);
              }}
              onNotification={(sessionId, notification) => {
                setState((prev) => ({
                  ...prev,
                  notifications: [{ notifId: crypto.randomUUID(), sessionId, severity: notification.severity, title: notification.title, message: notification.message, timestamp: Date.now(), read: false, source: notification.source }, ...prev.notifications],
                }));
              }}
            />
          ) : (
            <EmptyTerminalState
              status={initialOpenStatus}
              error={initialOpenError}
              shellUnit={shellUnit}
              elapsedSeconds={initialOpenStartedAt ? Math.max(0, Math.floor((now - initialOpenStartedAt) / 1000)) : 0}
              onOpen={() => void openDefaultTab()}
            />
          )}
        </Box>
        </Flex>
        <Toast toast={toast} />
        {state.notificationCenterOpen ? (
          <NotificationCenter
            notifications={state.notifications}
            sessions={sessions}
            filter={state.notificationFilter}
            onFilterChange={(filter) => setState((prev) => ({ ...prev, notificationFilter: filter }))}
            onJump={(sessionId) => {
              const tab = state.tabs.find((item) => containsSession(item.tree, sessionId));
              if (tab) setState((prev) => markSessionRead({ ...prev, activeTabId: tab.tabId }, sessionId));
            }}
            onMarkRead={(notifId) => setState((prev) => ({ ...prev, notifications: prev.notifications.map((item) => item.notifId === notifId ? { ...item, read: true } : item) }))}
            onDismiss={(notifId) => setState((prev) => ({ ...prev, notifications: prev.notifications.filter((item) => item.notifId !== notifId) }))}
            onMarkAllRead={() => setState((prev) => ({ ...prev, notifications: prev.notifications.map((item) => ({ ...item, read: true })) }))}
            onClearAll={() => setState((prev) => ({ ...prev, notifications: [] }))}
          />
        ) : null}
      </Flex>
      <CommandLauncher
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        cwd={activeTab ? liveSessionCwd(sessions[activeTab.focusedSessionId]) : undefined}
        history={state.paletteHistory}
        layouts={state.savedLayouts}
        onRun={async (command, target) => { await runCommand(command, target); }}
        onBuiltin={runBuiltin}
        onLoadLayout={loadLayout}
        onRenameLayout={renameLayout}
        onDeleteLayout={deleteLayout}
      />
    </Theme>
  );
}

function EmptyTerminalState(props: {
  status: "idle" | "opening" | "waitingApproval" | "failed";
  error: string | null;
  shellUnit: ShellUnitStatus | null;
  elapsedSeconds: number;
  onOpen(): void;
}) {
  const isBusy = props.status === "opening" || props.status === "waitingApproval";
  const copy = terminalStartupDetail({
    status: props.status,
    elapsedSeconds: props.elapsedSeconds,
    shellUnit: props.shellUnit,
    error: props.error,
  });
  const elapsed = props.elapsedSeconds >= 1 ? `Waiting ${props.elapsedSeconds}s` : undefined;

  return (
    <Flex height="100%" align="center" justify="center" p="4">
      <Flex direction="column" align="center" gap="3" style={{ maxWidth: 360, textAlign: "center" }}>
        <Text size="3" weight="medium">{copy.title}</Text>
        <Text size="2" color="gray">{copy.detail}</Text>
        {elapsed ? <Text size="1" color="gray" role="status" aria-live="polite">{elapsed}</Text> : null}
        <Button onClick={props.onOpen} disabled={isBusy}>
          {isBusy ? "Waiting..." : props.status === "failed" ? "Retry" : "Open terminal"}
        </Button>
      </Flex>
    </Flex>
  );
}

type ShellUnitStatus = WorkspaceUnitStatus & {
  pendingApproval?: { kind: string; submittedAt: number } | null;
};

function normalizeShellUnit(unit: WorkspaceUnitStatus): ShellUnitStatus {
  return unit as ShellUnitStatus;
}

function collectSessionIds(node: TerminalTab["tree"]): string[] {
  if (node.kind === "leaf") return [node.sessionId];
  return [...collectSessionIds(node.a), ...collectSessionIds(node.b)];
}

function markTabRead(state: TerminalState, tabId: string): TerminalState {
  const tab = state.tabs.find((item) => item.tabId === tabId);
  if (!tab) return state;
  const ids = new Set(collectSessionIds(tab.tree));
  const now = Date.now();
  return {
    ...state,
    notifications: state.notifications.map((item) => ids.has(item.sessionId) ? { ...item, read: true } : item),
    perSession: Object.fromEntries(Object.entries(state.perSession).map(([sessionId, value]) => [
      sessionId,
      ids.has(sessionId) ? { ...value, readCursor: now, lastSeenAt: now } : value,
    ])),
  };
}

function markSessionRead(state: TerminalState, sessionId: string): TerminalState {
  const now = Date.now();
  return {
    ...state,
    notifications: state.notifications.map((item) => item.sessionId === sessionId ? { ...item, read: true } : item),
    perSession: {
      ...state.perSession,
      [sessionId]: {
        ...(state.perSession[sessionId] ?? { cwd: "", readCursor: 0, lastSeenAt: 0 }),
        readCursor: now,
        lastSeenAt: now,
      },
    },
  };
}

function normalizeRadixScale(value: string): string | undefined {
  const clean = value.trim().toLowerCase();
  return /^(gray|mauve|slate|sage|olive|sand|tomato|red|ruby|crimson|pink|plum|purple|violet|iris|indigo|blue|cyan|teal|jade|green|grass|brown|orange|sky|mint|lime|yellow|amber)$/.test(clean)
    ? clean
    : undefined;
}

function parseSnugSpawn(value: unknown): { parentSessionId: string; direction: "row" | "column" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record["parentSessionId"] === "string" && (record["direction"] === "row" || record["direction"] === "column")
    ? { parentSessionId: record["parentSessionId"], direction: record["direction"] }
    : undefined;
}
