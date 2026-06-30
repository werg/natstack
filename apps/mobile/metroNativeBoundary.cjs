const path = require("path");

const BLOCKED_NATIVE_IMPORTS = {
  "react-native-keychain": [
    "src/services/pushNotifications.ts",
  ],
  "@react-native-clipboard/clipboard": [
    "src/services/nativeCapabilities.ts",
  ],
  "@react-native-firebase/messaging": [
    "src/services/backgroundHandlers.ts",
    "src/services/pushNotifications.ts",
  ],
  "@notifee/react-native": [
    "src/services/backgroundHandlers.ts",
    "src/services/notificationCategories.ts",
    "src/services/pushNotifications.ts",
  ],
  "@react-native-async-storage/async-storage": [
    "src/services/backgroundActionQueue.ts",
    "src/services/connectLinkReplayGuard.ts",
    "src/services/pushNotifications.ts",
    "src/shellCore/localViewState.ts",
  ],
  // The shared WebRTC shell-connection capability (provider + reconnect + the
  // device's shell-reconnect credential, which it persists via AsyncStorage). The
  // credential helpers are an INDIRECT path to that storage, so gate the package's
  // consumers too — not just the direct AsyncStorage import inside it — to the
  // trusted shell chrome. (apps/mobile/index.js, the out-of-tree native host
  // bootstrap, is allowlisted by absolute path in createNativeBoundary.)
  "@natstack/mobile-webrtc": [
    "src/services/mobileTransport.ts",
    "src/components/LoginScreen.tsx",
  ],
};

function normalize(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/");
}

function blockedImportFor(moduleName) {
  for (const blocked of Object.keys(BLOCKED_NATIVE_IMPORTS)) {
    if (moduleName === blocked || moduleName.startsWith(`${blocked}/`)) {
      return blocked;
    }
  }
  return null;
}

function createNativeBoundary(workspaceAppRoot) {
  const allowedByModule = new Map(
    Object.entries(BLOCKED_NATIVE_IMPORTS).map(([moduleName, relativePaths]) => [
      moduleName,
      new Set(relativePaths.map((relativePath) => normalize(path.join(workspaceAppRoot, relativePath)))),
    ]),
  );
  // Trusted PLATFORM code that persists the device's WebRTC shell-reconnect
  // credential directly (not userland workspace surface, so not capability-gated):
  // the native host bootstrap (apps/mobile/index.js) and the shared WebRTC
  // transport package (@natstack/mobile-webrtc). Both live OUTSIDE
  // workspaceAppRoot and bundle through this Metro, so they are exempted by
  // absolute path rather than the workspaceAppRoot-relative allowlist above.
  const mobileWebRtcConnect = normalize(
    path.join(__dirname, "..", "..", "packages", "mobile-webrtc", "src", "connect.ts"),
  );
  const keychainAllowed = allowedByModule.get("react-native-keychain");
  keychainAllowed?.add(mobileWebRtcConnect);
  const asyncStorageAllowed = allowedByModule.get(
    "@react-native-async-storage/async-storage",
  );
  asyncStorageAllowed?.add(normalize(path.join(__dirname, "index.js")));
  asyncStorageAllowed?.add(mobileWebRtcConnect);
  // The native host bootstrap (apps/mobile/index.js) is the out-of-tree trusted
  // consumer of the @natstack/mobile-webrtc capability; allowlist it by absolute
  // path alongside the workspace-app-relative shell consumers above.
  allowedByModule
    .get("@natstack/mobile-webrtc")
    ?.add(normalize(path.join(__dirname, "index.js")));

  return {
    guardNativeModuleImport(moduleName, originModulePath) {
      const blocked = blockedImportFor(moduleName);
      if (!blocked) return;
      const origin = originModulePath ? normalize(originModulePath) : "";
      if (allowedByModule.get(blocked)?.has(origin)) return;
      throw new Error(
        `Direct import of native module "${moduleName}" from workspace app code is blocked. ` +
          "Use the NatStack capability-gated service wrapper for this native surface.",
      );
    },
  };
}

module.exports = {
  BLOCKED_NATIVE_IMPORTS,
  createNativeBoundary,
};
