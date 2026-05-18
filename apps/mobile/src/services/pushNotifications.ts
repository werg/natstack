/**
 * Push notification service -- FCM/APNs token registration and approval actions.
 *
 * Native notification modules are loaded behind guarded `require` calls so the
 * development app and tests still run before Firebase/Notifee are installed.
 */
import { AppState, Platform, type AppStateStatus } from "react-native";
import { APPROVAL_CATEGORY_DECIDE, RPC_METHODS, type PushApprovalDataPayload, } from "@natstack/shared/approvalContract";
import type { PendingApproval } from "@natstack/shared/approvals";
import type { ShellClient } from "./shellClient";
import { APPROVAL_NOTIFICATION_CHANNEL_ID, getAndroidNotificationActions, } from "./notificationCategories";
import { drainBackgroundActionQueue, enqueueDeepLink, queueBackgroundAction, takePendingDeepLink, updateActionNotification, } from "./backgroundActionQueue";
import { isBackgroundDecision } from "./backgroundActionQueueCore";
declare const require: (moduleName: string) => unknown;
const PERMISSION_DENIED_TOAST_KEY = "natstack:push:permission-denied-toast-at";
const PERMISSION_DENIED_TOAST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
interface FirebaseMessagingModule {
    (): FirebaseMessagingInstance;
}
interface FirebaseMessagingInstance {
    requestPermission(): Promise<number | {
        authorizationStatus?: number;
    }>;
    getToken(): Promise<string>;
    deleteToken(): Promise<void>;
    onTokenRefresh(callback: (token: string) => void): () => void;
    onMessage(callback: (message: RemoteMessage) => void): () => void;
    onNotificationOpenedApp(callback: (message: RemoteMessage) => void): () => void;
    getInitialNotification(): Promise<RemoteMessage | null>;
}
interface NotifeeModule {
    cancelNotification(id: string): Promise<void>;
    displayNotification(notification: Record<string, unknown>): Promise<void>;
    getDisplayedNotifications?(): Promise<Array<{
        id?: string;
        notification?: {
            id?: string;
            data?: Record<string, unknown>;
        };
    }>>;
    onForegroundEvent(callback: (event: NotifeeEvent) => void | Promise<void>): () => void;
    requestPermission?(): Promise<{
        authorizationStatus?: number;
    } | undefined>;
}
interface NotifeeEvent {
    type: number;
    detail: {
        notification?: {
            id?: string;
            title?: string;
            data?: Record<string, unknown>;
            android?: Record<string, unknown>;
            ios?: Record<string, unknown>;
        };
        pressAction?: {
            id?: string;
        };
    };
}
interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}
/** Minimal remote message shape */
export interface RemoteMessage {
    messageId?: string;
    notification?: {
        title?: string;
        body?: string;
    };
    data?: Record<string, string | undefined>;
}
export interface PushRuntimeCallbacks {
    onApprovalDeepLink?: (approvalId: string) => void;
    onToast?: (toast: {
        title?: string;
        message: string;
        tone?: "info" | "success" | "warning" | "danger";
        durationMs?: number;
    }) => void;
}
/** Callback invoked when a notification is tapped */
export type NotificationTapHandler = (data: Record<string, string>) => void;
/** Active subscription cleanup functions */
let cleanupFunctions: Array<() => void> = [];
/**
 * Get a stable device-scoped client ID for push registration.
 * Persisted in Keychain so the same ID survives app restarts,
 * preventing orphaned registrations on the server.
 */
let cachedDeviceId: string | null = null;
async function getDeviceClientId(): Promise<string> {
    if (cachedDeviceId)
        return cachedDeviceId;
    try {
        const Keychain = require("react-native-keychain") as {
            ACCESSIBLE?: {
                WHEN_UNLOCKED_THIS_DEVICE_ONLY?: string;
            };
            getGenericPassword(options: {
                service: string;
            }): Promise<false | {
                password?: string;
            }>;
            setGenericPassword(username: string, password: string, options: {
                service: string;
                accessible?: string;
            }): Promise<unknown>;
        };
        const existing = await Keychain.getGenericPassword({ service: "natstack-push-device-id" });
        if (existing && existing.password) {
            cachedDeviceId = existing.password;
            return existing.password;
        }
    }
    catch {
        // Keychain unavailable -- fall through to generate.
    }
    cachedDeviceId = `device-${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        const Keychain = require("react-native-keychain") as {
            ACCESSIBLE?: {
                WHEN_UNLOCKED_THIS_DEVICE_ONLY?: string;
            };
            setGenericPassword(username: string, password: string, options: {
                service: string;
                accessible?: string;
            }): Promise<unknown>;
        };
        await Keychain.setGenericPassword("push-device-id", cachedDeviceId, {
            service: "natstack-push-device-id",
            accessible: Keychain.ACCESSIBLE?.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
    }
    catch {
        // ID works for this session but will not persist.
    }
    return cachedDeviceId;
}
function getFirebaseMessaging(): FirebaseMessagingModule | null {
    try {
        const mod = require("@react-native-firebase/messaging") as {
            default?: FirebaseMessagingModule;
        } & FirebaseMessagingModule;
        return mod.default ?? mod;
    }
    catch {
        console.warn("[PushNotifications] @react-native-firebase/messaging not available. Push disabled.");
        return null;
    }
}
function getNotifee(): {
    notifee: NotifeeModule;
    EventType: Record<string, number>;
} | null {
    try {
        const mod = require("@notifee/react-native") as {
            default?: NotifeeModule;
            EventType?: Record<string, number>;
        } & NotifeeModule;
        return {
            notifee: mod.default ?? mod,
            EventType: mod.EventType ?? {},
        };
    }
    catch {
        console.warn("[PushNotifications] @notifee/react-native not available. Local notifications disabled.");
        return null;
    }
}
function getAsyncStorage(): AsyncStorageLike | null {
    try {
        const mod = require("@react-native-async-storage/async-storage") as {
            default?: AsyncStorageLike;
        } & AsyncStorageLike;
        return mod.default ?? mod;
    }
    catch {
        return null;
    }
}
async function registerToken(shellClient: ShellClient, token: string): Promise<void> {
    const platform = Platform.OS === "ios" ? "ios" : "android";
    const clientId = await getDeviceClientId();
    await shellClient.transport.call("main", RPC_METHODS.push.register, [{ token, platform, clientId }]);
}
function isAuthorizedStatus(status: number | {
    authorizationStatus?: number;
} | undefined): boolean {
    const value = typeof status === "number" ? status : status?.authorizationStatus;
    return value === 1 || value === 2;
}
async function maybeShowDeniedToast(callbacks: PushRuntimeCallbacks): Promise<void> {
    const storage = getAsyncStorage();
    const now = Date.now();
    const lastShown = storage ? Number(await storage.getItem(PERMISSION_DENIED_TOAST_KEY) ?? 0) : 0;
    if (lastShown && now - lastShown < PERMISSION_DENIED_TOAST_INTERVAL_MS)
        return;
    callbacks.onToast?.({
        title: "Notifications are off",
        message: "Enable notifications in system settings to approve requests from the lock screen.",
        tone: "warning",
        durationMs: 8000,
    });
    if (storage)
        await storage.setItem(PERMISSION_DENIED_TOAST_KEY, String(now));
}
export async function displayApprovalNotification(message: RemoteMessage, notifee: Pick<NotifeeModule, "displayNotification" | "cancelNotification">): Promise<void> {
    const data = (message.data ?? {}) as PushApprovalDataPayload;
    if (data.kind === "approval-cancel") {
        const cancelKey = data.cancelKey ?? data.approvalId;
        if (cancelKey)
            await notifee.cancelNotification(cancelKey);
        return;
    }
    if (data.kind !== "approval-prompt" || !data.approvalId)
        return;
    const category = data.category ?? APPROVAL_CATEGORY_DECIDE;
    await notifee.displayNotification({
        id: data.cancelKey ?? data.approvalId,
        title: data.title ?? message.notification?.title ?? "Approval requested",
        body: data.body ?? message.notification?.body ?? "",
        data: {
            ...data,
            approvalId: data.approvalId,
            category,
        },
        android: {
            channelId: APPROVAL_NOTIFICATION_CHANNEL_ID,
            pressAction: { id: "open", launchActivity: "default" },
            actions: getAndroidNotificationActions(category),
        },
        ios: {
            categoryId: category,
        },
    });
}
export async function reconcilePushNotifications(shellClient: ShellClient, notifee?: NotifeeModule | null): Promise<void> {
    if (!notifee)
        return;
    try {
        const pending = await shellClient.transport.call<PendingApproval[]>("main", RPC_METHODS.shellApproval.listPending, []);
        const pendingIds = new Set(pending.map((approval) => approval.approvalId));
        const displayed = await notifee.getDisplayedNotifications?.() ?? [];
        for (const entry of displayed) {
            const id = entry.notification?.id ?? entry.id;
            if (id && !pendingIds.has(id)) {
                await notifee.cancelNotification(id);
            }
        }
    }
    catch (error) {
        console.warn("[PushNotifications] Failed to reconcile displayed notifications:", error);
    }
    await drainBackgroundActionQueue(shellClient, notifee);
}
async function handleDeepLink(approvalId: string, callbacks: PushRuntimeCallbacks): Promise<void> {
    await enqueueDeepLink(approvalId);
    callbacks.onApprovalDeepLink?.(approvalId);
}
async function consumeStoredDeepLink(callbacks: PushRuntimeCallbacks): Promise<void> {
    const approvalId = await takePendingDeepLink();
    if (approvalId)
        callbacks.onApprovalDeepLink?.(approvalId);
}
async function handleForegroundEvent(event: NotifeeEvent, EventType: Record<string, number>, shellClient: ShellClient, notifee: NotifeeModule, callbacks: PushRuntimeCallbacks): Promise<void> {
    const notification = event.detail.notification;
    const approvalId = readApprovalId(notification);
    if (!approvalId)
        return;
    const actionId = event.detail.pressAction?.id;
    if (event.type === EventType["ACTION_PRESS"] && isBackgroundDecision(actionId)) {
        if (shellClient.transport.status === "connected") {
            await shellClient.transport.call("main", RPC_METHODS.shellApproval.resolve, [approvalId,
                actionId]);
            await notifee.cancelNotification(approvalId);
        }
        else {
            await queueBackgroundAction(approvalId, actionId);
            await updateActionNotification(notifee, approvalId, notification);
        }
        return;
    }
    if ((event.type === EventType["ACTION_PRESS"] && actionId === "open") ||
        event.type === EventType["PRESS"]) {
        await handleDeepLink(approvalId, callbacks);
    }
}
function readApprovalId(notification: NotifeeEvent["detail"]["notification"]): string | null {
    const dataApprovalId = notification?.data?.["approvalId"];
    if (typeof dataApprovalId === "string" && dataApprovalId.length > 0)
        return dataApprovalId;
    return notification?.id ?? null;
}
/**
 * Register for push notifications and wire foreground lifecycle handling.
 *
 * Call this after the ShellClient is connected and authenticated.
 */
export async function registerForPushNotifications(shellClient: ShellClient, callbacksOrTap?: PushRuntimeCallbacks | NotificationTapHandler): Promise<() => void> {
    const callbacks: PushRuntimeCallbacks = typeof callbacksOrTap === "function"
        ? { onApprovalDeepLink: (approvalId) => callbacksOrTap({ approvalId }) }
        : callbacksOrTap ?? {};
    cleanupPushNotificationSubscriptions();
    const messagingModule = getFirebaseMessaging();
    const loadedNotifee = getNotifee();
    if (!messagingModule)
        return cleanupPushNotificationSubscriptions;
    const messaging = messagingModule();
    const notifee = loadedNotifee?.notifee ?? null;
    const authStatus = await messaging.requestPermission();
    if (notifee?.requestPermission) {
        await notifee.requestPermission().catch(() => undefined);
    }
    if (!isAuthorizedStatus(authStatus)) {
        await maybeShowDeniedToast(callbacks);
        return cleanupPushNotificationSubscriptions;
    }
    try {
        await registerToken(shellClient, await messaging.getToken());
        console.log(`[PushNotifications] Token registered (${Platform.OS === "ios" ? "ios" : "android"})`);
    }
    catch (error) {
        console.error("[PushNotifications] Failed to register token:", error);
    }
    cleanupFunctions.push(messaging.onTokenRefresh((token) => {
        void registerToken(shellClient, token).catch((error) => {
            console.error("[PushNotifications] Failed to register refreshed token:", error);
        });
    }));
    if (notifee) {
        cleanupFunctions.push(messaging.onMessage((message) => {
            void displayApprovalNotification(message, notifee).catch((error) => {
                console.error("[PushNotifications] Failed to display foreground notification:", error);
            });
        }));
        cleanupFunctions.push(notifee.onForegroundEvent((event) => {
            return handleForegroundEvent(event, loadedNotifee?.EventType ?? {}, shellClient, notifee, callbacks)
                .catch((error) => {
                console.error("[PushNotifications] Failed to handle foreground action:", error);
            });
        }));
    }
    cleanupFunctions.push(messaging.onNotificationOpenedApp((message) => {
        const approvalId = message.data?.["approvalId"];
        if (approvalId)
            void handleDeepLink(approvalId, callbacks);
    }));
    const initialNotification = await messaging.getInitialNotification().catch(() => null);
    if (initialNotification?.data?.["approvalId"]) {
        await handleDeepLink(initialNotification.data["approvalId"], callbacks);
    }
    const appStateSub = AppState.addEventListener("change", (nextState: AppStateStatus) => {
        if (nextState !== "active")
            return;
        void consumeStoredDeepLink(callbacks);
        void reconcilePushNotifications(shellClient, notifee);
    });
    cleanupFunctions.push(() => appStateSub.remove());
    cleanupFunctions.push(shellClient.transport.onReconnect(() => {
        void reconcilePushNotifications(shellClient, notifee);
    }));
    await consumeStoredDeepLink(callbacks);
    await reconcilePushNotifications(shellClient, notifee);
    return cleanupPushNotificationSubscriptions;
}
/**
 * Unregister push notifications.
 *
 * Deletes the device token from Firebase and notifies the server
 * to stop sending push notifications to this device.
 */
export async function unregisterPushNotifications(shellClient: ShellClient): Promise<void> {
    cleanupPushNotificationSubscriptions();
    const messagingModule = getFirebaseMessaging();
    if (!messagingModule)
        return;
    const messaging = messagingModule();
    try {
        await shellClient.transport.call("main", RPC_METHODS.push.unregister, [await getDeviceClientId()]);
    }
    catch (error) {
        console.error("[PushNotifications] Failed to unregister token from server:", error);
    }
    try {
        await messaging.deleteToken();
        console.log("[PushNotifications] Token deleted");
    }
    catch (error) {
        console.error("[PushNotifications] Failed to delete token:", error);
    }
}
function cleanupPushNotificationSubscriptions(): () => void {
    for (const cleanup of cleanupFunctions) {
        cleanup();
    }
    cleanupFunctions = [];
    return cleanupPushNotificationSubscriptions;
}
