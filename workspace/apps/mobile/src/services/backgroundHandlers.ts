import type { PushApprovalDataPayload } from "@natstack/shared/approvalContract";
import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
} from "@natstack/shared/approvalContract";
import {
  APPROVAL_NOTIFICATION_CHANNEL_ID,
  getAndroidNotificationActions,
} from "./notificationCategories";
import {
  enqueueDeepLink,
  queueBackgroundAction,
  updateActionNotification,
} from "./backgroundActionQueue";
import { isBackgroundDecision } from "./backgroundActionQueueCore";
import { requireApprovedAppCapability } from "./appCapabilities";
import { isNativeFirebaseConfigured } from "./nativeFirebase";

declare const require: (moduleName: string) => unknown;

interface RemoteMessage {
  notification?: {
    title?: string;
    body?: string;
  };
  data?: Record<string, string | undefined>;
}

interface NotifeeModule {
  displayNotification(notification: Record<string, unknown>): Promise<void>;
  cancelNotification(id: string): Promise<void>;
  onBackgroundEvent(callback: (event: NotifeeEvent) => Promise<void>): void;
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

interface MessagingModule {
  (): {
    setBackgroundMessageHandler(handler: (message: RemoteMessage) => Promise<void>): void;
  };
}

let registered = false;

function getMessaging(): MessagingModule | null {
  try {
    const mod = require("@react-native-firebase/messaging") as { default?: MessagingModule } & MessagingModule;
    return mod.default ?? mod;
  } catch {
    console.warn("[PushBackground] Firebase messaging unavailable. Background FCM handler disabled.");
    return null;
  }
}

function getNotifee(): { notifee: NotifeeModule; EventType: Record<string, number> } | null {
  try {
    const mod = require("@notifee/react-native") as {
      default?: NotifeeModule;
      EventType?: Record<string, number>;
    } & NotifeeModule;
    return {
      notifee: mod.default ?? mod,
      EventType: mod.EventType ?? {},
    };
  } catch {
    console.warn("[PushBackground] Notifee unavailable. Background notification handler disabled.");
    return null;
  }
}

export function registerBackgroundHandlers(): void {
  requireApprovedAppCapability("notifications", "background notification handlers");
  if (registered) return;
  registered = true;
  if (!isNativeFirebaseConfigured()) {
    console.info("[PushBackground] Firebase is not configured. Background FCM handler disabled.");
    return;
  }

  const messaging = getMessaging();
  const loadedNotifee = getNotifee();

  try {
    if (messaging && loadedNotifee) {
      messaging().setBackgroundMessageHandler(async (message) => {
        await handleBackgroundMessage(message, loadedNotifee.notifee);
      });
    }
  } catch (error) {
    console.warn("[PushBackground] Failed to register Firebase background handler:", error);
  }

  try {
    if (loadedNotifee) {
      loadedNotifee.notifee.onBackgroundEvent(async (event) => {
        await handleBackgroundNotifeeEvent(event, loadedNotifee.notifee, loadedNotifee.EventType);
      });
    }
  } catch (error) {
    console.warn("[PushBackground] Failed to register Notifee background handler:", error);
  }
}

export async function handleBackgroundMessage(
  message: RemoteMessage,
  notifee: Pick<NotifeeModule, "displayNotification" | "cancelNotification">,
): Promise<void> {
  requireApprovedAppCapability("notifications", "background notification message");
  const data = (message.data ?? {}) as PushApprovalDataPayload;
  if (data.kind === "approval-cancel") {
    const cancelKey = data.cancelKey ?? data.approvalId;
    if (cancelKey) await notifee.cancelNotification(cancelKey);
    return;
  }

  if (data.kind !== "approval-prompt" || !data.approvalId) return;

  const category = data.category ?? APPROVAL_CATEGORY_DECIDE;
  const title = data.title ?? message.notification?.title ?? "Approval requested";
  const body = data.body ?? message.notification?.body ?? "";

  await notifee.displayNotification({
    id: data.cancelKey ?? data.approvalId,
    title,
    body,
    data: {
      ...data,
      approvalId: data.approvalId,
      category,
    },
    android: {
      channelId: APPROVAL_NOTIFICATION_CHANNEL_ID,
      pressAction: { id: "open", launchActivity: "default" },
      actions: parseAndroidActions(data.actionsJson, category),
    },
    ios: {
      categoryId: category,
    },
  });
}

export async function handleBackgroundNotifeeEvent(
  event: NotifeeEvent,
  notifee: Pick<NotifeeModule, "displayNotification" | "cancelNotification"> & {
    displayNotification?: (notification: Record<string, unknown>) => Promise<void>;
  },
  EventType: Record<string, number>,
): Promise<void> {
  requireApprovedAppCapability("notifications", "background notification action");
  const notification = event.detail.notification;
  const approvalId = readApprovalId(notification);
  if (!approvalId) return;

  const actionId = event.detail.pressAction?.id;
  if (event.type === EventType["ACTION_PRESS"] && isBackgroundDecision(actionId)) {
    await queueBackgroundAction(approvalId, actionId);
    await updateActionNotification(notifee, approvalId, notification);
    return;
  }

  if (
    (event.type === EventType["ACTION_PRESS"] && actionId === "open") ||
    event.type === EventType["PRESS"]
  ) {
    await enqueueDeepLink(approvalId);
  }
}

function readApprovalId(notification: NotifeeEvent["detail"]["notification"]): string | null {
  const dataApprovalId = notification?.data?.["approvalId"];
  if (typeof dataApprovalId === "string" && dataApprovalId.length > 0) return dataApprovalId;
  return notification?.id ?? null;
}

function parseAndroidActions(actionsJson: string | undefined, category: string): Array<{
  title: string;
  pressAction: { id: string; launchActivity?: string };
}> {
  if (!actionsJson) return getAndroidNotificationActions(category);

  try {
    const actions = JSON.parse(actionsJson) as Array<{ id?: unknown; title?: unknown }>;
    if (!Array.isArray(actions)) return getAndroidNotificationActions(category);
    const parsed = actions
      .filter((action): action is { id: string; title: string } =>
        typeof action.id === "string" && typeof action.title === "string")
      .map((action) => ({
        title: action.title,
        pressAction: {
          id: action.id,
          ...(action.id === "open" ? { launchActivity: "default" } : {}),
        },
      }));
    return parsed.length > 0 ? parsed : getAndroidNotificationActions(category);
  } catch {
    return getAndroidNotificationActions(
      category === APPROVAL_CATEGORY_INPUT_REQUIRED ? APPROVAL_CATEGORY_INPUT_REQUIRED : APPROVAL_CATEGORY_DECIDE,
    );
  }
}
