import { RPC_METHODS } from "@natstack/shared/approvalContract";
import type { ShellClient } from "./shellClient";
import { clearAction as clearActionCore, clearWorkspaceMutation, enqueueAction as enqueueActionCore, enqueueWorkspaceMutation, loadDeepLink, loadPendingActions as loadPendingActionsCore, loadWorkspaceMutations, pruneStaleActions, serializeDeepLink, serializePendingActions, serializeWorkspaceMutations, type BackgroundApprovalDecision, type QueuedBackgroundAction, type QueuedWorkspaceMutation, } from "./backgroundActionQueueCore";
declare const require: (moduleName: string) => unknown;
const ACTION_QUEUE_KEY = "natstack:push:queued-actions";
const WORKSPACE_MUTATION_QUEUE_KEY = "natstack:workspace:queued-mutations";
const DEEP_LINK_KEY = "natstack:push:pending-deep-link";
export const SYNCING_NOTIFICATION_BODY = "Sent — syncing…";
interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}
interface NotifeeLike {
    cancelNotification(id: string): Promise<void>;
    displayNotification?(notification: Record<string, unknown>): Promise<void>;
}
function getAsyncStorage(): AsyncStorageLike | null {
    try {
        const mod = require("@react-native-async-storage/async-storage") as {
            default?: AsyncStorageLike;
        } & AsyncStorageLike;
        return mod.default ?? mod;
    }
    catch {
        console.warn("[PushQueue] AsyncStorage is unavailable. Background actions cannot be queued.");
        return null;
    }
}
async function readActions(storage: AsyncStorageLike, now = Date.now()): Promise<QueuedBackgroundAction[]> {
    return loadPendingActionsCore(await storage.getItem(ACTION_QUEUE_KEY), now);
}
async function writeActions(storage: AsyncStorageLike, actions: QueuedBackgroundAction[]): Promise<void> {
    if (actions.length === 0) {
        await storage.removeItem(ACTION_QUEUE_KEY);
        return;
    }
    await storage.setItem(ACTION_QUEUE_KEY, serializePendingActions(actions));
}
async function readWorkspaceMutations(storage: AsyncStorageLike, now = Date.now()): Promise<QueuedWorkspaceMutation[]> {
    return loadWorkspaceMutations(await storage.getItem(WORKSPACE_MUTATION_QUEUE_KEY), now);
}
async function writeWorkspaceMutations(storage: AsyncStorageLike, mutations: QueuedWorkspaceMutation[]): Promise<void> {
    if (mutations.length === 0) {
        await storage.removeItem(WORKSPACE_MUTATION_QUEUE_KEY);
        return;
    }
    await storage.setItem(WORKSPACE_MUTATION_QUEUE_KEY, serializeWorkspaceMutations(mutations));
}
export async function enqueueAction(action: QueuedBackgroundAction): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    const existing = await readActions(storage, action.queuedAt);
    await writeActions(storage, enqueueActionCore(existing, action, action.queuedAt));
}
export async function queueBackgroundAction(approvalId: string, decision: BackgroundApprovalDecision, queuedAt = Date.now()): Promise<void> {
    await enqueueAction({ approvalId, decision, queuedAt });
}
export async function loadPendingActions(now = Date.now()): Promise<QueuedBackgroundAction[]> {
    const storage = getAsyncStorage();
    if (!storage)
        return [];
    const actions = await readActions(storage, now);
    await writeActions(storage, actions);
    return actions;
}
export async function clearAction(approvalId: string): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    const actions = await readActions(storage);
    await writeActions(storage, clearActionCore(actions, approvalId));
}
export async function enqueueWorkspaceRpcMutation(mutation: Omit<QueuedWorkspaceMutation, "id" | "queuedAt"> & {
    id?: string;
    queuedAt?: number;
}): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    const queuedAt = mutation.queuedAt ?? Date.now();
    const id = mutation.id ?? `${queuedAt}:${mutation.service}.${mutation.method}:${Math.random().toString(36).slice(2)}`;
    const existing = await readWorkspaceMutations(storage, queuedAt);
    await writeWorkspaceMutations(storage, enqueueWorkspaceMutation(existing, {
        id,
        service: mutation.service,
        method: mutation.method,
        args: mutation.args,
        queuedAt,
    }, queuedAt));
}
export async function drainWorkspaceMutationQueue(shellClient: ShellClient): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    const mutations = await readWorkspaceMutations(storage);
    let remaining = mutations;
    for (const mutation of mutations) {
        try {
            await shellClient.transport.call("main", `${mutation.service}.${mutation.method}`, mutation.args);
            remaining = clearWorkspaceMutation(remaining, mutation.id);
            await writeWorkspaceMutations(storage, remaining);
        }
        catch (error) {
            console.warn(`[WorkspaceQueue] Failed to drain ${mutation.service}.${mutation.method}:`, error);
            break;
        }
    }
}
export async function pruneStale(now = Date.now()): Promise<QueuedBackgroundAction[]> {
    const storage = getAsyncStorage();
    if (!storage)
        return [];
    const actions = pruneStaleActions(await readActions(storage, now), now);
    await writeActions(storage, actions);
    return actions;
}
export async function enqueueDeepLink(approvalId: string): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    await storage.setItem(DEEP_LINK_KEY, serializeDeepLink(approvalId));
}
export async function takePendingDeepLink(): Promise<string | null> {
    const storage = getAsyncStorage();
    if (!storage)
        return null;
    const approvalId = loadDeepLink(await storage.getItem(DEEP_LINK_KEY));
    if (approvalId)
        await storage.removeItem(DEEP_LINK_KEY);
    return approvalId;
}
export async function updateActionNotification(notifee: NotifeeLike | null, approvalId: string, notification?: {
    title?: string;
    data?: Record<string, unknown>;
    android?: Record<string, unknown>;
    ios?: Record<string, unknown>;
}): Promise<void> {
    if (!notifee?.displayNotification)
        return;
    await notifee.displayNotification({
        id: approvalId,
        title: notification?.title ?? "Approval",
        body: SYNCING_NOTIFICATION_BODY,
        data: { approvalId, ...(notification?.data ?? {}) },
        android: notification?.android,
        ios: notification?.ios,
    });
}
export async function drainBackgroundActionQueue(shellClient: ShellClient, notifee?: NotifeeLike | null): Promise<void> {
    const storage = getAsyncStorage();
    if (!storage)
        return;
    const actions = await readActions(storage);
    let remaining = actions;
    for (const action of actions) {
        try {
            await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolve, [action.approvalId,
                action.decision]);
            remaining = clearActionCore(remaining, action.approvalId);
            await writeActions(storage, remaining);
            await notifee?.cancelNotification(action.approvalId);
        }
        catch (error) {
            console.warn(`[PushQueue] Failed to drain action for ${action.approvalId}:`, error);
        }
    }
}
export const backgroundActionQueueStorageKeys = {
    ACTION_QUEUE_KEY,
    WORKSPACE_MUTATION_QUEUE_KEY,
    DEEP_LINK_KEY,
} as const;
