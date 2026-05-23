import type { PerSessionState, ScratchBuffer, SplitNode, TerminalNotification, TerminalState } from "./types.js";
import { defaultKeybindings, sanitizeKeybindingOverrides, type KeybindingAction, type KeybindingOverrides } from "./keybindings.js";

export const TERMINAL_STATE_SCHEMA_VERSION = 2;
export const SCRATCH_BUFFER_MAX_COUNT = 50;
export const SCRATCH_BUFFER_MAX_TEXT_BYTES = 1_000_000;

export function defaultTerminalState(): TerminalState {
  return {
    tree: undefined,
    focusedSessionId: undefined,
    notifications: [],
    paletteHistory: [],
    fontSize: 13,
    fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
    scrollbackBytes: 256 * 1024,
    themeOverride: "auto",
    notificationCenterOpen: false,
    notificationFilter: "all",
    perSession: {},
    pasteMode: "path",
    imagePasteRelative: false,
    keybindings: {},
    scratchBuffers: [],
    scratchActiveBufferId: undefined,
    scratchOpen: false,
    schemaVersion: TERMINAL_STATE_SCHEMA_VERSION,
  };
}

export function migrateState(raw: unknown): TerminalState {
  const defaults = defaultTerminalState();
  if (!raw || typeof raw !== "object") return defaults;
  const state = raw as Partial<TerminalState> & {
    notifications?: Array<Partial<TerminalNotification> & { message?: string }>;
    scratchBuffers?: unknown;
    scratchActiveBufferId?: unknown;
  };
  const scratchBuffers = migrateScratchBuffers(state.scratchBuffers);
  const scratchActiveBufferId =
    typeof state.scratchActiveBufferId === "string" &&
    scratchBuffers.some((buffer) => buffer.bufferId === state.scratchActiveBufferId)
      ? state.scratchActiveBufferId
      : undefined;
  const restoredTree = migrateSplitNode(state.tree);
  const restoredFocus =
    typeof state.focusedSessionId === "string" && containsSession(restoredTree, state.focusedSessionId)
      ? state.focusedSessionId
      : undefined;

  return {
    tree: restoredTree,
    focusedSessionId: restoredFocus && containsSession(restoredTree, restoredFocus) ? restoredFocus : firstLeaf(restoredTree),
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
    perSession: migratePerSession(state.perSession),
    pasteMode: isPasteMode(state.pasteMode) ? state.pasteMode : defaults.pasteMode,
    imagePasteRelative: typeof state.imagePasteRelative === "boolean" ? state.imagePasteRelative : defaults.imagePasteRelative,
    keybindings: migrateKeybindings(state.keybindings),
    scratchBuffers,
    scratchActiveBufferId,
    scratchOpen: false,
    schemaVersion: TERMINAL_STATE_SCHEMA_VERSION,
  };
}

function migrateScratchBuffers(value: unknown): ScratchBuffer[] {
  if (!Array.isArray(value)) return [];
  const buffers: ScratchBuffer[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const bufferId = typeof entry["bufferId"] === "string" ? entry["bufferId"] : null;
    const text = typeof entry["text"] === "string" ? entry["text"] : null;
    if (!bufferId || text === null) continue;
    buffers.push({
      bufferId,
      text: text.length > SCRATCH_BUFFER_MAX_TEXT_BYTES
        ? text.slice(0, SCRATCH_BUFFER_MAX_TEXT_BYTES)
        : text,
      createdAt: clampNumber(entry["createdAt"], 0, Number.MAX_SAFE_INTEGER, Date.now()),
      updatedAt: clampNumber(entry["updatedAt"], 0, Number.MAX_SAFE_INTEGER, Date.now()),
    });
  }
  return buffers.slice(0, SCRATCH_BUFFER_MAX_COUNT);
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

function containsSession(node: SplitNode | undefined, sessionId: string): boolean {
  if (!node) return false;
  if (node.kind === "leaf") return node.sessionId === sessionId;
  return containsSession(node.a, sessionId) || containsSession(node.b, sessionId);
}

function migrateKeybindings(value: unknown): KeybindingOverrides {
  if (!isRecord(value)) return {};
  const sanitized = sanitizeKeybindingOverrides(value as KeybindingOverrides);
  return Object.fromEntries(
    Object.entries(sanitized).filter(([action, chord]) => chord !== defaultKeybindings[action as KeybindingAction]),
  ) as KeybindingOverrides;
}
