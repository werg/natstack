import { describe, expect, it, vi } from "vitest";
import { defaultTerminalState } from "./migrateState.js";
import { instantiateSavedLayout, restoreTerminalState, saveLayoutFromTab } from "./restore.js";
import type { SessionInfo, ShellApi, TerminalState } from "./types.js";
import { VSCODE_SHELL_INTEGRATION_META_KEY } from "./vscodeShellIntegrationMeta.js";

describe("terminal restore", () => {
  it("remaps focused pane to the corresponding newly opened session", async () => {
    const shell = makeShell();
    const state = { ...stateWithTree("old-b"), scrollbackBytes: 1024 * 1024 };

    const result = await restoreTerminalState(shell, state);

    expect(shell.open).toHaveBeenNthCalledWith(1, { cwd: "/repo/a", label: "Alpha" });
    expect(shell.open).toHaveBeenNthCalledWith(2, { cwd: "/repo/b", label: "Beta" });
    expect(shell.setScrollbackLimit).toHaveBeenCalledWith("new-1", 1024 * 1024);
    expect(shell.setScrollbackLimit).toHaveBeenCalledWith("new-2", 1024 * 1024);
    expect(result.tabs[0]?.tree).toMatchObject({
      kind: "split",
      a: { kind: "leaf", sessionId: "new-1" },
      b: { kind: "leaf", sessionId: "new-2" },
    });
    expect(result.tabs[0]?.focusedSessionId).toBe("new-2");
    expect(result.perSession["new-2"]).toMatchObject({
      cwd: "/repo/b",
      label: "Beta",
      readCursor: 22,
      originalArgv: ["pnpm", "dev"],
    });
    expect(shell.dispose).toHaveBeenCalledWith("old-a");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

  it("prunes leaves that fail to reopen and falls back to the first restored pane", async () => {
    const shell = makeShell({ failCwd: "/repo/b" });
    const state = stateWithTree("old-b");

    const result = await restoreTerminalState(shell, state);

    expect(result.tabs[0]?.tree).toEqual({ kind: "leaf", sessionId: "new-1" });
    expect(result.tabs[0]?.focusedSessionId).toBe("new-1");
    expect(shell.dispose).toHaveBeenCalledWith("old-a");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

  it("disposes newly opened restore sessions when post-open setup fails", async () => {
    const shell = makeShell({ failGetSessionId: "new-2" });
    const state = stateWithTree("old-b");

    const result = await restoreTerminalState(shell, state);

    expect(result.tabs[0]?.tree).toEqual({ kind: "leaf", sessionId: "new-1" });
    expect(shell.dispose).toHaveBeenCalledWith("new-2");
    expect(shell.dispose).toHaveBeenCalledWith("old-b");
  });

  it("saves layouts as anonymous structural templates and instantiates fresh sessions", async () => {
    const shell = makeShell();
    const state = stateWithTree("old-b");
    const layout = saveLayoutFromTab(state.tabs[0]!, state.perSession, "Two pane");

    expect(layout.tree).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      a: { kind: "leaf", sessionId: "slot-1" },
      b: { kind: "leaf", sessionId: "slot-2" },
    });
    expect(layout.cwds).toEqual({ "slot-1": "/repo/a", "slot-2": "/repo/b" });
    expect(layout.labels).toEqual({ "slot-1": "Alpha", "slot-2": "Beta" });
    expect(JSON.stringify(layout)).not.toContain("old-a");
    expect(JSON.stringify(layout)).not.toContain("old-b");

    const result = await instantiateSavedLayout(shell, layout);

    expect(shell.open).toHaveBeenNthCalledWith(1, { cwd: "/repo/a", label: "Alpha" });
    expect(shell.open).toHaveBeenNthCalledWith(2, { cwd: "/repo/b", label: "Beta" });
    expect(result?.tab.tree).toMatchObject({
      kind: "split",
      a: { kind: "leaf", sessionId: "new-1" },
      b: { kind: "leaf", sessionId: "new-2" },
    });
    expect(result?.tab.label).toBe("Two pane");
    expect(shell.dispose).not.toHaveBeenCalled();
  });

  it("saves current live session labels when they differ from persisted labels", () => {
    const state = stateWithTree("old-b");
    const layout = saveLayoutFromTab(state.tabs[0]!, state.perSession, "Two pane", {
      "old-a": session("old-a", "/repo/a", "Renamed Alpha"),
      "old-b": session("old-b", "/repo/b", "Renamed Beta"),
    });

    expect(layout.labels).toEqual({
      "slot-1": "Renamed Alpha",
      "slot-2": "Renamed Beta",
    });
  });

  it("saves live shell integration cwd in layouts", () => {
    const state = stateWithTree("old-b");
    const layout = saveLayoutFromTab(state.tabs[0]!, state.perSession, "Two pane", {
      "old-a": session("old-a", "/repo/a", "Alpha", "/repo/live-a"),
      "old-b": session("old-b", "/repo/b", "Beta", "/repo/live-b"),
    });

    expect(layout.cwds).toEqual({
      "slot-1": "/repo/live-a",
      "slot-2": "/repo/live-b",
    });
  });
});

function stateWithTree(focusedSessionId: string): TerminalState {
  return {
    ...defaultTerminalState(),
    tabs: [{
      tabId: "tab-1",
      label: "Work",
      focusedSessionId,
      tree: {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        a: { kind: "leaf", sessionId: "old-a" },
        b: { kind: "leaf", sessionId: "old-b" },
      },
    }],
    activeTabId: "tab-1",
    perSession: {
      "old-a": { cwd: "/repo/a", label: "Alpha", originalArgv: ["node"], readCursor: 11, lastSeenAt: 1 },
      "old-b": { cwd: "/repo/b", label: "Beta", originalArgv: ["pnpm", "dev"], readCursor: 22, lastSeenAt: 2 },
    },
  };
}

function makeShell(opts: { failCwd?: string; failGetSessionId?: string } = {}): ShellApi {
  let nextId = 1;
  const sessions = new Map<string, SessionInfo>();
  return {
    open: vi.fn(async (req: { cwd?: string; label?: string }) => {
      if (req.cwd === opts.failCwd) throw new Error("denied");
      const sessionId = `new-${nextId++}`;
      sessions.set(sessionId, session(sessionId, req.cwd ?? ".", req.label));
      return { sessionId };
    }),
    get: vi.fn(async (sessionId: string) => {
      if (sessionId === opts.failGetSessionId) throw new Error("get failed");
      const info = sessions.get(sessionId);
      if (!info) throw new Error("missing");
      return info;
    }),
    exec: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    list: vi.fn(),
    getSessionInfo: vi.fn(),
    watchSessionInfo: vi.fn(),
    attach: vi.fn(),
    awaitExit: vi.fn(),
    getScrollback: vi.fn(),
    setScrollbackLimit: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as ShellApi;
}

function session(sessionId: string, cwd: string, label = sessionId, liveCwd?: string): SessionInfo {
  return {
    sessionId,
    label,
    command: { argv: ["/bin/sh"], cwd },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: Date.now(),
    bytesOut: 0,
    meta: liveCwd ? {
      [VSCODE_SHELL_INTEGRATION_META_KEY]: {
        status: "vscode",
        cwd: liveCwd,
        commandRunning: false,
        updatedAt: 1,
      },
    } : {},
  };
}
