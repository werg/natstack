import {
  APPROVAL_CATEGORY_DECIDE,
  APPROVAL_CATEGORY_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_INPUT_REQUIRED,
  NOTIFICATION_ACTION_IDS_STANDARD,
} from "@natstack/shared/approvalContract";
import { Platform } from "react-native";
import { requireApprovedAppCapability } from "./appCapabilities";
import { isNativeFirebaseConfigured } from "./nativeFirebase";

declare const require: (moduleName: string) => unknown;

export const APPROVAL_NOTIFICATION_CHANNEL_ID = "approvals";

export type NotificationActionId =
  | (typeof NOTIFICATION_ACTION_IDS_STANDARD)[number]
  | (typeof NOTIFICATION_ACTION_IDS_INPUT_REQUIRED)[number];

export interface NotificationActionDefinition {
  id: NotificationActionId;
  title: string;
  foreground?: boolean;
  destructive?: boolean;
}

interface NotifeeModule {
  createChannel?: (channel: {
    id: string;
    name: string;
    importance?: number;
  }) => Promise<string>;
  setNotificationCategories?: (categories: Array<{
    id: string;
    actions: Array<{
      id: string;
      title: string;
      foreground?: boolean;
      destructive?: boolean;
      ios?: {
        foreground?: boolean;
        destructive?: boolean;
      };
    }>;
  }>) => Promise<void>;
  requestPermission?: () => Promise<unknown>;
}

function getNotifee(): { notifee: NotifeeModule; AndroidImportance?: { HIGH?: number } } | null {
  try {
    const mod = require("@notifee/react-native") as {
      default?: NotifeeModule;
      AndroidImportance?: { HIGH?: number };
    } & NotifeeModule;
    return {
      notifee: mod.default ?? mod,
      AndroidImportance: mod.AndroidImportance,
    };
  } catch {
    console.warn("[Notifications] @notifee/react-native not available. Notification categories disabled.");
    return null;
  }
}

const ACTION_COPY: Record<NotificationActionId, string> = {
  once: "Once",
  session: "Session",
  deny: "Deny",
  open: "Open",
  version: "Trust Version",
};

export function getNotificationActionDefinitions(
  category: string | undefined,
): NotificationActionDefinition[] {
  const ids = category === APPROVAL_CATEGORY_INPUT_REQUIRED
    ? NOTIFICATION_ACTION_IDS_INPUT_REQUIRED
    : NOTIFICATION_ACTION_IDS_STANDARD;

  return ids.map((id) => ({
    id,
    title: ACTION_COPY[id],
    foreground: id === "open",
    destructive: id === "deny",
  }));
}

export function getAndroidNotificationActions(category: string | undefined): Array<{
  title: string;
  pressAction: { id: string; launchActivity?: string };
}> {
  return getNotificationActionDefinitions(category).map((action) => ({
    title: action.title,
    pressAction: {
      id: action.id,
      ...(action.id === "open" ? { launchActivity: "default" } : {}),
    },
  }));
}

export async function setupNotificationCategories(): Promise<void> {
  requireApprovedAppCapability("notifications", "notification categories");
  if (!isNativeFirebaseConfigured()) {
    console.info("[Notifications] Firebase is not configured. Notification categories disabled.");
    return;
  }
  const loaded = getNotifee();
  if (!loaded) return;

  const { notifee, AndroidImportance } = loaded;

  try {
    await notifee.requestPermission?.();
  } catch (error) {
    console.warn("[Notifications] Failed to request Notifee permission:", error);
  }

  if (Platform.OS === "android") {
    try {
      await notifee.createChannel?.({
        id: APPROVAL_NOTIFICATION_CHANNEL_ID,
        name: "Approvals",
        importance: AndroidImportance?.HIGH,
      });
    } catch (error) {
      console.warn("[Notifications] Failed to create approval channel:", error);
    }
  }

  try {
    await notifee.setNotificationCategories?.([
      {
        id: APPROVAL_CATEGORY_DECIDE,
        actions: getNotificationActionDefinitions(APPROVAL_CATEGORY_DECIDE).map((action) => ({
          id: action.id,
          title: action.title,
          foreground: action.foreground,
          destructive: action.destructive,
          ios: {
            foreground: action.foreground,
            destructive: action.destructive,
          },
        })),
      },
      {
        id: APPROVAL_CATEGORY_INPUT_REQUIRED,
        actions: getNotificationActionDefinitions(APPROVAL_CATEGORY_INPUT_REQUIRED).map((action) => ({
          id: action.id,
          title: action.title,
          foreground: action.foreground,
          ios: {
            foreground: action.foreground,
          },
        })),
      },
    ]);
  } catch (error) {
    console.warn("[Notifications] Failed to set notification categories:", error);
  }
}
