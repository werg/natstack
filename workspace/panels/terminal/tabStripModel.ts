import { aggregateTabSeverity, badgeFromSessions, countUnreadForTab } from "./tabStatus.js";
import type { NotificationSeverity, SessionInfo, TerminalNotification, TerminalTab } from "./types.js";

export type TabAdornment =
  | { kind: "badge"; text: string; color: BadgeColor }
  | { kind: "dot"; severity: NotificationSeverity }
  | undefined;

export type BadgeColor = typeof badgeColors[number];

export const badgeColors = [
  "gray", "gold", "bronze", "brown", "yellow", "amber", "orange", "tomato",
  "red", "ruby", "crimson", "pink", "plum", "purple", "violet", "iris",
  "indigo", "blue", "cyan", "teal", "jade", "green", "grass", "lime",
  "mint", "sky",
] as const;

export function splitVisibleTabs(tabs: TerminalTab[], activeTabId?: string, maxVisible = 6): { visible: TerminalTab[]; overflow: TerminalTab[] } {
  if (tabs.length <= maxVisible) return { visible: tabs, overflow: [] };
  const active = activeTabId ? tabs.find((tab) => tab.tabId === activeTabId) : undefined;
  const initial = tabs.slice(0, maxVisible);
  if (!active || initial.some((tab) => tab.tabId === active.tabId)) {
    return { visible: initial, overflow: tabs.slice(maxVisible) };
  }
  const visible = [...tabs.slice(0, maxVisible - 1), active];
  const visibleIds = new Set(visible.map((tab) => tab.tabId));
  return {
    visible,
    overflow: tabs.filter((tab) => !visibleIds.has(tab.tabId)),
  };
}

export function shouldShowTabClose(tabId: string, hoveredTabId: string | null, focusedTabId: string | null): boolean {
  return hoveredTabId === tabId || focusedTabId === tabId;
}

export function updateTabBadge(
  tabs: TerminalTab[],
  activeTabId: string | undefined,
  args: { tabId?: string; text?: string; color?: string; severity?: NotificationSeverity },
): TerminalTab[] {
  const targetTabId = args.tabId ?? activeTabId;
  if (!targetTabId) return tabs;
  const text = args.text?.trim();
  return tabs.map((tab) => {
    if (tab.tabId !== targetTabId) return tab;
    if (!text) {
      const { badge: _badge, ...rest } = tab;
      return rest;
    }
    return { ...tab, badge: { text, color: args.color, severity: args.severity } };
  });
}

export function badgeColorFor(
  badge: { color?: string; severity?: NotificationSeverity } | undefined,
): BadgeColor {
  if (isBadgeColor(badge?.color)) {
    return badge.color;
  }
  if (badge?.severity === "failure") return "red";
  if (badge?.severity === "approval") return "amber";
  if (badge?.severity === "waiting") return "blue";
  if (badge?.severity === "done") return "green";
  return "gray";
}

function isBadgeColor(value: string | undefined): value is BadgeColor {
  return !!value && (badgeColors as readonly string[]).includes(value);
}

export function tabAdornment(
  tab: TerminalTab,
  sessions: Record<string, SessionInfo>,
  notifications: TerminalNotification[],
): TabAdornment {
  const explicitBadge = tab.badge?.text ? tab.badge : badgeFromSessions(tab, sessions);
  if (explicitBadge?.text) return { kind: "badge", text: explicitBadge.text, color: badgeColorFor(explicitBadge) };
  const unread = countUnreadForTab(tab, notifications);
  const severity = aggregateTabSeverity(tab, sessions, notifications);
  if (unread > 0) return { kind: "badge", text: String(unread), color: severityBadgeColor(severity) };
  return severity === "idle" ? undefined : { kind: "dot", severity };
}

function severityBadgeColor(severity: NotificationSeverity | "idle"): "gray" | "green" | "blue" | "amber" | "red" {
  if (severity === "failure") return "red";
  if (severity === "approval") return "amber";
  if (severity === "waiting") return "blue";
  if (severity === "done") return "green";
  return "gray";
}
