import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createNativeBoundary } = require("../../apps/mobile/metroNativeBoundary.cjs") as {
  createNativeBoundary(workspaceAppRoot: string): {
    guardNativeModuleImport(moduleName: string, originModulePath?: string): void;
  };
};

describe("mobile Metro native capability boundary", () => {
  const workspaceAppRoot = path.resolve("workspace/apps/mobile");
  const boundary = createNativeBoundary(workspaceAppRoot);

  it("rejects direct native module imports from arbitrary workspace app files", () => {
    expect(() =>
      boundary.guardNativeModuleImport(
        "@notifee/react-native",
        path.join(workspaceAppRoot, "src/components/PanelDrawer.tsx")
      )
    ).toThrow(/Direct import of native module/);
    expect(() =>
      boundary.guardNativeModuleImport(
        "react-native-keychain",
        path.join(workspaceAppRoot, "App.tsx")
      )
    ).toThrow(/capability-gated service wrapper/);
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-clipboard/clipboard",
        path.join(workspaceAppRoot, "src/components/MainScreen.tsx")
      )
    ).toThrow(/capability-gated service wrapper/);
  });

  it("permits the small host-owned wrapper files that perform capability checks", () => {
    expect(() =>
      boundary.guardNativeModuleImport(
        "@notifee/react-native",
        path.join(workspaceAppRoot, "src/services/pushNotifications.ts")
      )
    ).not.toThrow();
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-async-storage/async-storage",
        path.join(workspaceAppRoot, "src/services/connectLinkReplayGuard.ts")
      )
    ).not.toThrow();
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-async-storage/async-storage",
        path.join(workspaceAppRoot, "src/shellCore/localViewState.ts")
      )
    ).not.toThrow();
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-clipboard/clipboard",
        path.join(workspaceAppRoot, "src/services/nativeCapabilities.ts")
      )
    ).not.toThrow();
  });

  it("permits the shipped native host bootstrap to persist connect-link replay state", () => {
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-async-storage/async-storage",
        path.resolve("apps/mobile/index.js")
      )
    ).not.toThrow();
  });

  it("permits the shared WebRTC transport package to persist the shell credential", () => {
    expect(() =>
      boundary.guardNativeModuleImport(
        "@react-native-async-storage/async-storage",
        path.resolve("packages/mobile-webrtc/src/connect.ts")
      )
    ).not.toThrow();
  });

  it("does not affect normal JavaScript package resolution", () => {
    expect(() =>
      boundary.guardNativeModuleImport("@natstack/shared", path.join(workspaceAppRoot, "App.tsx"))
    ).not.toThrow();
  });

  it("keeps the shipped mobile entrypoint host-only", () => {
    const entrypoint = fs.readFileSync(path.resolve("apps/mobile/index.js"), "utf-8");

    expect(entrypoint).toContain("NatStackMobileHost");
    expect(entrypoint).toContain("prepareAppBundle");
    expect(entrypoint).not.toContain("workspace/apps/mobile");
    expect(entrypoint).not.toContain("../../workspace/apps");
  });
});
