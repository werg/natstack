/**
 * Notification client — shared between panels and workers.
 *
 * Allows callers to push notifications to the shell chrome area
 * (info toasts, errors, warnings, success confirmations).
 */
import type { RpcCaller } from "@natstack/rpc";

type NotificationAction = {
    id?: string;
    label: string;
    variant?: "solid" | "soft" | "ghost";
    onClick?: () => void | Promise<void>;
};

type NotificationShowOptions = {
    id?: string;
    type: "info" | "success" | "warning" | "error";
    title: string;
    message?: string;
    ttl?: number;
    actions?: NotificationAction[];
};

type RpcCallerWithEvents = RpcCaller & {
    onEvent?: (event: string, listener: (fromId: string, payload: unknown) => void) => () => void;
};

export interface NotificationClient {
    /** Show a notification. Returns the notification ID. */
    show(opts: NotificationShowOptions): Promise<string>;
    /** Dismiss a notification by ID. */
    dismiss(id: string): Promise<void>;
}
export function createNotificationClient(rpc: RpcCaller): NotificationClient {
    const rpcWithEvents = rpc as RpcCallerWithEvents;
    const actionHandlers = new Map<string, Map<string, () => void | Promise<void>>>();
    let actionSubscription: Promise<void> | null = null;
    let unsubscribeActionEvents: (() => void) | undefined;

    async function ensureActionSubscription(): Promise<void> {
        if (actionSubscription) return actionSubscription;
        actionSubscription = (async () => {
            if (!rpcWithEvents.onEvent) return;
            unsubscribeActionEvents ??= rpcWithEvents.onEvent("event:notification:action", (_fromId, payload) => {
                const action = parseNotificationAction(payload);
                if (!action) return;
                const handlers = actionHandlers.get(action.id);
                if (action.actionId === "dismiss") {
                    actionHandlers.delete(action.id);
                    return;
                }
                const handler = handlers?.get(action.actionId);
                if (!handler) return;
                actionHandlers.delete(action.id);
                void Promise.resolve(handler()).catch((err) => {
                    console.warn("notification action failed", err);
                });
            });
            await rpc.call<void>("main", "events.subscribe", ["notification:action"]).catch(() => {});
        })();
        return actionSubscription;
    }

    return {
        async show(opts) {
            const handlers = new Map<string, () => void | Promise<void>>();
            const actions = opts.actions?.map(({ onClick, ...action }, index) => {
                const id = action.id ?? actionIdFor(action.label, index);
                if (onClick) handlers.set(id, onClick);
                return { ...action, id };
            });
            const id = handlers.size > 0 ? opts.id ?? makeNotificationId() : opts.id;
            if (id && handlers.size > 0) {
                actionHandlers.set(id, handlers);
                if (opts.ttl && opts.ttl > 0) {
                    setTimeout(() => actionHandlers.delete(id), opts.ttl + 1000);
                }
                await ensureActionSubscription();
            }
            return rpc.call<string>("main", "notification.show", [{ ...opts, id, actions }]);
        },
        async dismiss(id) {
            actionHandlers.delete(id);
            await rpc.call<void>("main", "notification.dismiss", [id]);
        },
    };
}

function parseNotificationAction(payload: unknown): { id: string; actionId: string } | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    return typeof record["id"] === "string" && typeof record["actionId"] === "string"
        ? { id: record["id"], actionId: record["actionId"] }
        : undefined;
}

function makeNotificationId(): string {
    return `notif-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function actionIdFor(label: string, index: number): string {
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return slug ? `${slug}-${index}` : `action-${index}`;
}
