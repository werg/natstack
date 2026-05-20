import { agentLabel } from "./agentDetect.js";
import { aggregateTabSeverity } from "./tabStatus.js";
import type { NotificationSeverity, SessionInfo, TerminalNotification, TerminalTab } from "./types.js";
import {
  formatCommandDuration,
  liveSessionCommandLine,
  liveSessionCommandState,
  liveSessionCwd,
} from "./vscodeShellIntegrationMeta.js";

export interface SidebarRowModel {
  group: string;
  tab: TerminalTab;
  sessionId: string;
  session?: SessionInfo;
  title: string;
  branch?: string;
  cwdBasename?: string;
  subtitle: string;
  unread: number;
  severity: NotificationSeverity | "idle";
  alive: boolean;
  ports: number[];
  extraPortCount: number;
}

export interface SidebarGroupModel {
  name: string;
  rows: SidebarRowModel[];
}

export function buildSidebarRows(args: {
  tabs: TerminalTab[];
  sessions: Record<string, SessionInfo>;
  notifications: TerminalNotification[];
  filter: string;
  now?: number;
}): SidebarRowModel[] {
  const query = args.filter.trim().toLowerCase();
  return args.tabs
    .flatMap((tab) => tabSessionIds(tab).map((sessionId) => {
      const session = args.sessions[sessionId];
      const latest = latestUnreadForSession(sessionId, args.notifications);
      const ports = (session?.detectedPorts ?? []).slice(0, 3);
      const cwd = liveSessionCwd(session);
      return {
        group: sidebarGroupName(session, cwd),
        tab,
        sessionId,
        session,
        title: session?.label ?? tab.label,
        branch: session?.gitBranch,
        cwdBasename: cwd ? basename(cwd) : undefined,
        subtitle: latest?.message ?? (session ? sessionSubtitle(session, args.now) : "idle"),
        unread: countUnreadForSession(sessionId, args.notifications),
        severity: sessionSeverity(sessionId, session, args.notifications),
        alive: session?.alive === true,
        ports,
        extraPortCount: Math.max(0, (session?.detectedPorts.length ?? 0) - ports.length),
      };
    }))
    .filter((row) => {
      if (!query) return true;
      const session = row.session;
      const haystack = `${row.tab.label} ${session?.label ?? ""} ${row.branch ?? ""} ${liveSessionCwd(session) ?? ""} ${liveSessionCommandLine(session) ?? ""} ${row.subtitle}`.toLowerCase();
      return haystack.includes(query);
    });
}

export function buildSidebarGroups(args: {
  tabs: TerminalTab[];
  sessions: Record<string, SessionInfo>;
  notifications: TerminalNotification[];
  filter: string;
  now?: number;
}): SidebarGroupModel[] {
  const groups = new Map<string, SidebarRowModel[]>();
  for (const row of buildSidebarRows(args)) {
    const rows = groups.get(row.group);
    if (rows) rows.push(row);
    else groups.set(row.group, [row]);
  }
  return Array.from(groups, ([name, rows]) => ({ name, rows }));
}

function latestUnreadForSession(sessionId: string, notifications: TerminalNotification[]): TerminalNotification | undefined {
  return notifications
    .filter((notification) => !notification.read && notification.sessionId === sessionId)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
}

function countUnreadForSession(sessionId: string, notifications: TerminalNotification[]): number {
  return notifications.filter((notification) => !notification.read && notification.sessionId === sessionId).length;
}

function sessionSeverity(sessionId: string, session: SessionInfo | undefined, notifications: TerminalNotification[]): NotificationSeverity | "idle" {
  const notificationSeverity = aggregateTabSeverity({
    tabId: "session",
    label: "session",
    focusedSessionId: sessionId,
    tree: { kind: "leaf", sessionId },
  }, session ? { [sessionId]: session } : {}, notifications);
  return notificationSeverity;
}

function sessionSubtitle(session: SessionInfo, now?: number): string {
  if (!session.alive) {
    const exit = session.exit ? `exited ${session.exit.code ?? session.exit.signal ?? ""}`.trim() : "exited";
    return exit;
  }
  const agent = session.detectedAgent?.kind ? agentLabel(session.detectedAgent.kind) : "";
  if (agent) return agent;
  const commandState = liveSessionCommandState(session);
  if (commandState.state === "running") return `$ ${commandState.commandLine ?? "running"}`;
  if (commandState.state === "failed") {
    const duration = formatCommandDuration(commandState.durationMs);
    return [
      `exit ${commandState.exitCode}`,
      duration,
      commandState.commandLine,
    ].filter(Boolean).join(" · ");
  }
  const argv = session.command.argv.filter(Boolean);
  if (argv.length === 0 || isPlainShell(argv)) return idleLabel(session.lastActivityAt, now);
  return `$ ${argv.join(" ")}`;
}

function idleLabel(lastActivityAt: number, now?: number): string {
  if (!now || !Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return "idle";
  const elapsedMs = Math.max(0, now - lastActivityAt);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "idle";
  if (minutes < 60) return `idle ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `idle ${hours}h`;
}

function isPlainShell(argv: string[]): boolean {
  if (argv.length !== 1) return false;
  return /(?:^|\/)(?:ba|z|fi|c)?sh$/.test(argv[0] ?? "");
}

function tabSessionIds(tab: TerminalTab): string[] {
  const ids: string[] = [];
  collect(tab.tree, ids);
  return ids;
}

function collect(node: TerminalTab["tree"], ids: string[]): void {
  if (node.kind === "leaf") ids.push(node.sessionId);
  else {
    collect(node.a, ids);
    collect(node.b, ids);
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function sidebarGroupName(session?: SessionInfo, cwd = liveSessionCwd(session)): string {
  if (!session) return "Workspace";
  const normalized = (cwd ?? session.command.cwd).replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return "Workspace";
  if ((parts[0] === "home" || parts[0] === "Users") && parts[2]) return parts[2];
  return parts[0] ?? "Workspace";
}
