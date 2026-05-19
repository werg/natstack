import { Box, Button, Flex, Theme } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";
import { getStateArgs, setStateArgs } from "@workspace/runtime";
import { useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./CommandPalette.js";
import { NotificationCenter } from "./NotificationCenter.js";
import { Sidebar } from "./Sidebar.js";
import { SplitTree } from "./SplitTree.js";
import { emptyState } from "./bootstrap.js";
import { useShellExtension } from "./useShellExtension.js";
import { useSessionMetadata } from "./useSessionMetadata.js";
import type { SessionInfo, TerminalState, TerminalTab } from "./types.js";

function stateWithTab(tab: TerminalTab): TerminalState {
  return {
    ...emptyState(),
    tabs: [tab],
    activeTabId: tab.tabId,
  };
}

export function TerminalApp() {
  const appearance = usePanelTheme();
  const shell = useShellExtension();
  const [state, setState] = useState<TerminalState>(() => ({ ...emptyState(), ...getStateArgs<TerminalState>() }));
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);

  const activeTab = state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? state.tabs[0];
  const sessionIds = useMemo(() => Object.keys(sessions), [sessions]);

  useSessionMetadata(shell, sessionIds, (info) => setSessions((prev) => ({ ...prev, [info.sessionId]: info })));

  useEffect(() => {
    void setStateArgs(state as unknown as Record<string, unknown>);
  }, [state]);

  useEffect(() => {
    if (state.tabs.length > 0) return;
    void openTab();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        void openTab();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  async function openTab(command?: string) {
    const req = command ? { command: "/bin/sh", args: ["-c", command], label: command } : {};
    const { sessionId } = await shell.open(req);
    const info = await shell.get(sessionId);
    const tab: TerminalTab = {
      tabId: crypto.randomUUID(),
      label: info.label || "Shell",
      tree: { kind: "leaf", sessionId },
      focusedSessionId: sessionId,
    };
    setSessions((prev) => ({ ...prev, [sessionId]: info }));
    setState((prev) => prev.tabs.length ? {
      ...prev,
      tabs: [...prev.tabs, tab],
      activeTabId: tab.tabId,
    } : stateWithTab(tab));
  }

  async function runCommand(commandLine: string): Promise<string> {
    const [command, ...args] = commandLine.split(/\s+/);
    if (!command) return "";
    const result = await shell.exec({ command, args, cwd: activeTab ? sessions[activeTab.focusedSessionId]?.command.cwd : undefined });
    return [result.stdout, result.stderr].filter(Boolean).join("\n") || `exit ${result.exitCode}`;
  }

  function closeSession(sessionId: string) {
    void shell.kill(sessionId).catch(() => {});
    setSessions((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.filter((tab) => tab.focusedSessionId !== sessionId),
      activeTabId: prev.tabs.find((tab) => tab.focusedSessionId !== sessionId)?.tabId,
    }));
  }

  return (
    <Theme appearance={appearance}>
      <Flex height="100vh" width="100vw" style={{ overflow: "hidden", background: "var(--gray-2)" }}>
        <Sidebar
          tabs={state.tabs}
          sessions={sessions}
          activeTabId={state.activeTabId}
          onSelect={(tabId) => setState((prev) => ({ ...prev, activeTabId: tabId }))}
          onNewTab={() => void openTab()}
        />
        <Box p="2" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {activeTab ? (
            <SplitTree
              node={activeTab.tree}
              sessions={sessions}
              focusedSessionId={activeTab.focusedSessionId}
              shell={shell}
              fontSize={state.fontSize ?? 13}
              onFocus={(sessionId) => setState((prev) => ({
                ...prev,
                tabs: prev.tabs.map((tab) => tab.tabId === activeTab.tabId ? { ...tab, focusedSessionId: sessionId } : tab),
              }))}
              onClose={closeSession}
              onNotification={(sessionId, message) => setState((prev) => ({
                ...prev,
                notifications: [{ notifId: crypto.randomUUID(), sessionId, message, timestamp: Date.now(), read: false }, ...prev.notifications],
              }))}
            />
          ) : (
            <Flex height="100%" align="center" justify="center">
              <Button onClick={() => void openTab()}>Open terminal</Button>
            </Flex>
          )}
        </Box>
        {state.notificationCenterOpen ? (
          <NotificationCenter
            notifications={state.notifications}
            onJump={(sessionId) => {
              const tab = state.tabs.find((item) => item.focusedSessionId === sessionId);
              if (tab) setState((prev) => ({ ...prev, activeTabId: tab.tabId }));
            }}
            onMarkAllRead={() => setState((prev) => ({ ...prev, notifications: prev.notifications.map((item) => ({ ...item, read: true })) }))}
          />
        ) : null}
      </Flex>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onRun={runCommand} />
    </Theme>
  );
}
