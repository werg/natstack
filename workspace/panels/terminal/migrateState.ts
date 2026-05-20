import type { PerSessionState, SavedLayout, SplitNode, TerminalNotification, TerminalState, TerminalTab } from "./types.js";
import { defaultKeybindings, sanitizeKeybindingOverrides, type KeybindingAction, type KeybindingOverrides } from "./keybindings.js";

export const TERMINAL_STATE_SCHEMA_VERSION = 1;

export function defaultTerminalState(): TerminalState {
  return {
    tabs: [],
    notifications: [],
    paletteHistory: [],
    fontSize: 13,
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
    scrollbackBytes: 256 * 1024,
    themeOverride: "auto",
    notificationCenterOpen: false,
    notificationFilter: "all",
    sidebarCollapsed: false,
    perSession: {},
    savedLayouts: [],
    pasteMode: "path",
    imagePasteRelative: false,
    keybindings: {},
    schemaVersion: TERMINAL_STATE_SCHEMA_VERSION,
  };
}

export function migrateState(raw: unknown): TerminalState {
  const defaults = defaultTerminalState();
  if (!raw || typeof raw !== "object") return defaults;
  const state = raw as Partial<TerminalState> & {
    notifications?: Array<Partial<TerminalNotification> & { message?: string }>;
  };

  return {
    tabs: migrateTabs(state.tabs),
    activeTabId: typeof state.activeTabId === "string" ? state.activeTabId : defaults.activeTabId,
    zoomedSessionId: typeof state.zoomedSessionId === "string" ? state.zoomedSessionId : defaults.zoomedSessionId,
    notifications: (Array.isArray(state.notifications) ? state.notifications : []).map((notification) => ({
      notifId: typeof notification.notifId === "string" && notification.notifId ? notification.notifId : crypto.randomUUID(),
      sessionId: typeof notification.sessionId === "string" ? notification.sessionId : "",
      severity: isNotificationSeverity(notification.severity) ? notification.severity : "info",
      ...(typeof notification.title === "string" ? { title: notification.title } : {}),
      message: typeof notification.message === "string" ? notification.message : "",
      timestamp: clampNumber(notification.timestamp, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      read: typeof notification.read === "boolean" ? notification.read : false,
      ...(isNotificationSource(notification.source) ? { source: notification.source } : {}),
    })),
    paletteHistory: Array.isArray(state.paletteHistory) ? state.paletteHistory.filter((item): item is string => typeof item === "string").slice(0, 20) : defaults.paletteHistory,
    fontSize: clampNumber(state.fontSize, 9, 24, defaults.fontSize),
    fontFamily: typeof state.fontFamily === "string" && state.fontFamily.trim() ? state.fontFamily : defaults.fontFamily,
    scrollbackBytes: clampNumber(state.scrollbackBytes, 64 * 1024, 8 * 1024 * 1024, defaults.scrollbackBytes),
    themeOverride: isThemeOverride(state.themeOverride) ? state.themeOverride : defaults.themeOverride,
    notificationCenterOpen: typeof state.notificationCenterOpen === "boolean" ? state.notificationCenterOpen : defaults.notificationCenterOpen,
    notificationFilter: isNotificationFilter(state.notificationFilter) ? state.notificationFilter : defaults.notificationFilter,
    sidebarCollapsed: typeof state.sidebarCollapsed === "boolean" ? state.sidebarCollapsed : defaults.sidebarCollapsed,
    perSession: migratePerSession(state.perSession),
    savedLayouts: migrateSavedLayouts(state.savedLayouts),
    pasteMode: isPasteMode(state.pasteMode) ? state.pasteMode : defaults.pasteMode,
    imagePasteRelative: typeof state.imagePasteRelative === "boolean" ? state.imagePasteRelative : defaults.imagePasteRelative,
    keybindings: migrateKeybindings(state.keybindings),
    schemaVersion: TERMINAL_STATE_SCHEMA_VERSION,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function isThemeOverride(value: unknown): value is TerminalState["themeOverride"] {
  return value === "auto" || value === "light" || value === "dark";
}

function isNotificationFilter(value: unknown): value is TerminalState["notificationFilter"] {
  return value === "all" || value === "approval" || value === "failure" || value === "done";
}

function isNotificationSeverity(value: unknown): value is TerminalNotification["severity"] {
  return value === "info" || value === "done" || value === "waiting" || value === "approval" || value === "failure";
}

function isNotificationSource(value: unknown): value is NonNullable<TerminalNotification["source"]> {
  return value === "osc" || value === "snug" || value === "system";
}

function isPasteMode(value: unknown): value is TerminalState["pasteMode"] {
  return value === "path" || value === "dataUri" || value === "both";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function migrateTabs(value: unknown): TerminalTab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((tab): TerminalTab | undefined => {
      const tree = migrateSplitNode(tab["tree"]);
      const focusedSessionId = typeof tab["focusedSessionId"] === "string" ? tab["focusedSessionId"] : firstLeaf(tree);
      if (!tree || !focusedSessionId) return undefined;
      const badge = migrateTabBadge(tab["badge"]);
      return {
        tabId: typeof tab["tabId"] === "string" && tab["tabId"] ? tab["tabId"] : crypto.randomUUID(),
        label: typeof tab["label"] === "string" && tab["label"].trim() ? tab["label"] : "Terminal",
        tree,
        focusedSessionId,
        ...(typeof tab["icon"] === "string" && tab["icon"].trim() ? { icon: tab["icon"] } : {}),
        ...(typeof tab["accent"] === "string" && tab["accent"].trim() ? { accent: tab["accent"] } : {}),
        ...(badge ? { badge } : {}),
      };
    })
    .filter((tab): tab is TerminalTab => !!tab);
}

function migrateTabBadge(value: unknown): TerminalTab["badge"] | undefined {
  if (!isRecord(value)) return undefined;
  const badge = {
    ...(typeof value["text"] === "string" && value["text"] ? { text: value["text"] } : {}),
    ...(typeof value["color"] === "string" && value["color"] ? { color: value["color"] } : {}),
    ...(isNotificationSeverity(value["severity"]) ? { severity: value["severity"] } : {}),
  };
  return Object.keys(badge).length ? badge : undefined;
}

function migratePerSession(value: unknown): TerminalState["perSession"] {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] => typeof entry[0] === "string" && !!entry[0] && isRecord(entry[1]))
      .map(([sessionId, item]) => {
        const next: PerSessionState = {
          ...(typeof item["label"] === "string" ? { label: item["label"] } : {}),
          cwd: typeof item["cwd"] === "string" && item["cwd"] ? item["cwd"] : ".",
          ...(Array.isArray(item["originalArgv"]) ? { originalArgv: item["originalArgv"].filter((part: unknown): part is string => typeof part === "string") } : {}),
          readCursor: clampNumber(item["readCursor"], 0, Number.MAX_SAFE_INTEGER, 0),
          lastSeenAt: clampNumber(item["lastSeenAt"], 0, Number.MAX_SAFE_INTEGER, 0),
        };
        return [sessionId, next];
      }),
  );
}

function migrateSavedLayouts(value: unknown): TerminalState["savedLayouts"] {
  if (!Array.isArray(value)) return [];
  return [...value]
    .filter(isRecord)
    .map(migrateSavedLayout)
    .filter((layout): layout is SavedLayout => !!layout)
    .sort((a, b) => timestampOf(b["updatedAt"]) - timestampOf(a["updatedAt"]))
    .slice(0, 32);
}

function migrateSavedLayout(value: Record<string, unknown>): SavedLayout | undefined {
  const tree = migrateSplitNode(value["tree"]);
  if (!tree) return undefined;
  const id = typeof value["id"] === "string" && value["id"] ? value["id"] : crypto.randomUUID();
  const name = typeof value["name"] === "string" && value["name"].trim() ? value["name"] : "Saved layout";
  return {
    id,
    name,
    tree,
    cwds: stringRecord(value["cwds"]),
    labels: stringRecord(value["labels"]),
    ...(typeof value["icon"] === "string" && value["icon"].trim() ? { icon: value["icon"] } : {}),
    ...(typeof value["accent"] === "string" && value["accent"].trim() ? { accent: value["accent"] } : {}),
    updatedAt: timestampOf(value["updatedAt"]),
  };
}

function migrateSplitNode(value: unknown): SplitNode | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "leaf") {
    return typeof value["sessionId"] === "string" && value["sessionId"] ? { kind: "leaf", sessionId: value["sessionId"] } : undefined;
  }
  if (value["kind"] !== "split") return undefined;
  const a = migrateSplitNode(value["a"]);
  const b = migrateSplitNode(value["b"]);
  if (!a) return b;
  if (!b) return a;
  return {
    kind: "split",
    direction: value["direction"] === "column" ? "column" : "row",
    ratio: clampNumber(value["ratio"], 0.15, 0.85, 0.5),
    a,
    b,
  };
}

function firstLeaf(node: SplitNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === "leaf") return node.sessionId;
  return firstLeaf(node.a) ?? firstLeaf(node.b);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function timestampOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function migrateKeybindings(value: unknown): KeybindingOverrides {
  if (!isRecord(value)) return {};
  const sanitized = sanitizeKeybindingOverrides(value as KeybindingOverrides);
  return Object.fromEntries(
    Object.entries(sanitized).filter(([action, chord]) => chord !== defaultKeybindings[action as KeybindingAction]),
  ) as KeybindingOverrides;
}
