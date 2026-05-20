import { describe, expect, it } from "vitest";
import { aggregateTabSeverity, badgeFromSessions, countUnreadForTab } from "./tabStatus.js";
import type { SessionInfo, TerminalNotification, TerminalTab } from "./types.js";
import { VSCODE_SHELL_INTEGRATION_META_KEY } from "./vscodeShellIntegrationMeta.js";

const tab: TerminalTab = {
  tabId: "tab-1",
  label: "Tab",
  focusedSessionId: "a",
  tree: {
    kind: "split",
    direction: "row",
    ratio: 0.5,
    a: { kind: "leaf", sessionId: "a" },
    b: { kind: "leaf", sessionId: "b" },
  },
};

describe("tab status helpers", () => {
  it("counts only unread notifications for sessions in the tab", () => {
    expect(countUnreadForTab(tab, [
      notification("a", "info", false),
      notification("b", "done", false),
      notification("b", "failure", true),
      notification("other", "failure", false),
    ])).toBe(2);
  });

  it("orders aggregate severity by user attention level", () => {
    expect(aggregateTabSeverity(tab, sessions(), [
      notification("a", "done", false),
      notification("b", "approval", false),
      notification("b", "failure", true),
    ])).toBe("approval");
    expect(aggregateTabSeverity(tab, sessions({ b: { alive: false } }), [])).toBe("failure");
    expect(aggregateTabSeverity(tab, sessions({ b: { alive: false } }), [
      notification("b", "done", false),
      notification("a", "info", false),
    ])).toBe("failure");
  });

  it("uses live command lifecycle state when no unread notification outranks it", () => {
    expect(aggregateTabSeverity(tab, sessions({ a: { meta: shellMeta({ commandRunning: true }) } }), []))
      .toBe("waiting");
    expect(aggregateTabSeverity(tab, sessions({ a: { meta: shellMeta({ lastExitCode: 1 }) } }), []))
      .toBe("failure");
    expect(aggregateTabSeverity(tab, sessions({ a: { meta: shellMeta({ commandRunning: true }) } }), [
      notification("b", "approval", false),
    ])).toBe("approval");
  });


  it("reads snug badge metadata from any session in the tab", () => {
    expect(badgeFromSessions(tab, sessions({ b: { meta: { badge: { text: "7", color: "amber" } } } }))).toEqual({
      text: "7",
      color: "amber",
    });
  });
});

function notification(sessionId: string, severity: TerminalNotification["severity"], read: boolean): TerminalNotification {
  return { notifId: crypto.randomUUID(), sessionId, severity, message: severity, timestamp: Date.now(), read };
}

function shellMeta(patch: Partial<{ commandRunning: boolean; lastExitCode: number }>): Record<string, unknown> {
  return {
    [VSCODE_SHELL_INTEGRATION_META_KEY]: {
      status: "vscode",
      commandLine: "pnpm test",
      commandRunning: patch.commandRunning ?? false,
      lastExitCode: patch.lastExitCode,
      updatedAt: 1,
    },
  };
}

function sessions(overrides: Record<string, Partial<SessionInfo>> = {}): Record<string, SessionInfo> {
  return Object.fromEntries(["a", "b"].map((sessionId) => [sessionId, {
    sessionId,
    label: sessionId,
    command: { argv: ["/bin/sh"], cwd: "." },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 0,
    bytesOut: 0,
    meta: {},
    ...overrides[sessionId],
  } satisfies SessionInfo]));
}
