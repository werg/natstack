import { AppState, NativeModules } from "react-native";
import { waitFor } from "@testing-library/react-native";
import {
  displayApprovalNotification,
  registerForPushNotifications,
  reconcilePushNotifications,
} from "./pushNotifications";
import { handleBackgroundMessage, handleBackgroundNotifeeEvent } from "./backgroundHandlers";
import {
  backgroundActionQueueStorageKeys,
  SYNCING_NOTIFICATION_BODY,
} from "./backgroundActionQueue";
import { setApprovedAppCapabilities } from "./appCapabilities";

type RecoveryKind = "resubscribe" | "cold-recover";

type MockShellClient = {
  transport: {
    status: "connected" | "connecting" | "disconnected";
    call: jest.Mock;
    onRecovery: jest.Mock;
  };
  shellApproval: {
    listPending: jest.Mock;
    resolve: jest.Mock;
  };
  push: {
    register: jest.Mock;
    unregister: jest.Mock;
  };
};

const mockStorage = new Map<string, string>();
const mockListeners = {
  tokenRefresh: undefined as ((token: string) => void) | undefined,
  message: undefined as ((message: unknown) => void) | undefined,
  foreground: undefined as ((event: unknown) => void) | undefined,
  recovery: new Map<RecoveryKind, () => void>(),
  appState: undefined as ((state: string) => void) | undefined,
};

const mockMessagingInstance = {
  requestPermission: jest.fn(async () => 1),
  getToken: jest.fn(async () => "token-1"),
  deleteToken: jest.fn(async () => undefined),
  onTokenRefresh: jest.fn((callback: (token: string) => void) => {
    mockListeners.tokenRefresh = callback;
    return jest.fn();
  }),
  onMessage: jest.fn((callback: (message: unknown) => void) => {
    mockListeners.message = callback;
    return jest.fn();
  }),
  onNotificationOpenedApp: jest.fn(() => jest.fn()),
  getInitialNotification: jest.fn(async () => null),
};

const mockMessagingFactory = jest.fn(() => mockMessagingInstance);

const mockNotifee = {
  cancelNotification: jest.fn(async () => undefined),
  displayNotification: jest.fn(async () => undefined),
  getDisplayedNotifications: jest.fn(async () => []),
  onForegroundEvent: jest.fn((callback: (event: unknown) => void) => {
    mockListeners.foreground = callback;
    return jest.fn();
  }),
  requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
};

jest.mock("@react-native-firebase/messaging", () => mockMessagingFactory, { virtual: true });
jest.mock(
  "@notifee/react-native",
  () => ({
    __esModule: true,
    default: mockNotifee,
    EventType: { ACTION_PRESS: 1, PRESS: 2 },
  }),
  { virtual: true }
);
jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  }),
  { virtual: true }
);
jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn(async () => false),
  setGenericPassword: jest.fn(async () => true),
}));

const appStateSpy = jest
  .spyOn(AppState, "addEventListener")
  .mockImplementation((_event, callback) => {
    mockListeners.appState = callback as (state: string) => void;
    return { remove: jest.fn() };
  });

function createShellClient(
  status: MockShellClient["transport"]["status"] = "connected"
): MockShellClient {
  const transport = {
    status,
    call: jest.fn(async (_target: string, method: string) => {
      if (method === "shellApproval.listPending") {
        return [{ approvalId: "approval-1" }];
      }
      return undefined;
    }),
    onRecovery: jest.fn((kind: RecoveryKind, callback: () => void) => {
      mockListeners.recovery.set(kind, callback);
      return jest.fn();
    }),
  };
  return {
    transport,
    shellApproval: {
      listPending: jest.fn(() => transport.call("main", "shellApproval.listPending", [])),
      resolve: jest.fn((approvalId: string, decision: string) =>
        transport.call("main", "shellApproval.resolve", [approvalId, decision])
      ),
    },
    push: {
      register: jest.fn((request: unknown) => transport.call("main", "push.register", [request])),
      unregister: jest.fn((clientId: string) =>
        transport.call("main", "push.unregister", [clientId])
      ),
    },
  };
}

beforeEach(() => {
  setApprovedAppCapabilities(["notifications", "keychain"]);
  (NativeModules.NatStackMobileHost as { firebaseConfigured?: boolean }).firebaseConfigured = true;
  jest.clearAllMocks();
  mockStorage.clear();
  mockListeners.tokenRefresh = undefined;
  mockListeners.message = undefined;
  mockListeners.foreground = undefined;
  mockListeners.recovery.clear();
  mockListeners.appState = undefined;
  mockMessagingInstance.requestPermission.mockResolvedValue(1);
  mockMessagingInstance.getInitialNotification.mockResolvedValue(null);
  mockMessagingInstance.getToken.mockResolvedValue("token-1");
  mockNotifee.getDisplayedNotifications.mockResolvedValue([]);
});

afterAll(() => {
  appStateSpy.mockRestore();
});

describe("pushNotifications", () => {
  it("skips Firebase messaging setup when the native app has no Firebase config", async () => {
    (NativeModules.NatStackMobileHost as { firebaseConfigured?: boolean }).firebaseConfigured =
      false;
    const shellClient = createShellClient();

    const cleanup = await registerForPushNotifications(shellClient as never);

    expect(cleanup).toEqual(expect.any(Function));
    expect(mockMessagingFactory).not.toHaveBeenCalled();
    expect(shellClient.transport.call).not.toHaveBeenCalledWith(
      "main",
      "push.register",
      expect.any(Array)
    );
  });

  it("registers the initial token and refreshed tokens", async () => {
    const shellClient = createShellClient();

    await registerForPushNotifications(shellClient as never);
    mockListeners.tokenRefresh?.("token-2");
    await Promise.resolve();

    expect(shellClient.transport.call).toHaveBeenCalledWith("main", "push.register", [
      expect.objectContaining({
        token: "token-1",
        platform: expect.stringMatching(/^(android|ios)$/),
      }),
    ]);
    expect(shellClient.transport.call).toHaveBeenCalledWith("main", "push.register", [
      expect.objectContaining({
        token: "token-2",
        platform: expect.stringMatching(/^(android|ios)$/),
      }),
    ]);
  });

  it("resolves foreground deny actions immediately and cancels notification", async () => {
    const shellClient = createShellClient();
    await registerForPushNotifications(shellClient as never);

    await mockListeners.foreground?.({
      type: 1,
      detail: {
        notification: { id: "approval-1", data: { approvalId: "approval-1" } },
        pressAction: { id: "deny" },
      },
    });

    expect(shellClient.transport.call).toHaveBeenCalledWith("main", "shellApproval.resolve", [
      "approval-1",
      "deny",
    ]);
    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
  });

  it("queues background-equivalent foreground actions when disconnected without cancelling", async () => {
    const shellClient = createShellClient("disconnected");
    await registerForPushNotifications(shellClient as never);

    await mockListeners.foreground?.({
      type: 1,
      detail: {
        notification: { id: "approval-1", title: "Approval", data: { approvalId: "approval-1" } },
        pressAction: { id: "deny" },
      },
    });

    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("approval-1");
    expect(mockNotifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval-1",
        body: SYNCING_NOTIFICATION_BODY,
      })
    );
    expect(mockStorage.get(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toContain(
      "approval-1"
    );
  });

  it("queues background deny actions without cancelling the notification", async () => {
    const backgroundNotifee = {
      cancelNotification: jest.fn(async () => undefined),
      displayNotification: jest.fn(async () => undefined),
    };

    await handleBackgroundNotifeeEvent(
      {
        type: 1,
        detail: {
          notification: {
            id: "approval-bg",
            title: "Approval",
            data: { approvalId: "approval-bg" },
          },
          pressAction: { id: "deny" },
        },
      },
      backgroundNotifee,
      { ACTION_PRESS: 1, PRESS: 2 }
    );

    expect(backgroundNotifee.cancelNotification).not.toHaveBeenCalled();
    expect(backgroundNotifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval-bg",
        body: SYNCING_NOTIFICATION_BODY,
      })
    );
    expect(mockStorage.get(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toContain(
      "approval-bg"
    );
  });

  it("rejects direct background notification handlers without the notifications capability", async () => {
    setApprovedAppCapabilities(["keychain"]);
    const backgroundNotifee = {
      cancelNotification: jest.fn(async () => undefined),
      displayNotification: jest.fn(async () => undefined),
    };

    await expect(
      handleBackgroundMessage(
        { data: { kind: "approval-cancel", cancelKey: "approval-bg" } },
        backgroundNotifee
      )
    ).rejects.toThrow(
      "background notification message requires approved app capability 'notifications'"
    );
    await expect(
      handleBackgroundNotifeeEvent(
        {
          type: 1,
          detail: {
            notification: { id: "approval-bg", data: { approvalId: "approval-bg" } },
            pressAction: { id: "deny" },
          },
        },
        backgroundNotifee,
        { ACTION_PRESS: 1, PRESS: 2 }
      )
    ).rejects.toThrow(
      "background notification action requires approved app capability 'notifications'"
    );

    expect(backgroundNotifee.cancelNotification).not.toHaveBeenCalled();
    expect(backgroundNotifee.displayNotification).not.toHaveBeenCalled();
  });

  it("rejects direct foreground notification display without the notifications capability", async () => {
    setApprovedAppCapabilities(["keychain"]);

    await expect(
      displayApprovalNotification(
        { data: { kind: "approval-prompt", approvalId: "approval-1" } },
        mockNotifee
      )
    ).rejects.toThrow(
      "approval notification display requires approved app capability 'notifications'"
    );
    expect(mockNotifee.displayNotification).not.toHaveBeenCalled();
  });

  it.each<RecoveryKind>(["resubscribe", "cold-recover"])(
    "drains queued actions on %s recovery with resolve then cancel",
    async (kind) => {
      mockStorage.set(
        backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY,
        JSON.stringify({
          version: 1,
          actions: [{ approvalId: "approval-1", decision: "session", queuedAt: Date.now() }],
        })
      );
      const shellClient = createShellClient();
      await registerForPushNotifications(shellClient as never);

      // Both recovery kinds must be wired -- onReconnect only covers
      // "resubscribe", but a server reboot recovers via "cold-recover".
      expect(mockListeners.recovery.has(kind)).toBe(true);
      mockListeners.recovery.get(kind)?.();

      await waitFor(() =>
        expect(shellClient.transport.call).toHaveBeenCalledWith("main", "shellApproval.resolve", [
          "approval-1",
          "session",
        ])
      );
      expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
      expect(mockStorage.has(backgroundActionQueueStorageKeys.ACTION_QUEUE_KEY)).toBe(false);
    }
  );

  it("handles silent cancel data messages", async () => {
    const shellClient = createShellClient();
    await registerForPushNotifications(shellClient as never);

    mockListeners.message?.({
      data: {
        kind: "approval-cancel",
        cancelKey: "approval-1",
      },
    });
    await Promise.resolve();

    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("approval-1");
  });

  it("reconciles stale displayed notifications", async () => {
    const shellClient = createShellClient();
    mockNotifee.getDisplayedNotifications.mockResolvedValue([
      { notification: { id: "approval-1" } },
      { notification: { id: "stale-approval" } },
    ] as never);

    await reconcilePushNotifications(shellClient as never, mockNotifee);

    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("stale-approval");
    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("approval-1");
  });

  it("keeps a still-pending notification displayed under a distinct cancelKey", async () => {
    const shellClient = createShellClient();
    // Displayed under cancelKey, but the pending approvalId lives in data.
    // Reconcile must match on the carried approvalId, not the display id.
    mockNotifee.getDisplayedNotifications.mockResolvedValue([
      { notification: { id: "cancel-key-1", data: { approvalId: "approval-1" } } },
      { notification: { id: "cancel-key-2", data: { approvalId: "stale-approval" } } },
    ] as never);

    await reconcilePushNotifications(shellClient as never, mockNotifee);

    // approval-1 is pending -> its notification (display id cancel-key-1) stays.
    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("cancel-key-1");
    // stale-approval is not pending -> cancelled by its actual display id.
    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("cancel-key-2");
  });

  it("does not preserve startup privileged-unit approval notifications in the runtime queue", async () => {
    const shellClient = createShellClient();
    shellClient.shellApproval.listPending.mockResolvedValueOnce([
      {
        kind: "unit-batch",
        approvalId: "startup-units",
        callerId: "system",
        callerKind: "system",
        repoPath: "meta",
        effectiveVersion: "ev-startup",
        requestedAt: 1,
        trigger: "startup",
        title: "Approve workspace units",
        description: "Approve privileged units before launch.",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "Mobile",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "meta", ref: "main" },
            capabilities: [],
          },
          {
            unitKind: "extension",
            unitName: "@workspace-extensions/native",
            displayName: "Native Extension",
            target: null,
            source: { kind: "workspace-repo", repo: "meta", ref: "main" },
            capabilities: ["native-code"],
          },
        ],
      },
      { approvalId: "runtime-approval" },
    ]);
    mockNotifee.getDisplayedNotifications.mockResolvedValue([
      { notification: { id: "startup-display", data: { approvalId: "startup-units" } } },
      { notification: { id: "runtime-display", data: { approvalId: "runtime-approval" } } },
    ] as never);

    await reconcilePushNotifications(shellClient as never, mockNotifee);

    expect(mockNotifee.cancelNotification).toHaveBeenCalledWith("startup-display");
    expect(mockNotifee.cancelNotification).not.toHaveBeenCalledWith("runtime-display");
  });
});
