import type { NotificationSeverity, SessionInfo, TerminalNotification, TerminalTab } from "./types.js";
import { liveSessionCommandState } from "./vscodeShellIntegrationMeta.js";

export function countUnreadForTab(tab: TerminalTab, notifications: TerminalNotification[]): number {
  const sessionIds = tabSessionIds(tab);
  return notifications.filter((notification) => !notification.read && sessionIds.has(notification.sessionId)).length;
}

export function aggregateTabSeverity(
  tab: TerminalTab,
  sessions: Record<string, SessionInfo>,
  notifications: TerminalNotification[],
): NotificationSeverity | "idle" {
  const sessionIds = tabSessionIds(tab);
  const severities = notifications
    .filter((item) => !item.read && sessionIds.has(item.sessionId))
    .map((item) => item.severity);
  if (severities.includes("failure")) return "failure";
  if ([...sessionIds].some((sessionId) => sessions[sessionId] && !sessions[sessionId].alive)) return "failure";
  if ([...sessionIds].some((sessionId) => liveSessionCommandState(sessions[sessionId]).state === "failed")) return "failure";
  if (severities.includes("approval")) return "approval";
  if (severities.includes("waiting")) return "waiting";
  if ([...sessionIds].some((sessionId) => liveSessionCommandState(sessions[sessionId]).state === "running")) return "waiting";
  if (severities.includes("done")) return "done";
  if (severities.includes("info")) return "info";
  return "idle";
}

export function badgeFromSessions(tab: TerminalTab, sessions: Record<string, SessionInfo>): { text?: string; color?: string } | undefined {
  for (const sessionId of tabSessionIds(tab)) {
    const badge = sessions[sessionId]?.meta["badge"];
    if (isBadgeMeta(badge) && badge.text) return { text: badge.text, color: badge.color };
    if (typeof badge === "string" && badge) return { text: badge };
  }
  return undefined;
}

function tabSessionIds(tab: TerminalTab): Set<string> {
  const sessionIds = new Set<string>();
  collectSessionIds(tab.tree, sessionIds);
  return sessionIds;
}

function collectSessionIds(node: TerminalTab["tree"], out: Set<string>): void {
  if (node.kind === "leaf") {
    out.add(node.sessionId);
    return;
  }
  collectSessionIds(node.a, out);
  collectSessionIds(node.b, out);
}

function isBadgeMeta(value: unknown): value is { text?: string; color?: string } {
  return !!value && typeof value === "object" && (
    typeof (value as { text?: unknown }).text === "string" ||
    typeof (value as { color?: unknown }).color === "string"
  );
}
