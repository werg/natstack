import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { webContents } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import { serverCdpHostWsUrl } from "@natstack/shared/connect";
import type { ViewManager } from "./viewManager.js";
import type {
  RuntimeDiagnosticRecord,
  RuntimeDiagnosticsStore,
} from "../server/runtimeDiagnosticsStore.js";

const log = createDevLogger("CdpHostProvider");
const CONSOLE_LOG_HISTORY_CAPACITY = 1_000;
const CONSOLE_ERROR_HISTORY_CAPACITY = 500;

export interface CdpHostProviderSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "message", listener: (data: Buffer | string) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  off?(event: "open" | "close", listener: () => void): this;
  off?(event: "message", listener: (data: Buffer | string) => void): this;
  off?(event: "error", listener: (error: unknown) => void): this;
}

export interface CdpHostProviderTarget {
  targetId: string;
  webContentsId: number;
}

export type PanelConsoleHistoryLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface PanelConsoleHistoryEntry {
  timestamp: number;
  level: PanelConsoleHistoryLevel;
  message: string;
  line: number;
  sourceId: string;
  url: string;
  source?: "console" | "lifecycle";
  fields?: Record<string, unknown>;
}

export interface PanelConsoleHistoryResult {
  entries: PanelConsoleHistoryEntry[];
  errors: PanelConsoleHistoryEntry[];
  dropped: {
    entries: number;
    errors: number;
  };
  capacity: {
    entries: number;
    errors: number;
  };
}

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: PanelConsoleHistoryLevel[];
}

export interface CdpHostProviderOptions {
  serverUrl: string;
  authToken: string | (() => string);
  hostConnectionId: string;
  getViewManager: () => ViewManager | null;
  socketFactory?: (url: string) => CdpHostProviderSocket;
  reconnectDelayMs?: number;
  diagnosticsStore?: RuntimeDiagnosticsStore;
  onHostCommand?: (targetId: string, action: string, args: unknown[]) => unknown | Promise<unknown>;
  /**
   * Forward a panel diagnostic to the server so it lands in the per-unit
   * diagnostics store (queryable via `workspace.units.diagnostics`). Invoked
   * for warn/error console output and all lifecycle events; full console
   * history stays local to the shell, served via the CDP host.
   */
  forwardDiagnostic?: (targetId: string, entry: PanelConsoleHistoryEntry) => void;
}

interface ProviderMessage {
  type?: string;
  targetId?: string;
  requestId?: string;
  reason?: string;
  action?: string;
  args?: unknown[];
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpHostProvider {
  private readonly targets = new Map<string, number>();
  private readonly debuggerAttached = new Map<string, boolean>();
  private readonly debuggerAttaching = new Map<string, Promise<void>>();
  private readonly debuggerCommandQueues = new Map<string, Promise<unknown>>();
  private readonly activeCdpTargets = new Set<string>();
  private readonly debuggerEventHandlers = new Map<
    string,
    (event: unknown, method: string, params?: unknown, sessionId?: string) => void
  >();
  private readonly consoleHistories = new Map<
    string,
    {
      entries: PanelConsoleHistoryEntry[];
      errors: PanelConsoleHistoryEntry[];
      droppedEntries: number;
      droppedErrors: number;
    }
  >();
  private readonly consoleListeners = new Map<
    string,
    {
      contents: Electron.WebContents;
      handlers: Array<{ event: string; handler: (...args: unknown[]) => void }>;
    }
  >();
  private socket: CdpHostProviderSocket | null = null;
  private authenticated = false;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CdpHostProviderOptions) {}

  start(): void {
    this.running = true;
    this.clearReconnectTimer();
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const url = serverCdpHostWsUrl(this.options.serverUrl, this.options.hostConnectionId);
    const socket: CdpHostProviderSocket =
      this.options.socketFactory?.(url) ?? (new WebSocket(url) as CdpHostProviderSocket);
    this.socket = socket;
    this.authenticated = false;

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "natstack:cdp-auth", token: this.authToken() }));
    });
    socket.on("message", (data: Buffer | string) => {
      this.handleSocketMessage(data).catch((error: unknown) => {
        log.warn(
          `CDP host provider message failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.authenticated = false;
      this.detachAll();
      this.scheduleReconnect();
    });
    socket.on("error", (error: unknown) => {
      log.warn(
        `CDP host provider socket error: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    socket?.close(1000, "CDP host provider stopped");
    this.detachAll();
  }

  registerTarget(targetId: string, webContentsId: number): void {
    this.targets.set(targetId, webContentsId);
    this.attachConsoleHistory(targetId);
    this.sendRegistration(targetId, webContentsId);
  }

  unregisterTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.activeCdpTargets.delete(targetId);
    this.detachConsoleHistory(targetId);
    this.send({ type: "cdp:unregister", targetId: targetId });
    this.detachDebuggerIfIdle(targetId, this.getTargetContents(targetId), { force: true });
  }

  cleanupPanelAccess(_panelId: string): void {
    // Access grants live on the server-side broker. The Electron provider only
    // owns local webContents registration and debugger lifecycle.
  }

  async getAccessibilityTree(targetId: string): Promise<unknown[]> {
    const contents = this.requireTargetContents(targetId);
    await this.ensureDebuggerAttached(targetId, contents);
    try {
      const result = (await this.sendDebuggerCommand(
        targetId,
        contents,
        "Accessibility.getFullAXTree"
      )) as { nodes?: unknown[] };
      return result.nodes ?? [];
    } finally {
      this.detachDebuggerIfIdle(targetId, contents);
    }
  }

  getConsoleHistory(
    targetId: string,
    options: PanelConsoleHistoryOptions = {}
  ): PanelConsoleHistoryResult {
    this.requireTargetContents(targetId);
    const history = this.historyFor(targetId);
    const stored = this.options.diagnosticsStore?.history(targetId, {
      limit: options.limit,
      errorLimit: options.errorLimit,
    });
    const rawEntries =
      stored?.entries.map(runtimeDiagnosticToPanelConsoleHistoryEntry) ?? history.entries;
    const rawErrors =
      stored?.errors.map(runtimeDiagnosticToPanelConsoleHistoryEntry) ?? history.errors;
    const levels = new Set(options.levels ?? []);
    const entries =
      levels.size > 0 ? rawEntries.filter((entry) => levels.has(entry.level)) : rawEntries;
    const limit = normalizeLimit(options.limit, entries.length);
    const errorLimit = normalizeLimit(options.errorLimit, rawErrors.length);
    return {
      entries: limit > 0 ? entries.slice(-limit) : [],
      errors: errorLimit > 0 ? rawErrors.slice(-errorLimit) : [],
      dropped: {
        entries: stored?.dropped.entries ?? history.droppedEntries,
        errors: stored?.dropped.errors ?? history.droppedErrors,
      },
      capacity: {
        entries: stored?.capacity.entries ?? CONSOLE_LOG_HISTORY_CAPACITY,
        errors: stored?.capacity.errors ?? CONSOLE_ERROR_HISTORY_CAPACITY,
      },
    };
  }

  async handleProviderMessageForTest(message: ProviderMessage): Promise<void> {
    await this.handleProviderMessage(message);
  }

  private async handleSocketMessage(data: Buffer | string): Promise<void> {
    const message = JSON.parse(data.toString()) as ProviderMessage;
    if (message.type === "natstack:cdp-auth-ok") {
      this.authenticated = true;
      this.registerAllTargets();
      return;
    }
    await this.handleProviderMessage(message);
  }

  private async handleProviderMessage(message: ProviderMessage): Promise<void> {
    switch (message.type) {
      case "cdp:command":
        await this.handleCdpCommand(message);
        return;
      case "cdp:detach":
        if (typeof message.targetId === "string") {
          this.activeCdpTargets.delete(message.targetId);
          this.detachDebuggerIfIdle(message.targetId, this.getTargetContents(message.targetId), {
            force: true,
          });
        }
        return;
      case "cdp:register-rejected":
        if (typeof message.targetId === "string") {
          log.warn(`Broker rejected CDP target registration: ${message.targetId}`);
          if (message.reason === "unknown_panel") {
            const contents = this.getTargetContents(message.targetId);
            this.targets.delete(message.targetId);
            this.activeCdpTargets.delete(message.targetId);
            this.detachConsoleHistory(message.targetId);
            this.detachDebuggerIfIdle(message.targetId, contents, { force: true });
          }
        }
        return;
      case "nav:command":
        await this.handleNavCommand(message);
        return;
      case "host:command":
        await this.handleHostCommand(message);
        return;
      default:
        return;
    }
  }

  private async handleNavCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, action } = message;
    if (!targetId || !requestId || !action) return;
    try {
      const contents = this.requireTargetContents(targetId);
      switch (action) {
        case "navigate": {
          if (typeof message.url !== "string" || !message.url) {
            throw new Error("Navigation URL is required");
          }
          try {
            await contents.loadURL(message.url);
          } catch (error) {
            if (isNavigationAbort(error)) break;
            throw error;
          }
          break;
        }
        case "reload":
          contents.reload();
          break;
        case "goBack":
          contents.goBack();
          break;
        case "goForward":
          contents.goForward();
          break;
        case "stop":
          contents.stop();
          break;
        default:
          throw new Error(`Unknown navigation command: ${action}`);
      }
      this.send({ type: "nav:result", targetId, requestId });
    } catch (error) {
      this.send({
        type: "nav:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleHostCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, action } = message;
    if (!targetId || !requestId || !action) return;
    try {
      const args = Array.isArray(message.args) ? message.args : [];
      const result = this.options.onHostCommand
        ? await this.options.onHostCommand(targetId, action, args)
        : await this.handleBuiltInHostCommand(targetId, action, args);
      this.send({ type: "host:result", targetId, requestId, result });
    } catch (error) {
      this.send({
        type: "host:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleBuiltInHostCommand(
    targetId: string,
    action: string,
    args: unknown[]
  ): Promise<unknown> {
    if (action === "openDevTools") {
      const mode = args[0] === "right" || args[0] === "bottom" ? args[0] : "detach";
      this.options.getViewManager()?.openDevTools(targetId, mode);
      return null;
    }
    if (action === "accessibilityTree") {
      return this.getAccessibilityTree(targetId);
    }
    if (action === "consoleHistory") {
      return this.getConsoleHistory(targetId, normalizeConsoleHistoryOptions(args[0]));
    }
    throw new Error(`Unknown host command: ${action}`);
  }

  private attachConsoleHistory(targetId: string): void {
    const contents = this.getTargetContents(targetId);
    if (!contents || contents.isDestroyed()) return;
    const existing = this.consoleListeners.get(targetId);
    if (existing?.contents === contents) return;
    this.detachConsoleHistory(targetId);
    this.historyFor(targetId);
    const consoleMessage = (
      _event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown
    ) => {
      this.recordConsoleMessage(targetId, contents, level, message, line, sourceId);
    };
    const renderProcessGone = (_event: unknown, details: unknown) => {
      this.recordLifecycleDiagnostic(targetId, contents, "error", "render-process-gone", details);
    };
    const didFailLoad = (
      _event: unknown,
      errorCode: unknown,
      errorDescription: unknown,
      validatedURL: unknown,
      isMainFrame: unknown
    ) => {
      this.recordLifecycleDiagnostic(targetId, contents, "error", "did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    };
    const unresponsive = () => {
      this.recordLifecycleDiagnostic(targetId, contents, "error", "unresponsive");
    };
    const emitter = contents as unknown as EventEmitter;
    const handlers = [
      { event: "console-message", handler: consoleMessage },
      { event: "render-process-gone", handler: renderProcessGone },
      { event: "did-fail-load", handler: didFailLoad },
      { event: "unresponsive", handler: unresponsive },
    ];
    for (const entry of handlers) emitter.on(entry.event, entry.handler);
    this.consoleListeners.set(targetId, { contents, handlers });
  }

  private detachConsoleHistory(targetId: string): void {
    const existing = this.consoleListeners.get(targetId);
    if (!existing) return;
    const emitter = existing.contents as unknown as EventEmitter;
    for (const entry of existing.handlers) emitter.off(entry.event, entry.handler);
    this.consoleListeners.delete(targetId);
  }

  private recordConsoleMessage(
    targetId: string,
    contents: Electron.WebContents,
    level: unknown,
    message: unknown,
    line: unknown,
    sourceId: unknown
  ): void {
    const history = this.historyFor(targetId);
    const entry: PanelConsoleHistoryEntry = {
      timestamp: Date.now(),
      level: normalizeConsoleLevel(level),
      message: typeof message === "string" ? message : String(message ?? ""),
      line: typeof line === "number" ? line : 0,
      sourceId: typeof sourceId === "string" ? sourceId : "",
      url: safeWebContentsUrl(contents),
      source: "console",
    };
    this.persistPanelDiagnostic(targetId, entry);
    history.entries.push(entry);
    while (history.entries.length > CONSOLE_LOG_HISTORY_CAPACITY) {
      history.entries.shift();
      history.droppedEntries += 1;
    }
    if (entry.level === "error") {
      history.errors.push(entry);
      while (history.errors.length > CONSOLE_ERROR_HISTORY_CAPACITY) {
        history.errors.shift();
        history.droppedErrors += 1;
      }
    }
  }

  private recordLifecycleDiagnostic(
    targetId: string,
    contents: Electron.WebContents,
    level: PanelConsoleHistoryLevel,
    message: string,
    fields?: unknown
  ): void {
    const history = this.historyFor(targetId);
    const entry: PanelConsoleHistoryEntry = {
      timestamp: Date.now(),
      level,
      message,
      line: 0,
      sourceId: "",
      url: safeWebContentsUrl(contents),
      source: "lifecycle",
      fields:
        fields && typeof fields === "object" ? (fields as Record<string, unknown>) : undefined,
    };
    this.persistPanelDiagnostic(targetId, entry);
    history.entries.push(entry);
    while (history.entries.length > CONSOLE_LOG_HISTORY_CAPACITY) {
      history.entries.shift();
      history.droppedEntries += 1;
    }
    if (entry.level === "error") {
      history.errors.push(entry);
      while (history.errors.length > CONSOLE_ERROR_HISTORY_CAPACITY) {
        history.errors.shift();
        history.droppedErrors += 1;
      }
    }
  }

  private persistPanelDiagnostic(targetId: string, entry: PanelConsoleHistoryEntry): void {
    if (
      this.options.forwardDiagnostic &&
      (entry.source === "lifecycle" || entry.level === "warning" || entry.level === "error")
    ) {
      try {
        this.options.forwardDiagnostic(targetId, entry);
      } catch {
        // Best-effort: forwarding must never break local capture.
      }
    }
    this.options.diagnosticsStore?.record({
      entityId: targetId,
      kind: "panel",
      timestamp: entry.timestamp,
      level: panelLevelToRuntimeLevel(entry.level),
      message: entry.message,
      source: entry.source ?? "console",
      fields: entry.fields,
      url: entry.url,
      line: entry.line,
      sourceId: entry.sourceId,
    });
  }

  private historyFor(targetId: string): {
    entries: PanelConsoleHistoryEntry[];
    errors: PanelConsoleHistoryEntry[];
    droppedEntries: number;
    droppedErrors: number;
  } {
    const existing = this.consoleHistories.get(targetId);
    if (existing) return existing;
    const created = { entries: [], errors: [], droppedEntries: 0, droppedErrors: 0 };
    this.consoleHistories.set(targetId, created);
    return created;
  }

  private async handleCdpCommand(message: ProviderMessage): Promise<void> {
    const { targetId, requestId, method } = message;
    if (!targetId || !requestId || !method) return;
    try {
      const contents = this.requireTargetContents(targetId);
      await this.ensureDebuggerAttached(targetId, contents);
      this.activeCdpTargets.add(targetId);
      const result = await this.sendDebuggerCommand(
        targetId,
        contents,
        method,
        message.params,
        message.sessionId
      );
      this.send({ type: "cdp:result", targetId, requestId, result });
    } catch (error) {
      this.send({
        type: "cdp:error",
        targetId,
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private registerAllTargets(): void {
    for (const [targetId, webContentsId] of this.targets) {
      this.sendRegistration(targetId, webContentsId);
    }
  }

  private sendRegistration(targetId: string, webContentsId: number): void {
    if (!this.authenticated) return;
    this.send({ type: "cdp:register", targetId: targetId, tabId: webContentsId });
  }

  private getTargetContents(targetId: string): Electron.WebContents | null {
    const fromView = this.options.getViewManager()?.getWebContents(targetId);
    if (fromView && !fromView.isDestroyed()) return fromView;
    const id = this.targets.get(targetId);
    if (id === undefined) return null;
    const fromId = webContents?.fromId?.(id);
    return fromId && !fromId.isDestroyed() ? fromId : null;
  }

  private requireTargetContents(targetId: string): Electron.WebContents {
    const contents = this.getTargetContents(targetId);
    if (!contents || contents.isDestroyed()) {
      throw new Error(`Panel webContents not found: ${targetId}`);
    }
    return contents;
  }

  private async ensureDebuggerAttached(
    targetId: string,
    contents: Electron.WebContents
  ): Promise<void> {
    if (this.debuggerAttached.get(targetId)) return;
    const existing = this.debuggerAttaching.get(targetId);
    if (existing) {
      await existing;
      return;
    }
    const attachPromise = (async () => {
      try {
        contents.debugger.attach("1.3");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/already.*attach/i.test(message)) {
          throw error;
        }
        // Already attached by this process or another cooperating caller.
      }
      this.debuggerAttached.set(targetId, true);
    })();
    this.debuggerAttaching.set(targetId, attachPromise);
    try {
      await attachPromise;
    } finally {
      this.debuggerAttaching.delete(targetId);
    }

    if (this.debuggerEventHandlers.has(targetId)) return;
    const handler = (_event: unknown, method: string, params?: unknown, sessionId?: string) => {
      this.send({
        type: "cdp:event",
        targetId: targetId,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      });
    };
    this.debuggerEventHandlers.set(targetId, handler);
    const debuggerEmitter = contents.debugger as unknown as EventEmitter;
    debuggerEmitter.on("message", handler);
  }

  private sendDebuggerCommand(
    targetId: string,
    contents: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const previous = this.debuggerCommandQueues.get(targetId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => {
        if (contents.isDestroyed()) {
          throw new Error(`Panel webContents destroyed: ${targetId}`);
        }
        return contents.debugger.sendCommand(method, params, sessionId);
      });
    const tail = run
      .catch(() => undefined)
      .finally(() => {
        if (this.debuggerCommandQueues.get(targetId) === tail) {
          this.debuggerCommandQueues.delete(targetId);
        }
      });
    this.debuggerCommandQueues.set(targetId, tail);
    return run;
  }

  private detachDebuggerIfIdle(
    targetId: string,
    contents: Electron.WebContents | null | undefined,
    opts: { force?: boolean } = {}
  ): void {
    if (!this.debuggerAttached.get(targetId)) return;
    if (!opts.force && this.activeCdpTargets.has(targetId)) return;
    try {
      if (contents && !contents.isDestroyed() && opts.force) {
        contents.debugger.detach();
      } else if (contents && !contents.isDestroyed() && !opts.force) {
        contents.debugger.detach();
      }
    } catch {
      // Already detached.
    } finally {
      const handler = this.debuggerEventHandlers.get(targetId);
      if (handler && contents && !contents.isDestroyed()) {
        (contents.debugger as unknown as EventEmitter).off("message", handler);
      }
      this.debuggerEventHandlers.delete(targetId);
      this.debuggerAttached.delete(targetId);
      this.debuggerAttaching.delete(targetId);
      this.debuggerCommandQueues.delete(targetId);
      if (opts.force) this.activeCdpTargets.delete(targetId);
    }
  }

  private detachAll(): void {
    for (const targetId of this.debuggerAttached.keys()) {
      this.detachDebuggerIfIdle(targetId, this.getTargetContents(targetId), { force: true });
    }
    for (const targetId of this.consoleListeners.keys()) {
      this.detachConsoleHistory(targetId);
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private authToken(): string {
    return typeof this.options.authToken === "function"
      ? this.options.authToken()
      : this.options.authToken;
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delayMs = this.options.reconnectDelayMs ?? 1_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.start();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function normalizeConsoleHistoryOptions(value: unknown): PanelConsoleHistoryOptions {
  if (!value || typeof value !== "object") return {};
  const record = value as { limit?: unknown; errorLimit?: unknown; levels?: unknown };
  const options: PanelConsoleHistoryOptions = {};
  if (typeof record.limit === "number") options.limit = record.limit;
  if (typeof record.errorLimit === "number") options.errorLimit = record.errorLimit;
  if (Array.isArray(record.levels)) {
    options.levels = record.levels.map(normalizeConsoleLevel);
  }
  return options;
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeConsoleLevel(level: unknown): PanelConsoleHistoryLevel {
  if (level === "debug" || level === "info" || level === "warning" || level === "error") {
    return level;
  }
  if (level === "warn") return "warning";
  if (level === 0) return "debug";
  if (level === 1) return "info";
  if (level === 2) return "warning";
  if (level === 3) return "error";
  return "unknown";
}

function panelLevelToRuntimeLevel(
  level: PanelConsoleHistoryLevel
): RuntimeDiagnosticRecord["level"] {
  if (level === "warning") return "warn";
  if (level === "unknown") return "info";
  return level;
}

function runtimeDiagnosticToPanelConsoleHistoryEntry(
  record: RuntimeDiagnosticRecord
): PanelConsoleHistoryEntry {
  return {
    timestamp: record.timestamp,
    level: runtimeLevelToPanelLevel(record.level),
    message: record.message,
    line: record.line ?? 0,
    sourceId: record.sourceId ?? "",
    url: record.url ?? "",
    source: record.source === "lifecycle" ? "lifecycle" : "console",
    fields: record.fields,
  };
}

function runtimeLevelToPanelLevel(
  level: RuntimeDiagnosticRecord["level"]
): PanelConsoleHistoryLevel {
  return level === "warn" ? "warning" : level;
}

function safeWebContentsUrl(contents: Electron.WebContents): string {
  try {
    return contents.getURL();
  } catch {
    return "";
  }
}

function isNavigationAbort(error: unknown): boolean {
  const record = error as { code?: unknown; errno?: unknown; message?: unknown };
  return (
    record?.errno === -3 ||
    record?.code === "ERR_ABORTED" ||
    (typeof record?.message === "string" && record.message.includes("ERR_ABORTED"))
  );
}
