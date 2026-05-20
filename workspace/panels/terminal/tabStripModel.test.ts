import { describe, expect, it } from "vitest";
import { badgeColorFor, shouldShowTabClose, splitVisibleTabs, tabAdornment, updateTabBadge } from "./tabStripModel.js";
import type { SessionInfo, TerminalNotification, TerminalTab } from "./types.js";

describe("tab strip model", () => {
  it("shows all tabs when the count fits", () => {
    const tabs = makeTabs(3);

    expect(splitVisibleTabs(tabs, "tab-2", 6)).toEqual({ visible: tabs, overflow: [] });
  });

  it("overflows tabs beyond the visible limit", () => {
    const tabs = makeTabs(8);
    const result = splitVisibleTabs(tabs, "tab-2", 6);

    expect(result.visible.map((tab) => tab.tabId)).toEqual(["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6"]);
    expect(result.overflow.map((tab) => tab.tabId)).toEqual(["tab-7", "tab-8"]);
  });

  it("keeps an overflowed active tab visible", () => {
    const tabs = makeTabs(8);
    const result = splitVisibleTabs(tabs, "tab-8", 6);

    expect(result.visible.map((tab) => tab.tabId)).toEqual(["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-8"]);
    expect(result.overflow.map((tab) => tab.tabId)).toEqual(["tab-6", "tab-7"]);
  });

  it("sets and clears the active tab badge for scriptable callers", () => {
    const tabs = makeTabs(2);
    const withBadge = updateTabBadge(tabs, "tab-2", { text: "7", severity: "approval" });

    expect(withBadge[1]?.badge).toEqual({ text: "7", color: undefined, severity: "approval" });
    expect(updateTabBadge(withBadge, "tab-2", { text: "" })[1]?.badge).toBeUndefined();
  });

  it("lets explicit badge colors override severity colors", () => {
    expect(badgeColorFor({ severity: "approval" })).toBe("amber");
    expect(badgeColorFor({ severity: "failure" })).toBe("red");
    expect(badgeColorFor({ severity: "waiting" })).toBe("blue");
    expect(badgeColorFor({ severity: "done" })).toBe("green");
    expect(badgeColorFor({ color: "purple", severity: "failure" })).toBe("purple");
    expect(badgeColorFor({ color: "tomato", severity: "done" })).toBe("tomato");
    expect(badgeColorFor({ color: "not-a-radix-color", severity: "failure" })).toBe("red");
  });

  it("resolves the same badge and attention adornments for visible and overflow tabs", () => {
    const tabs = makeTabs(3);
    const [explicit, unread, exited] = tabs;
    explicit!.badge = { text: "deploy", severity: "approval" };

    expect(tabAdornment(explicit!, sessions(), [])).toEqual({ kind: "badge", text: "deploy", color: "amber" });
    expect(tabAdornment(unread!, sessions(), [notification(unread!.tabId, "failure")])).toEqual({ kind: "badge", text: "1", color: "red" });
    expect(tabAdornment(exited!, sessions({ [exited!.tabId]: { alive: false } }), [])).toEqual({ kind: "dot", severity: "failure" });
  });

  it("shows close affordances only for hovered or keyboard-focused tab controls", () => {
    expect(shouldShowTabClose("tab-1", null, null)).toBe(false);
    expect(shouldShowTabClose("tab-1", "tab-1", null)).toBe(true);
    expect(shouldShowTabClose("tab-1", null, "tab-1")).toBe(true);
    expect(shouldShowTabClose("tab-1", "tab-2", "tab-3")).toBe(false);
  });
});

function makeTabs(count: number): TerminalTab[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `tab-${index + 1}`;
    return {
      tabId: id,
      label: id,
      focusedSessionId: id,
      tree: { kind: "leaf", sessionId: id },
    };
  });
}

function notification(sessionId: string, severity: TerminalNotification["severity"]): TerminalNotification {
  return { notifId: crypto.randomUUID(), sessionId, severity, message: severity, timestamp: Date.now(), read: false };
}

function sessions(overrides: Record<string, Partial<SessionInfo>> = {}): Record<string, SessionInfo> {
  const ids = ["tab-1", "tab-2", "tab-3"];
  return Object.fromEntries(ids.map((sessionId) => [sessionId, {
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
