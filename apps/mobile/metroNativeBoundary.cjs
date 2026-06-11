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
