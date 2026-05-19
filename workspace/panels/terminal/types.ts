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
  attach(sessionId: string, opts?: { after?: string }): Promise<Response>;
  awaitExit(sessionId: string): Promise<{ exitCode: number | null; signal?: string }>;
  getScrollback(sessionId: string, maxBytes?: number): Promise<{ text: string; cursor: string }>;
}

export interface SessionInfo {
  sessionId: string;
  label: string;
  command: { argv: string[]; cwd: string };
  cols: number;
  rows: number;
  alive: boolean;
  exit?: { code: number | null; signal?: string; at: number };
  detectedAgent?: { kind: string; title?: string };
}

export type SplitNode =
  | { kind: "leaf"; sessionId: string }
  | { kind: "split"; direction: "row" | "column"; ratio: number; a: SplitNode; b: SplitNode };

export interface TerminalTab {
  tabId: string;
  label: string;
  tree: SplitNode;
  focusedSessionId: string;
}

export interface TerminalState {
  tabs: TerminalTab[];
  activeTabId?: string;
  notifications: Array<{ notifId: string; sessionId: string; message: string; timestamp: number; read: boolean }>;
  paletteHistory: string[];
  fontSize?: number;
  notificationCenterOpen: boolean;
}
