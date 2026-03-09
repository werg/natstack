/**
 * Base runtime factory — transport-agnostic core shared by panels and workers.
 *
 * Provides: rpc, db, fs, callMain, workspace tree/branches/commits,
 * connection error handling, method exposure, theme, focus.
 *
 * Does NOT include: stateArgs, parent handles, panel-specific features.
 */

import { createRpcBridge, type RpcBridge, type RpcTransport } from "@natstack/rpc";
import { createRoutingBridge } from "../shared/routingBridge.js";
import { createDbClient } from "../shared/database.js";
import { createWorkerdClient } from "../shared/workerd.js";
import type {
  GitConfig,
  PubSubConfig,
  WorkspaceTree,
  BranchInfo,
  CommitInfo,
} from "../core/index.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";

export interface BaseRuntimeDeps {
  selfId: string;
  /** Primary transport (IPC for panels, WS for workers) */
  createTransport: () => RpcTransport;
  /** Optional secondary transport for routing bridge (panels use this for server) */
  createServerTransport?: () => RpcTransport | null;
  id: string;
  contextId: string;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gitConfig?: GitConfig | null;
  pubsubConfig?: PubSubConfig | null;
}

export function createBaseRuntime(deps: BaseRuntimeDeps) {
  deps.setupGlobals?.();

  const primaryTransport = deps.createTransport();
  const primaryBridge = createRpcBridge({ selfId: deps.selfId, transport: primaryTransport });

  // Create routing bridge if secondary transport available
  let rpc: RpcBridge = primaryBridge;
  if (deps.createServerTransport) {
    const serverTransport = deps.createServerTransport();
    if (serverTransport) {
      const serverBridge = createRpcBridge({
        selfId: deps.selfId,
        transport: serverTransport,
        callTimeoutMs: 30000,
        aiCallTimeoutMs: 300000,
      });
      rpc = createRoutingBridge(primaryBridge, serverBridge);
    }
  }

  const fs = deps.fs;
  const callMain = <T>(method: string, ...args: unknown[]) => rpc.call<T>("main", method, ...args);
  const db = createDbClient(rpc);
  const workers = createWorkerdClient(rpc);

  let currentTheme: ThemeAppearance = deps.initialTheme;
  const themeListeners = new Set<(theme: ThemeAppearance) => void>();

  const parseThemeAppearance = (payload: unknown): ThemeAppearance | null => {
    const appearance =
      typeof payload === "string"
        ? payload
        : typeof (payload as { theme?: unknown } | null)?.theme === "string"
          ? ((payload as { theme: ThemeAppearance }).theme)
          : null;
    if (appearance === "light" || appearance === "dark") return appearance;
    return null;
  };

  const onThemeEvent = (_fromId: string, payload: unknown) => {
    const theme = parseThemeAppearance(payload);
    if (!theme) return;
    currentTheme = theme;
    for (const listener of themeListeners) listener(currentTheme);
  };

  const themeUnsubscribers = [rpc.onEvent("runtime:theme", onThemeEvent)];
  const focusUnsubscribers: Array<() => void> = [];

  const onFocus = (callback: () => void) => {
    const unsub = rpc.onEvent("runtime:focus", () => callback());
    focusUnsubscribers.push(unsub);
    return () => {
      unsub();
      const idx = focusUnsubscribers.indexOf(unsub);
      if (idx !== -1) focusUnsubscribers.splice(idx, 1);
    };
  };

  const destroy = () => {
    for (const unsub of themeUnsubscribers) unsub();
    for (const unsub of focusUnsubscribers) unsub();
    focusUnsubscribers.length = 0;
    themeListeners.clear();
  };

  const onConnectionError = (
    callback: (error: { code: number; reason: string; source?: "electron" | "server" }) => void
  ): (() => void) => {
    return rpc.onEvent("runtime:connection-error", (fromId: string, payload: unknown) => {
      if (fromId !== "main") return;
      const data = payload as { code?: unknown; reason?: unknown; source?: unknown } | null;
      if (!data || typeof data.code !== "number" || typeof data.reason !== "string") return;
      callback({
        code: data.code,
        reason: data.reason,
        source: data.source === "electron" || data.source === "server" ? data.source : undefined,
      });
    });
  };

  return {
    id: deps.id,

    rpc,
    db,
    fs,
    workers,

    callMain,

    onConnectionError,

    getWorkspaceTree: () => callMain<WorkspaceTree>("bridge.getWorkspaceTree"),
    listBranches: (repoPath: string) => callMain<BranchInfo[]>("bridge.listBranches", repoPath),
    listCommits: (repoPath: string, ref?: string, limit?: number) =>
      callMain<CommitInfo[]>("bridge.listCommits", repoPath, ref, limit),

    getTheme: () => currentTheme,
    onThemeChange: (callback: (theme: ThemeAppearance) => void) => {
      callback(currentTheme);
      themeListeners.add(callback);
      return () => { themeListeners.delete(callback); };
    },

    onFocus,

    exposeMethod: rpc.exposeMethod.bind(rpc),

    gitConfig: deps.gitConfig ?? null,
    pubsubConfig: deps.pubsubConfig ?? null,
    contextId: deps.contextId,

    destroy,
  };
}

export type BaseRuntime = ReturnType<typeof createBaseRuntime>;
