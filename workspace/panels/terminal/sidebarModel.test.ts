import { describe, expect, it } from "vitest";
import { buildSidebarGroups, buildSidebarRows } from "./sidebarModel.js";
import type { SessionInfo, TerminalNotification, TerminalTab } from "./types.js";
import { VSCODE_SHELL_INTEGRATION_META_KEY } from "./vscodeShellIntegrationMeta.js";

describe("sidebar model", () => {
  it("uses latest unread notification preview, unread count, severity, and port overflow", () => {
    const tab = makeTab("tab-1", "s1");
    const rows = buildSidebarRows({
      tabs: [tab],
      sessions: { s1: session("s1", { detectedPorts: [3000, 5173, 9229, 9999] }) },
      notifications: [
        notification("n1", "s1", "approval", "needs approval", 10),
        notification("n2", "s1", "failure", "failed later", 20),
      ],
      filter: "",
    });

    expect(rows[0]).toMatchObject({
      title: "Shell s1",
      branch: "main",
      cwdBasename: "repo",
      subtitle: "failed later",
      unread: 2,
      severity: "failure",
      ports: [3000, 5173, 9229],
      extraPortCount: 1,
    });
  });

  it("uses the active command as the status subtitle when there is no unread notification", () => {
    const rows = buildSidebarRows({
      tabs: [makeTab("Work", "s1"), makeTab("Idle", "s2")],
      sessions: {
        s1: session("s1", { argv: ["pnpm", "dev"] }),
        s2: session("s2", { argv: ["/bin/bash"] }),
      },
      notifications: [],
      filter: "",
    });

    expect(rows.map((row) => [row.subtitle, row.alive])).toEqual([["$ pnpm dev", true], ["idle", true]]);
  });

  it("uses live shell integration command lifecycle as the subtitle and severity", () => {
    const rows = buildSidebarRows({
      tabs: [makeTab("Running", "s1"), makeTab("Failed", "s2")],
      sessions: {
        s1: session("s1", { commandLine: "pnpm test", commandRunning: true }),
        s2: session("s2", { commandLine: "pnpm lint", lastExitCode: 2, commandDurationMs: 1234 }),
      },
      notifications: [],
      filter: "",
    });

    expect(rows.map((row) => [row.subtitle, row.severity])).toEqual([
      ["$ pnpm test", "waiting"],
      ["exit 2 · 1.2s · pnpm lint", "failure"],
    ]);
  });


  it("renders every split session as its own workspace row", () => {
    const tab: TerminalTab = {
      tabId: "Split",
      label: "Split",
      focusedSessionId: "s2",
      tree: {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        a: { kind: "leaf", sessionId: "s1" },
        b: { kind: "leaf", sessionId: "s2" },
      },
    };
    const rows = buildSidebarRows({
      tabs: [tab],
      sessions: {
        s1: session("s1", { argv: ["pnpm", "dev"] }),
        s2: session("s2", { argv: ["vitest"] }),
      },
      notifications: [
        notification("n1", "s1", "waiting", "dev server starting"),
        notification("n2", "s2", "failure", "test failed"),
      ],
      filter: "",
    });

    expect(rows.map((row) => ({
      sessionId: row.sessionId,
      subtitle: row.subtitle,
      unread: row.unread,
      severity: row.severity,
    }))).toEqual([
      { sessionId: "s1", subtitle: "dev server starting", unread: 1, severity: "waiting" },
      { sessionId: "s2", subtitle: "test failed", unread: 1, severity: "failure" },
    ]);
  });

  it("shows a bucketed idle age for plain shells when current time is supplied", () => {
    const rows = buildSidebarRows({
      tabs: [makeTab("Idle", "s1"), makeTab("Old", "s2")],
      sessions: {
        s1: session("s1", { argv: ["/bin/bash"], lastActivityAt: 10 * 60_000 }),
        s2: session("s2", { argv: ["/bin/zsh"], lastActivityAt: 0 }),
      },
      notifications: [],
      filter: "",
      now: 15 * 60_000,
    });

    expect(rows.map((row) => row.subtitle)).toEqual(["idle 5m", "idle"]);
  });

  it("filters across tab label, cwd, command, session label, and preview", () => {
    const rows = buildSidebarRows({
      tabs: [makeTab("Work", "s1"), makeTab("Other", "s2")],
      sessions: {
        s1: session("s1", { cwd: "/repo/packages/api", argv: ["pnpm", "dev"], gitBranch: "feature/api" }),
        s2: session("s2", { cwd: "/repo/docs", argv: ["vim"] }),
      },
      notifications: [notification("n1", "s2", "info", "review docs")],
      filter: "review",
    });

    expect(rows.map((row) => row.tab.tabId)).toEqual(["Other"]);

    const branchRows = buildSidebarRows({
      tabs: [makeTab("Work", "s1"), makeTab("Other", "s2")],
      sessions: {
        s1: session("s1", { cwd: "/repo/packages/api", argv: ["pnpm", "dev"], gitBranch: "feature/api" }),
        s2: session("s2", { cwd: "/repo/docs", argv: ["vim"] }),
      },
      notifications: [],
      filter: "feature/api",
    });

    expect(branchRows.map((row) => row.tab.tabId)).toEqual(["Work"]);
  });

  it("falls back to idle when a focused session is missing", () => {
    const rows = buildSidebarRows({
      tabs: [makeTab("Lost", "missing")],
      sessions: {},
      notifications: [],
      filter: "",
    });

    expect(rows[0]).toMatchObject({
      title: "Lost",
      subtitle: "idle",
      severity: "idle",
      alive: false,
    });
  });

  it("groups rows by inferred workspace or repo basename", () => {
    const groups = buildSidebarGroups({
      tabs: [makeTab("App", "s1"), makeTab("Docs", "s2"), makeTab("Other", "s3")],
      sessions: {
        s1: session("s1", { cwd: "/home/werg/natstack4/workspace/app" }),
        s2: session("s2", { cwd: "/repo/docs" }),
        s3: session("s3", { cwd: "relative/project" }),
      },
      notifications: [],
      filter: "",
    });

    expect(groups.map((group) => ({ name: group.name, tabs: group.rows.map((row) => row.tab.tabId) }))).toEqual([
      { name: "natstack4", tabs: ["App"] },
      { name: "repo", tabs: ["Docs"] },
      { name: "relative", tabs: ["Other"] },
    ]);
  });

  it("uses live shell integration cwd for basename, grouping, and filtering", () => {
    const groups = buildSidebarGroups({
      tabs: [makeTab("App", "s1")],
      sessions: {
        s1: session("s1", {
          cwd: "/launch",
          liveCwd: "/repo/packages/app",
          commandLine: "pnpm dev",
        }),
      },
      notifications: [],
      filter: "packages/app",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe("repo");
    expect(groups[0]?.rows[0]?.cwdBasename).toBe("app");
  });
});

function makeTab(label: string, sessionId: string): TerminalTab {
  return {
    tabId: label,
    label,
    focusedSessionId: sessionId,
    tree: { kind: "leaf", sessionId },
  };
}

function session(sessionId: string, opts: Partial<{ cwd: string; argv: string[]; detectedPorts: number[]; gitBranch: string; lastActivityAt: number; liveCwd: string; commandLine: string; commandRunning: boolean; lastExitCode: number; commandDurationMs: number }> = {}): SessionInfo {
  return {
    sessionId,
    label: `Shell ${sessionId}`,
    command: { argv: opts.argv ?? ["/bin/sh"], cwd: opts.cwd ?? "/repo" },
    gitBranch: opts.gitBranch ?? "main",
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: opts.detectedPorts ?? [],
    detectedUrls: [],
    lastActivityAt: opts.lastActivityAt ?? 1,
    bytesOut: 0,
    meta: opts.liveCwd || opts.commandLine || opts.commandRunning || opts.lastExitCode !== undefined ? {
      [VSCODE_SHELL_INTEGRATION_META_KEY]: {
        status: "vscode",
        cwd: opts.liveCwd,
        commandLine: opts.commandLine,
        commandRunning: opts.commandRunning ?? false,
        lastExitCode: opts.lastExitCode,
        commandDurationMs: opts.commandDurationMs,
        updatedAt: 1,
      },
    } : {},
  };
}

function notification(notifId: string, sessionId: string, severity: TerminalNotification["severity"], message: string, timestamp = 1): TerminalNotification {
  return {
    notifId,
    sessionId,
    severity,
    message,
    timestamp,
    read: false,
  };
}
