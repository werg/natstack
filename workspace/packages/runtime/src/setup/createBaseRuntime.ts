/**
 * Base runtime factory — transport-agnostic core shared by panels and workers.
 *
 * Provides: rpc, fs, callMain, workspace tree/branches/commits,
 * connection error handling, method exposure, theme, focus.
 *
 * Does NOT include: stateArgs, panel handles, panel-specific features.
 */
import {
    createRpcClient,
    envelopeFromMessage,
    type EnvelopeRpcTransport,
    type RpcTransport,
} from "@natstack/rpc";
import { createWorkerdClient } from "../shared/workerd.js";
import type { GatewayConfig } from "../shared/globals.js";
import { createMainCaller } from "../shared/mainRpc.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
export interface BaseRuntimeDeps {
    selfId: string;
    /** Primary transport (single WS for panels, WS for workers) */
    createTransport: () => RpcTransport;
    id: string;
    contextId: string;
    initialTheme: ThemeAppearance;
    fs: RuntimeFs;
    setupGlobals?: () => void;
    gatewayConfig?: GatewayConfig | null;
}
export function createBaseRuntime(deps: BaseRuntimeDeps) {
    deps.setupGlobals?.();
    const primaryTransport = deps.createTransport();
    const rpc = createRpcClient({
        selfId: deps.selfId,
        transport: envelopeTransportFromLegacy(deps.selfId, primaryTransport),
    });
    const fs = deps.fs;
    const callMain = createMainCaller(rpc);
    const workers = createWorkerdClient(rpc);
    let currentTheme: ThemeAppearance = deps.initialTheme;
    const themeListeners = new Set<(theme: ThemeAppearance) => void>();
    const parseThemeAppearance = (payload: unknown): ThemeAppearance | null => {
        const appearance = typeof payload === "string"
            ? payload
            : typeof (payload as {
                theme?: unknown;
            } | null)?.theme === "string"
                ? ((payload as {
                    theme: ThemeAppearance;
                }).theme)
                : null;
        if (appearance === "light" || appearance === "dark")
            return appearance;
        return null;
    };
    const onThemeEvent = (payload: unknown) => {
        const theme = parseThemeAppearance(payload);
        if (!theme)
            return;
        currentTheme = theme;
        for (const listener of themeListeners)
            listener(currentTheme);
    };
    // Theme events come from:
    // - Electron: via __natstackElectron.addEventListener
    // - Server WS: via rpc.on (for both Electron and standalone)
    const themeUnsubscribers = [rpc.on("runtime:theme", (event) => onThemeEvent(event.payload))];
    // Focus listeners — maintained as a direct set so Electron IPC events
    // can trigger them without going through the RPC bridge.
    const focusCallbacks = new Set<() => void>();
    const focusUnsubscribers: Array<() => void> = [];
    // Also listen for focus via RPC (standalone mode, server-sent events)
    const rpcFocusUnsub = rpc.on("runtime:focus", () => {
        for (const cb of focusCallbacks)
            cb();
    });
    focusUnsubscribers.push(rpcFocusUnsub);
    const onFocus = (callback: () => void) => {
        focusCallbacks.add(callback);
        const unsub = () => { focusCallbacks.delete(callback); };
        focusUnsubscribers.push(unsub);
        return () => {
            unsub();
            const idx = focusUnsubscribers.indexOf(unsub);
            if (idx !== -1)
                focusUnsubscribers.splice(idx, 1);
        };
    };
    // Wire __natstackElectron events if available (Electron mode)
    const electron = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;
    let electronListenerId: number | undefined;
    if (electron?.addEventListener) {
        electronListenerId = electron.addEventListener((event: string, payload: unknown) => {
            if (event === "runtime:theme") {
                onThemeEvent(payload);
            }
            else if (event === "runtime:focus") {
                // Directly invoke focus callbacks — no RPC bridge roundtrip needed
                for (const cb of focusCallbacks)
                    cb();
            }
        });
    }
    const destroy = () => {
        for (const unsub of themeUnsubscribers)
            unsub();
        for (const unsub of focusUnsubscribers)
            unsub();
        focusUnsubscribers.length = 0;
        themeListeners.clear();
        if (electronListenerId !== undefined && electron?.removeEventListener) {
            electron.removeEventListener(electronListenerId);
        }
    };
    const onConnectionError = (callback: (error: {
        code: number;
        reason: string;
        source?: "electron" | "server";
    }) => void): (() => void) => {
        return rpc.on("runtime:connection-error", (event) => {
            if (event.caller.callerId !== "main")
                return;
            const payload = event.payload;
            const data = payload as {
                code?: unknown;
                reason?: unknown;
                source?: unknown;
            } | null;
            if (!data || typeof data.code !== "number" || typeof data.reason !== "string")
                return;
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
        fs,
        workers,
        callMain,
        onConnectionError,
        getTheme: () => currentTheme,
        onThemeChange: (callback: (theme: ThemeAppearance) => void) => {
            callback(currentTheme);
            themeListeners.add(callback);
            return () => { themeListeners.delete(callback); };
        },
        onFocus,
        expose: (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) => {
            rpc.expose(method, (request) => handler(...request.args));
        },
        gatewayConfig: deps.gatewayConfig ?? null,
        contextId: deps.contextId,
        destroy,
    };
}
export type BaseRuntime = ReturnType<typeof createBaseRuntime>;

function envelopeTransportFromLegacy(selfId: string, transport: RpcTransport): EnvelopeRpcTransport {
    return {
        async send(envelope) {
            await transport.send(envelope.target, envelope.message);
        },
        onMessage(handler) {
            return transport.onAnyMessage((sourceId, message, callerKind) => {
                handler(envelopeFromMessage({
                    selfId,
                    from: sourceId,
                    target: selfId,
                    message,
                    callerKind,
                }));
            });
        },
    };
}
