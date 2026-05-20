import type { KeybindingOverrides } from "./keybindings.js";

export interface ShellApi {
  exec(req: { command: string; args?: string[]; cwd?: string; shell?: boolean }): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  open(req: { command?: string; args?: string[]; cwd?: string; cols?: number; rows?: number; label?: string }): Promise<{ sessionId: string }>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  kill(sessionId: string, signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP"): Promise<void>;
  list(): Promise<SessionInfo[]>;
  get(sessionId: string): Promise<SessionInfo>;
  getSessionInfo(sessionId: string): Promise<SessionInfo>;
  watchSessionInfo(sessionId: string): Promise<Response>;
  watchAllSessionInfo?(): Promise<Response>;
  attach(sessionId: string, opts?: { after?: string }): Promise<Response>;
  awaitExit(sessionId: string): Promise<{ exitCode: number | null; signal?: string }>;
  getScrollback(sessionId: string, maxBytes?: number): Promise<{ text: string; cursor: string }>;
  dispose?(sessionId: string): Promise<void>;
  restart?(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ sessionId: string }>;
  clearScrollback?(sessionId: string): Promise<void>;
  setScrollbackLimit?(sessionId: string, maxBytes: number): Promise<void>;
  stashScratch?(bytes: Uint8Array, ext: string): Promise<{ absolutePath: string; workspaceRelative: string }>;
  setMeta?(sessionId: string, key: string, value: unknown): Promise<void>;
  getMeta?(sessionId: string, key?: string): Promise<unknown>;
  deleteMeta?(sessionId: string, key: string): Promise<void>;
  setLabel?(sessionId: string, label: string): Promise<void>;
}

export interface SessionInfo {
  sessionId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  gitBranch?: string;
  cols: number;
  rows: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  detectedAgent?: { kind: string; title?: string };
  detectedPorts: number[];
  detectedUrls: string[];
  lastActivityAt: number;
  bytesOut: number;
  meta: Record<string, unknown>;
}

export type SessionInfoEvent =
  | { type: "snapshot-batch"; sessions: SessionInfo[] }
  | { type: "snapshot"; sessionId: string; info: SessionInfo }
  | { type: "opened"; sessionId: string; info: SessionInfo }
  | { type: "exit"; sessionId: string; exit: { code: number | null; signal?: string; at: number } }
  | { type: "disposed"; sessionId: string }
  | { type: "heartbeat"; at: number };

export type SplitNode =
  | { kind: "leaf"; sessionId: string }
  | { kind: "split"; direction: "row" | "column"; ratio: number; a: SplitNode; b: SplitNode };

export interface TerminalTab {
  tabId: string;
  label: string;
  tree: SplitNode;
  focusedSessionId: string;
  icon?: string;
  accent?: string;
  badge?: { text?: string; color?: string; severity?: NotificationSeverity };
}

export type NotificationSeverity = "info" | "done" | "waiting" | "approval" | "failure";

export interface TerminalNotification {
  notifId: string;
  sessionId: string;
  severity: NotificationSeverity;
  title?: string;
  message: string;
  timestamp: number;
  read: boolean;
  source?: "osc" | "snug" | "system";
}

export interface SavedLayout {
  id: string;
  name: string;
  tree: SplitNode;
  cwds: Record<string, string>;
  labels: Record<string, string>;
  icon?: string;
  accent?: string;
  updatedAt: number;
}

export interface PerSessionState {
  label?: string;
  cwd: string;
  originalArgv?: string[];
  readCursor: number;
  lastSeenAt: number;
}

export interface TerminalState {
  tabs: TerminalTab[];
  activeTabId?: string;
  zoomedSessionId?: string;
  notifications: TerminalNotification[];
  paletteHistory: string[];
  fontSize: number;
  fontFamily: string;
  scrollbackBytes: number;
  themeOverride: "auto" | "light" | "dark";
  notificationCenterOpen: boolean;
  notificationFilter?: "all" | "approval" | "failure" | "done";
  sidebarCollapsed: boolean;
  perSession: Record<string, PerSessionState>;
  savedLayouts: SavedLayout[];
  pasteMode: "path" | "dataUri" | "both";
  imagePasteRelative: boolean;
  keybindings: KeybindingOverrides;
  schemaVersion: number;
}
