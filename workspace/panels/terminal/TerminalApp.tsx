import { Box, Button, Flex, Text, Theme } from "@radix-ui/themes";
import { useIsMobile, usePanelTheme } from "@workspace/react";
import {
  exposeMethod,
  getStateArgs,
  setStateArgs,
  workspace,
  type WorkspaceUnitStatus,
} from "@workspace/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandLauncher } from "./CommandLauncher.js";
import { documentTitleForSession } from "./documentTitle.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { ScratchOverlay } from "./ScratchOverlay.js";
import { SCRATCH_BUFFER_MAX_COUNT } from "./migrateState.js";
import { Settings } from "./Settings.js";
import { SessionStore, sessionIdsConnectKey, useAllSessions } from "./SessionStore.js";
import { SplitTree } from "./SplitTree.js";
import { Toast, useToast } from "./Toast.js";
import { parseApprovedOpenUrl } from "./approvedOpenUrl.js";
import { type CommandRunTarget } from "./commandLauncherModel.js";
import { isPlainEscapeEvent } from "./keybindings.js";
import { migrateState } from "./migrateState.js";
import { disposePanelSessions } from "./panelLifecycle.js";
import { findDirectionalPane, type PaneFocusDirection } from "./paneFocus.js";
import { openPort, openUrl } from "./portClick.js";
import { restoreTerminalState } from "./restore.js";
import { settingsToastMessage } from "./settingsFeedback.js";
import { terminalStartupDetail, terminalStartupPendingLabel } from "./startupModel.js";
import {
  containsSession,
  splitLeaf,
  updateSplitRatio,
  usePanelActions,
} from "./usePanelActions.js";
import { useKeybindings } from "./useKeybindings.js";
import { useShellExtension } from "./useShellExtension.js";
import { liveSessionCwd } from "./vscodeShellIntegrationMeta.js";
import type { ScratchBuffer, SessionInfo, SplitNode, TerminalState } from "./types.js";

declare global {
  interface Window {
    __natstackTerminalTestApi?: {
      openSession(args?: { command?: string }): Promise<{ sessionId: string | undefined }>;
      splitPane(args?: {
        direction?: "right" | "down";
        command?: string;
      }): Promise<{ sessionId: string | undefined }>;
      sendText(args: { sessionId: string; text: string }): Promise<void>;
      getScrollback(args: {
        sessionId: string;
        maxBytes?: number;
      }): Promise<{ text: string; cursor: string }>;
      getRenderedText(args: { sessionId: string }): Promise<string>;
      focusSession(args: { sessionId: string }): Promise<void>;
      runCommand(args: {
        command: string;
        target?: CommandRunTarget;
      }): Promise<{ sessionId: string | undefined }>;
      getMeta(args: { sessionId: string; key?: string }): Promise<unknown>;
      listSessions(): Promise<SessionInfo[]>;
    };
  }
}

export function TerminalApp() {
  const panelAppearance = usePanelTheme();
  const isMobile = useIsMobile();
  const shell = useShellExtension();
  const sessionStore = useMemo(() => new SessionStore(), []);
  const sessions = useAllSessions(sessionStore);
  const [state, setState] = useState<TerminalState>(() =>
    migrateState(getStateArgs<TerminalState>())
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const [initialOpenStatus, setInitialOpenStatus] = useState<
    "idle" | "opening" | "waitingApproval" | "failed"
  >("idle");
  const [initialOpenError, setInitialOpenError] = useState<string | null>(null);
  const [initialOpenStartedAt, setInitialOpenStartedAt] = useState<number | null>(null);
  const [sessionOpenPending, setSessionOpenPending] = useState(false);
  const [sessionOpenStartedAt, setSessionOpenStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [shellUnit, setShellUnit] = useState<ShellUnitStatus | null>(null);
  const [resizeKey, setResizeKey] = useState(0);
  const initialOpenPendingRef = useRef(!state.tree);
  const initialOpenInFlightRef = useRef(false);
  const initialOpenHintTimerRef = useRef<number | null>(null);
  const interactiveOpenInFlightRef = useRef(false);
  const approvedOpenUrlIdsRef = useRef(new Set<string>());
  const latestStateRef = useRef(state);
  const latestShellRef = useRef(shell);
  const prevScratchOpenRef = useRef(state.scratchOpen);
  const { toast, showToast } = useToast();

  const appearance = state.themeOverride === "auto" ? panelAppearance : state.themeOverride;
  const focusedSessionId = state.focusedSessionId;
  const focusedSession = focusedSessionId ? sessions[focusedSessionId] : undefined;
  const visibleTree: SplitNode | undefined =
    state.zoomedSessionId && containsSession(state.tree, state.zoomedSessionId)
      ? { kind: "leaf", sessionId: state.zoomedSessionId }
      : state.tree;
  const sessionIds = useMemo(() => Object.keys(sessions), [sessions]);
  const sessionIdsKey = sessionIdsConnectKey(sessionIds);
  const initialOpenBusy =
    initialOpenStatus === "opening" || initialOpenStatus === "waitingApproval";
  const anyOpenPending = sessionOpenPending || initialOpenBusy;
  const pendingStartedAt = sessionOpenStartedAt ?? initialOpenStartedAt;
  const sessionOpenElapsedSeconds = pendingStartedAt
    ? Math.max(0, Math.floor((now - pendingStartedAt) / 1000))
    : 0;
  const sessionOpenPendingLabel = terminalStartupPendingLabel({
    pending: anyOpenPending,
    elapsedSeconds: sessionOpenElapsedSeconds,
    shellUnit,
  });
  const setSessions = useCallback(
    (updater: (sessions: Record<string, SessionInfo>) => Record<string, SessionInfo>) => {
      sessionStore.replace(updater(sessionStore.getSnapshot()));
    },
    [sessionStore]
  );
  const actions = usePanelActions({ shell, state, sessions, setState, setSessions });

  const openScratch = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const activeId = prev.scratchActiveBufferId;
      const active = activeId
        ? prev.scratchBuffers.find((buffer) => buffer.bufferId === activeId)
        : undefined;
      // Drop empty stale buffers from prior opens (keep the currently active one).
      const cleaned = prev.scratchBuffers.filter(
        (buffer) => buffer.text !== "" || buffer.bufferId === activeId
      );
      if (active && active.text === "") {
        return {
          ...prev,
          scratchBuffers: cleaned,
          scratchActiveBufferId: active.bufferId,
          scratchOpen: true,
        };
      }
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh, ...cleaned].slice(0, SCRATCH_BUFFER_MAX_COUNT),
        scratchActiveBufferId: fresh.bufferId,
        scratchOpen: true,
      };
    });
  }, []);

  const setScratchOpen = useCallback((open: boolean) => {
    if (open) {
      openScratch();
      return;
    }
    setState((prev) => ({ ...prev, scratchOpen: false }));
  }, [openScratch]);

  const newScratchBuffer = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh, ...prev.scratchBuffers].slice(0, SCRATCH_BUFFER_MAX_COUNT),
        scratchActiveBufferId: fresh.bufferId,
      };
    });
  }, []);

  const selectScratchBuffer = useCallback((bufferId: string) => {
    setState((prev) => ({ ...prev, scratchActiveBufferId: bufferId }));
  }, []);

  const ejectScratchBuffer = useCallback((bufferId: string) => {
    setState((prev) => {
      const index = prev.scratchBuffers.findIndex((buffer) => buffer.bufferId === bufferId);
      if (index === -1) return prev;
      const remaining = [
        ...prev.scratchBuffers.slice(0, index),
        ...prev.scratchBuffers.slice(index + 1),
      ];
      if (prev.scratchActiveBufferId !== bufferId) {
        return { ...prev, scratchBuffers: remaining };
      }
      if (remaining.length > 0) {
        // Pick the buffer that took the ejected slot, else the one before it.
        const nextIndex = Math.min(index, remaining.length - 1);
        return {
          ...prev,
          scratchBuffers: remaining,
          scratchActiveBufferId: remaining[nextIndex]!.bufferId,
        };
      }
      const now = Date.now();
      const fresh: ScratchBuffer = {
        bufferId: crypto.randomUUID(),
        text: "",
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...prev,
        scratchBuffers: [fresh],
        scratchActiveBufferId: fresh.bufferId,
      };
    });
  }, []);

  const commitScratchText = useCallback((bufferId: string, text: string) => {
    setState((prev) => {
      let changed = false;
      const next = prev.scratchBuffers.map((buffer) => {
        if (buffer.bufferId !== bufferId) return buffer;
        if (buffer.text === text) return buffer;
        changed = true;
        return { ...buffer, text, updatedAt: Date.now() };
      });
      if (!changed) return prev;
      return { ...prev, scratchBuffers: next };
    });
  }, []);

  const pasteScratch = useCallback(
    (bufferId: string, text: string, run: boolean) => {
      const targetSessionId = latestStateRef.current.focusedSessionId;
      if (!targetSessionId) {
        showToast("Open a terminal first");
        return;
      }
      commitScratchText(bufferId, text);
      const payload = run ? (text.endsWith("\n") ? text : `${text}\n`) : text;
      void actions.sendText(targetSessionId, payload).catch((err) => {
        showToast(err instanceof Error ? `Paste failed: ${err.message}` : "Paste failed");
      });
      setState((prev) => ({ ...prev, scratchOpen: false }));
    },
    [actions, commitScratchText, showToast]
  );

  useEffect(() => {
    document.title = documentTitleForSession(focusedSession);
  }, [focusedSession]);

  useEffect(() => {
    latestStateRef.current = state;
    latestShellRef.current = shell;
  }, [shell, state]);

  useEffect(
    () => () => {
      disposePanelSessions(latestShellRef.current, latestStateRef.current);
    },
    []
  );

  useEffect(
    () => sessionStore.connect(shell, sessionIdsKey ? sessionIdsKey.split("\0") : []),
    [sessionIdsKey, sessionStore, shell]
  );

  useEffect(() => {
    void setStateArgs(state as unknown as Record<string, unknown>);
  }, [state]);

  useEffect(() => {
    const prev = prevScratchOpenRef.current;
    prevScratchOpenRef.current = state.scratchOpen;
    if (prev && !state.scratchOpen) {
      window.dispatchEvent(new Event("terminal:refocus"));
    }
  }, [state.scratchOpen]);

  const openInitialSession = useCallback(
    async (force = false): Promise<string | undefined> => {
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
        const sessionId = await actions.openSession();
        initialOpenPendingRef.current = false;
        setInitialOpenStatus("idle");
        setInitialOpenStartedAt(null);
        return sessionId;
      } catch (err) {
        setInitialOpenError(
          err instanceof Error ? err.message : "Terminal session failed to start"
        );
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
    },
    [actions]
  );

  const runInteractiveOpen = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
      if (interactiveOpenInFlightRef.current || initialOpenInFlightRef.current) {
        showToast(sessionOpenPendingLabel ?? "Terminal request already in progress");
        return undefined;
      }
      interactiveOpenInFlightRef.current = true;
      setSessionOpenPending(true);
      setSessionOpenStartedAt(Date.now());
      try {
        return await operation();
      } catch (err) {
        showToast(
          err instanceof Error
            ? `Terminal failed to start: ${err.message}`
            : "Terminal failed to start"
        );
        return undefined;
      } finally {
        interactiveOpenInFlightRef.current = false;
        setSessionOpenPending(false);
        setSessionOpenStartedAt(null);
      }
    },
    [sessionOpenPendingLabel, showToast]
  );

  const openDefaultPane = useCallback(async (): Promise<string | undefined> => {
    if (
      !state.tree ||
      initialOpenInFlightRef.current ||
      initialOpenStatus === "opening" ||
      initialOpenStatus === "waitingApproval" ||
      initialOpenStatus === "failed"
    ) {
      return openInitialSession(initialOpenStatus === "failed");
    }
    return runInteractiveOpen(() => actions.splitFocused("row"));
  }, [actions, initialOpenStatus, openInitialSession, runInteractiveOpen, state.tree]);

  useEffect(
    () => () => {
      if (initialOpenHintTimerRef.current) window.clearTimeout(initialOpenHintTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!anyOpenPending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyOpenPending]);

  useEffect(() => {
    let cancelled = false;
    function pickShellUnit(units: WorkspaceUnitStatus[]) {
      const match = units.find(
        (unit) =>
          unit.name === "@workspace-extensions/shell" ||
          unit.source.endsWith("/@workspace-extensions/shell")
      );
      if (!cancelled) setShellUnit(match ? normalizeShellUnit(match) : null);
    }
    void workspace.units
      .list()
      .then(pickShellUnit)
      .catch(() => {});
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
      if (containsSession(state.tree, session.sessionId)) continue;
      const spawn = parseSnugSpawn(session.meta["snugSpawn"]);
      if (!spawn || !containsSession(state.tree, spawn.parentSessionId)) continue;
      setState((prev) => ({
        ...prev,
        tree: prev.tree
          ? splitLeaf(prev.tree, spawn.parentSessionId, spawn.direction, session.sessionId)
          : { kind: "leaf", sessionId: session.sessionId },
        focusedSessionId: session.sessionId,
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
  }, [sessions, state.tree]);

  useEffect(() => {
    for (const session of Object.values(sessions)) {
      const approved = parseApprovedOpenUrl(session.meta["snugOpenUrl"]);
      if (!approved || approvedOpenUrlIdsRef.current.has(approved.id)) continue;
      approvedOpenUrlIdsRef.current.add(approved.id);
      void openUrl(approved.url);
      void actions.deleteMeta(session.sessionId, "snugOpenUrl").catch(() => {});
      setState((prev) => ({
        ...prev,
        notifications: [
          {
            notifId: crypto.randomUUID(),
            sessionId: session.sessionId,
            severity: "info",
            title: "Open URL",
            message: approved.url,
            timestamp: approved.requestedAt,
            read: false,
            source: "snug",
          },
          ...prev.notifications,
        ],
      }));
    }
  }, [actions, sessions]);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (restored) return;
      setRestored(true);
      if (!state.tree) {
        await openInitialSession();
        return;
      }
      initialOpenPendingRef.current = false;
      const result = await restoreTerminalState(shell, state);
      if (cancelled) return;
      setSessions((prev) => ({ ...prev, ...result.sessions }));
      setState((prev) => ({
        ...prev,
        tree: result.tree,
        focusedSessionId: result.focusedSessionId,
        perSession: result.perSession,
      }));
      if (!result.tree) {
        initialOpenPendingRef.current = true;
        await openInitialSession();
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (state.tree) return;
    let cancelled = false;
    const retryOpen = async () => {
      if (initialOpenStatus === "failed") return;
      if (cancelled || initialOpenInFlightRef.current) return;
      initialOpenPendingRef.current = true;
      await openInitialSession();
    };
    void retryOpen();
    const timer = setInterval(() => void retryOpen(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initialOpenStatus, openInitialSession, state.tree]);

  useKeybindings(state.keybindings, {
    palette: () => setPaletteOpen(true),
    newPane: () => void openDefaultPane(),
    splitRight: () => void runInteractiveOpen(() => actions.splitFocused("row")),
    splitDown: () => void runInteractiveOpen(() => actions.splitFocused("column")),
    closePane: closeFocusedPane,
    toggleNotifications: () =>
      setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen })),
    settings: () => setSettingsOpen((open) => !open),
    find: () => window.dispatchEvent(new CustomEvent("terminal:find")),
    findNext: () => window.dispatchEvent(new CustomEvent("terminal:find-next")),
    findPrev: () => window.dispatchEvent(new CustomEvent("terminal:find-previous")),
    copy: () => window.dispatchEvent(new CustomEvent("terminal:copy")),
    paste: () => window.dispatchEvent(new CustomEvent("terminal:paste")),
    clear: () => focusedSessionId && void actions.clearScrollback(focusedSessionId),
    zoom: () =>
      setState((prev) => ({
        ...prev,
        zoomedSessionId: prev.zoomedSessionId ? undefined : prev.focusedSessionId,
      })),
    focusUp: () => focusPaneByDirection("up"),
    focusDown: () => focusPaneByDirection("down"),
    focusLeft: () => focusPaneByDirection("left"),
    focusRight: () => focusPaneByDirection("right"),
    jumpToLatestUnread: () => focusUnreadSession("latest"),
    nextUnread: () => focusUnreadSession("next"),
    fontUp: () =>
      setState((prev) => {
        const fontSize = Math.min(24, prev.fontSize + 1);
        showToast(`Font ${fontSize}px`);
        return { ...prev, fontSize };
      }),
    fontDown: () =>
      setState((prev) => {
        const fontSize = Math.max(9, prev.fontSize - 1);
        showToast(`Font ${fontSize}px`);
        return { ...prev, fontSize };
      }),
    fontReset: () => {
      showToast("Font 13px");
      setState((prev) => ({ ...prev, fontSize: 13 }));
    },
    openScratch: () => {
      if (latestStateRef.current.scratchOpen) {
        setState((prev) => ({ ...prev, scratchOpen: false }));
      } else {
        openScratch();
      }
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
      openSession: async (args?: { command?: string }) => ({
        sessionId: args?.command
          ? await runInteractiveOpen(() => actions.splitFocused("row", args.command))
          : await openDefaultPane(),
      }),
      splitPane: async (args?: { direction?: "right" | "down"; command?: string }) => {
        const direction = args?.direction === "down" ? "column" : "row";
        return {
          sessionId: await runInteractiveOpen(() => actions.splitFocused(direction, args?.command)),
        };
      },
      sendText: async (args: { sessionId: string; text: string }) =>
        actions.sendText(args.sessionId, args.text),
      getScrollback: async (args: { sessionId: string; maxBytes?: number }) =>
        shell.getScrollback(args.sessionId, args.maxBytes),
      getRenderedText: async (args: { sessionId: string }) =>
        window.__natstackTerminalPaneTestRegistry?.[args.sessionId]?.serialize() ?? "",
      focusSession: async (args: { sessionId: string }) => actions.focusSession(args.sessionId),
      runCommand: async (args: { command: string; target?: CommandRunTarget }) => ({
        sessionId: await runCommand(args.command, args.target ?? "splitRight"),
      }),
      getMeta: async (args: { sessionId: string; key?: string }) =>
        actions.getMeta(args.sessionId, args.key),
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
    exposeMethod("terminal.getMeta", async (args: { sessionId: string; key?: string }) =>
      actions.getMeta(args.sessionId, args.key)
    );
    exposeMethod(
      "terminal.setMeta",
      async (args: { sessionId: string; key: string; value: unknown }) =>
        actions.setMeta(args.sessionId, args.key, args.value)
    );
    exposeMethod("terminal.deleteMeta", async (args: { sessionId: string; key: string }) =>
      actions.deleteMeta(args.sessionId, args.key)
    );
    window.__natstackTerminalTestApi = terminalApi;
    return () => {
      if (window.__natstackTerminalTestApi === terminalApi) {
        delete window.__natstackTerminalTestApi;
      }
    };
  }, [actions, openDefaultPane, runInteractiveOpen, sessions]);

  async function runCommand(
    commandLine: string,
    target: CommandRunTarget
  ): Promise<string | undefined> {
    setState((prev) => ({
      ...prev,
      paletteHistory: [
        commandLine,
        ...prev.paletteHistory.filter((item) => item !== commandLine),
      ].slice(0, 20),
    }));
    if (target === "here") {
      if (!focusedSessionId) return undefined;
      await actions.sendText(
        focusedSessionId,
        commandLine.endsWith("\n") ? commandLine : `${commandLine}\n`
      );
      return focusedSessionId;
    }
    return runInteractiveOpen(() =>
      actions.splitFocused(target === "splitDown" ? "column" : "row", commandLine)
    );
  }

  function runBuiltin(action: string) {
    if (action === "newPane") void openDefaultPane();
    else if (action === "splitRight") void runInteractiveOpen(() => actions.splitFocused("row"));
    else if (action === "splitDown") void runInteractiveOpen(() => actions.splitFocused("column"));
    else if (action === "clear" && focusedSessionId)
      void actions.clearScrollback(focusedSessionId);
    else if (action === "toggleFind") window.dispatchEvent(new CustomEvent("terminal:find"));
    else if (action === "toggleNotifications")
      setState((prev) => ({ ...prev, notificationCenterOpen: !prev.notificationCenterOpen }));
  }

  function closeFocusedPane() {
    if (!focusedSessionId) return;
    const session = sessions[focusedSessionId];
    if (session?.alive && !window.confirm("Close this running terminal?")) return;
    actions.closeSession(focusedSessionId);
  }

  function focusPaneByDirection(direction: PaneFocusDirection) {
    if (!state.tree || !focusedSessionId) return;
    const nextSessionId = findDirectionalPane(state.tree, focusedSessionId, direction);
    if (!nextSessionId) return;
    setState((prev) => ({ ...prev, focusedSessionId: nextSessionId }));
  }

  function focusUnreadSession(mode: "latest" | "next") {
    const unread = state.notifications
      .filter((item) => !item.read && containsSession(state.tree, item.sessionId))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (unread.length === 0) return;
    const target =
      mode === "next" && focusedSessionId
        ? (unread[
            (unread.findIndex((item) => item.sessionId === focusedSessionId) + 1 + unread.length) %
              unread.length
          ] ?? unread[0])
        : unread[0];
    if (!target) return;
    setState((prev) => markSessionRead({ ...prev, focusedSessionId: target.sessionId }, target.sessionId));
  }

  const notificationCenter = (
    <NotificationCenter
      notifications={state.notifications}
      sessions={sessions}
      filter={state.notificationFilter}
      onFilterChange={(filter) => setState((prev) => ({ ...prev, notificationFilter: filter }))}
      onJump={(sessionId) => {
        if (containsSession(state.tree, sessionId)) {
          setState((prev) => markSessionRead({ ...prev, focusedSessionId: sessionId }, sessionId));
        }
        if (isMobile) setState((prev) => ({ ...prev, notificationCenterOpen: false }));
      }}
      onMarkRead={(notifId) =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.map((item) =>
            item.notifId === notifId ? { ...item, read: true } : item
          ),
        }))
      }
      onDismiss={(notifId) =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.filter((item) => item.notifId !== notifId),
        }))
      }
      onMarkAllRead={() =>
        setState((prev) => ({
          ...prev,
          notifications: prev.notifications.map((item) => ({ ...item, read: true })),
        }))
      }
      onClearAll={() => setState((prev) => ({ ...prev, notifications: [] }))}
    />
  );

  const settingsControl = (
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
          for (const sessionId of Object.keys(sessions))
            void shell.setScrollbackLimit?.(sessionId, next.scrollbackBytes);
        }
      }}
    />
  );

  return (
    <Theme appearance={appearance}>
      <Flex
        height="100vh"
        width="100vw"
        direction="column"
        style={{ overflow: "hidden", background: "var(--color-page-background)", position: "relative" }}
      >
        <Box
          p="1"
          style={{
            display: "flex",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            height: "100%",
            overflow: "hidden",
          }}
        >
          {visibleTree ? (
            <SplitTree
              node={visibleTree}
              sessions={sessions}
              notifications={state.notifications}
              focusedSessionId={focusedSessionId}
              settingsControl={settingsControl}
              shell={shell}
              fontSize={state.fontSize}
              fontFamily={state.fontFamily}
              appearance={appearance}
              pasteMode={state.pasteMode}
              imagePasteRelative={state.imagePasteRelative}
              resizeKey={resizeKey}
              onFocus={(sessionId) => setState((prev) => ({ ...prev, focusedSessionId: sessionId }))}
              onClose={(sessionId) => {
                const session = sessions[sessionId];
                if (session?.alive && !window.confirm("Close this running terminal?")) return;
                actions.closeSession(sessionId);
              }}
              onSplit={(sessionId, direction) => {
                void runInteractiveOpen(() => actions.splitSession(sessionId, direction));
              }}
              onOpenPort={(sessionId, port) =>
                void openPort(port, sessions[sessionId]?.detectedUrls)
              }
              onOpenUrl={(_sessionId, url) => void openUrl(url)}
              onClear={(sessionId) => void actions.clearScrollback(sessionId)}
              onDuplicate={(sessionId) =>
                void runInteractiveOpen(() => actions.splitSession(sessionId, "row"))
              }
              onRestart={(sessionId) => void actions.restart(sessionId)}
              onRestartCommand={(sessionId) => void actions.restartCommand(sessionId)}
              onFind={(sessionId) => {
                setState((prev) => ({ ...prev, focusedSessionId: sessionId }));
                window.dispatchEvent(new CustomEvent("terminal:find"));
              }}
              onZoom={(sessionId) =>
                setState((prev) => ({
                  ...prev,
                  focusedSessionId: sessionId,
                  zoomedSessionId: prev.zoomedSessionId === sessionId ? undefined : sessionId,
                }))
              }
              onOpenScratch={openScratch}
              onRatioChange={(path, ratio) => {
                setState((prev) => ({
                  ...prev,
                  tree: prev.tree ? updateSplitRatio(prev.tree, path, ratio) : prev.tree,
                }));
                setResizeKey((value) => value + 1);
              }}
              onNotification={(sessionId, notification) => {
                setState((prev) => ({
                  ...prev,
                  notifications: [
                    {
                      notifId: crypto.randomUUID(),
                      sessionId,
                      severity: notification.severity,
                      title: notification.title,
                      message: notification.message,
                      timestamp: Date.now(),
                      read: false,
                      source: notification.source,
                    },
                    ...prev.notifications,
                  ],
                }));
              }}
            />
          ) : (
            <EmptyTerminalState
              status={initialOpenStatus}
              error={initialOpenError}
              shellUnit={shellUnit}
              elapsedSeconds={
                initialOpenStartedAt
                  ? Math.max(0, Math.floor((now - initialOpenStartedAt) / 1000))
                  : 0
              }
              onOpen={() => void openDefaultPane()}
            />
          )}
        </Box>
        <Toast toast={toast} />
        {state.notificationCenterOpen ? (
          isMobile ? (
            <Box
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 20,
                display: "flex",
                justifyContent: "flex-end",
                background: "rgba(0, 0, 0, 0.34)",
              }}
              onClick={() => setState((prev) => ({ ...prev, notificationCenterOpen: false }))}
            >
              <Box
                style={{ height: "100%", maxWidth: "calc(100vw - 40px)" }}
                onClick={(event) => event.stopPropagation()}
              >
                {notificationCenter}
              </Box>
            </Box>
          ) : (
            notificationCenter
          )
        ) : null}
      </Flex>
      <CommandLauncher
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        cwd={focusedSession ? liveSessionCwd(focusedSession) : undefined}
        history={state.paletteHistory}
        onRun={async (command, target) => {
          await runCommand(command, target);
        }}
        onBuiltin={runBuiltin}
      />
      <ScratchOverlay
        open={state.scratchOpen}
        buffers={state.scratchBuffers}
        activeBufferId={state.scratchActiveBufferId}
        fontFamily={state.fontFamily}
        hasFocusedSession={!!focusedSessionId}
        onOpenChange={setScratchOpen}
        onNewBuffer={newScratchBuffer}
        onSelectBuffer={selectScratchBuffer}
        onEjectBuffer={ejectScratchBuffer}
        onCommitText={commitScratchText}
        onPaste={(bufferId, text) => pasteScratch(bufferId, text, false)}
        onPasteAndRun={(bufferId, text) => pasteScratch(bufferId, text, true)}
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
      <Flex
        direction="column"
        align="center"
        gap="3"
        style={{ maxWidth: 360, textAlign: "center" }}
      >
        <Text size="3" weight="medium">
          {copy.title}
        </Text>
        <Text size="2" color="gray">
          {copy.detail}
        </Text>
        {elapsed ? (
          <Text size="1" color="gray" role="status" aria-live="polite">
            {elapsed}
          </Text>
        ) : null}
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

function markSessionRead(state: TerminalState, sessionId: string): TerminalState {
  const now = Date.now();
  return {
    ...state,
    notifications: state.notifications.map((item) =>
      item.sessionId === sessionId ? { ...item, read: true } : item
    ),
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

function parseSnugSpawn(
  value: unknown
): { parentSessionId: string; direction: "row" | "column" } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record["parentSessionId"] === "string" &&
    (record["direction"] === "row" || record["direction"] === "column")
    ? { parentSessionId: record["parentSessionId"], direction: record["direction"] }
    : undefined;
}
