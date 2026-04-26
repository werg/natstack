/**
 * Push notification service -- FCM/APNs token registration and handling.
 *
 * Provides an abstraction layer for push notifications. Uses
 * @react-native-firebase/messaging when available, but gracefully
 * degrades when the native modules are not installed (common in
 * development builds without Firebase configured).
 *
 * Push tokens are registered with the NatStack server via RPC so
 * the server can send notifications (e.g., agent task completion).
 */

import { Platform, Alert } from "react-native";
import type { ShellClient } from "./shellClient";

/**
 * Get a stable device-scoped client ID for push registration.
 * Persisted in Keychain so the same ID survives app restarts,
 * preventing orphaned registrations on the server.
 */
let cachedDeviceId: string | null = null;

async function getDeviceClientId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  try {
    // Try to load persisted ID from keychain
    const Keychain = await import("react-native-keychain");
    const existing = await Keychain.getGenericPassword({ service: "natstack-push-device-id" });
    if (existing && existing.password) {
      const id = existing.password;
      cachedDeviceId = id;
      return id;
    }
  } catch {
    // Keychain unavailable — fall through to generate
  }

  // Generate a new stable ID
  cachedDeviceId = `device-${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const Keychain = await import("react-native-keychain");
    await Keychain.setGenericPassword("push-device-id", cachedDeviceId, {
      service: "natstack-push-device-id",
      // Device-only: if this ID leaks via backup, an attacker could receive
      // push notifications addressed to the original device (cloned device).
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    // Keychain write failed — ID works for this session but won't persist
  }

  return cachedDeviceId;
}

/**
 * Lazy-loaded Firebase messaging module.
 * Returns null if @react-native-firebase/messaging is not installed.
 */
async function getFirebaseMessaging(): Promise<FirebaseMessagingModule | null> {
  try {
    // Dynamic import -- will throw if the native module is not linked
    const mod = await import("@react-native-firebase/messaging");
    return mod.default ?? mod;
  } catch {
    console.warn(
      "[PushNotifications] @react-native-firebase/messaging not available. " +
      "Push notifications are disabled.",
    );
    return null;
  }
}

/**
 * Minimal interface for the Firebase messaging module.
 * Defined here to avoid requiring the package at compile time.
 */
interface FirebaseMessagingModule {
  (): FirebaseMessagingInstance;
}

interface FirebaseMessagingInstance {
  requestPermission(): Promise<number>;
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
  onMessage(callback: (message: RemoteMessage) => void): () => void;
  onNotificationOpenedApp(callback: (message: RemoteMessage) => void): () => void;
  getInitialNotification(): Promise<RemoteMessage | null>;
  setBackgroundMessageHandler(handler: (message: RemoteMessage) => Promise<void>): void;
}

/** Minimal remote message shape */
export interface RemoteMessage {
  messageId?: string;
  notification?: {
    title?: string;
    body?: string;
  };
  data?: Record<string, string>;
}

/** Callback invoked when a notification is tapped */
export type NotificationTapHandler = (data: Record<string, string>) => void;

/** Active subscription cleanup functions */
let cleanupFunctions: Array<() => void> = [];

/**
 * Register for push notifications.
 *
 * 1. Requests notification permission (iOS specifically requires this)
 * 2. Gets the FCM/APNs device token
 * 3. Registers the token with the NatStack server via RPC
 * 4. Sets up foreground + tap handlers
 *
 * Call this after the ShellClient is connected and authenticated.
 */
export async function registerForPushNotifications(
  shellClient: ShellClient,
  onNotificationTap?: NotificationTapHandler,
): Promise<void> {
  const messagingModule = await getFirebaseMessaging();
  if (!messagingModule) return;

  const messaging = messagingModule();

  // Request permission (iOS requires explicit ask; Android auto-grants)
  const authStatus = await messaging.requestPermission();
  // authStatus: 1 = AUTHORIZED, 2 = PROVISIONAL
  const isAuthorized = authStatus === 1 || authStatus === 2;
  if (!isAuthorized) {
    console.warn("[PushNotifications] Permission denied by user");
    return;
  }

  // Get the device push token
  let token: string;
  try {
    token = await messaging.getToken();
  } catch (error) {
    console.error("[PushNotifications] Failed to get token:", error);
    return;
  }

  // Register the token with the NatStack server.
  // Platform must match server's expected enum: "ios" | "android" | "web".
  // clientId is device-scoped so multiple devices don't overwrite each other.
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const clientId = await getDeviceClientId();
  try {
    await shellClient.transport.call(
      "main",
      "push.register",
      { token, platform, clientId },
    );
    console.log(`[PushNotifications] Token registered (${platform})`);
  } catch (error) {
    console.error("[PushNotifications] Failed to register token with server:", error);
    // Non-fatal -- notifications just won't work
  }

  // Handle foreground messages -- show an in-app alert
  const unsubForeground = messaging.onMessage((message: RemoteMessage) => {
    const title = message.notification?.title ?? "NatStack";
    const body = message.notification?.body ?? "";

    Alert.alert(title, body, [
      { text: "Dismiss", style: "cancel" },
      ...(message.data && onNotificationTap
        ? [{
            text: "View",
            onPress: () => onNotificationTap(message.data!),
          }]
        : []),
    ]);
  });
  cleanupFunctions.push(unsubForeground);

  // Handle notification taps when app is in background (but not killed)
  if (onNotificationTap) {
    const unsubBackgroundTap = messaging.onNotificationOpenedApp(
      (message: RemoteMessage) => {
        if (message.data) {
          onNotificationTap(message.data);
        }
      },
    );
    cleanupFunctions.push(unsubBackgroundTap);

    // Check if the app was opened from a killed state by a notification
    const initialNotification = await messaging.getInitialNotification();
    if (initialNotification?.data) {
      onNotificationTap(initialNotification.data);
    }
  }
}

/**
 * Unregister push notifications.
 *
 * Deletes the device token from Firebase and notifies the server
 * to stop sending push notifications to this device.
 */
export async function unregisterPushNotifications(
  shellClient: ShellClient,
): Promise<void> {
  // Clean up message listeners
  for (const cleanup of cleanupFunctions) {
    cleanup();
  }
  cleanupFunctions = [];

  const messagingModule = await getFirebaseMessaging();
  if (!messagingModule) return;

  const messaging = messagingModule();

  try {
    // Notify server to remove this device's token.
    // Server expects clientId as a positional string argument.
    await shellClient.transport.call("main", "push.unregister", await getDeviceClientId());
  } catch (error) {
    console.error("[PushNotifications] Failed to unregister token from server:", error);
  }

  try {
    await messaging.deleteToken();
    console.log("[PushNotifications] Token deleted");
  } catch (error) {
    console.error("[PushNotifications] Failed to delete token:", error);
  }
}
