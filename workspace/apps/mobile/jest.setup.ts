jest.mock(
  "@react-native-firebase/messaging",
  () => {
    const messaging = jest.fn(() => ({
      getToken: jest.fn(async () => "test-fcm-token"),
      onTokenRefresh: jest.fn(() => jest.fn()),
      onMessage: jest.fn(() => jest.fn()),
      setBackgroundMessageHandler: jest.fn(),
      requestPermission: jest.fn(async () => 1),
      hasPermission: jest.fn(async () => 1),
    }));
    return messaging;
  },
  { virtual: true }
);

jest.mock(
  "@notifee/react-native",
  () => ({
    __esModule: true,
    default: {
      cancelNotification: jest.fn(async () => undefined),
      createChannel: jest.fn(async () => "approvals"),
      displayNotification: jest.fn(async () => undefined),
      onBackgroundEvent: jest.fn(),
      onForegroundEvent: jest.fn(() => jest.fn()),
      requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
      setNotificationCategories: jest.fn(async () => undefined),
    },
    AndroidImportance: { HIGH: 4 },
    AuthorizationStatus: { AUTHORIZED: 1, PROVISIONAL: 2 },
    EventType: { ACTION_PRESS: 1, PRESS: 2, DISMISSED: 3 },
    IOSNotificationCategoryActionForeground: true,
  }),
  { virtual: true }
);

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => undefined),
    multiRemove: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  }),
  { virtual: true }
);

jest.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" },
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
  setGenericPassword: jest.fn(async () => true),
}));

jest.mock("react-native-haptic-feedback", () => ({
  trigger: jest.fn(),
}));

jest.mock(
  "@react-native-clipboard/clipboard",
  () => ({
    __esModule: true,
    default: {
      setString: jest.fn(),
      getString: jest.fn(async () => ""),
    },
  }),
  { virtual: true },
);

const { NativeModules } = jest.requireActual("react-native");
NativeModules.NatStackMobileHost = {
  clearCredentials: jest.fn(async () => undefined),
  completePairing: jest.fn(async () => ({
    serverUrl: "https://server.example",
    deviceId: "dev_123",
    callerId: "app:apps/mobile:dev_123",
    connectionGrant: "grant_123",
  })),
  getCredentials: jest.fn(async () => null),
  issueConnectionGrant: jest.fn(async () => ({
    deviceId: "dev_123",
    callerId: "app:apps/mobile:dev_123",
    connectionGrant: "grant_123",
  })),
  prepareAppBundle: jest.fn(async () => ({
    appId: "@workspace-apps/mobile",
    buildKey: "rn-key",
    effectiveVersion: "ev-mobile",
    capabilities: ["notifications", "keychain", "clipboard", "open-external", "panel-hosting"],
    rnHostAbi: "rn-host-1",
    integrity: "sha256-mobile",
    platform: "ios",
    url: "https://server.example/_a/rn-key/index.ios.bundle",
    path: "index.ios.bundle",
    localPath: "/cache/natstack-rn/rn-key/index.ios.bundle",
  })),
  activatePreparedAppBundle: jest.fn(async () => ({ activated: false })),
};
