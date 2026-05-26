import { describe, expect, it } from "vitest";
import {
  UnitManifestError,
  appUnitManifestDescriptor,
  extensionUnitManifestDescriptor,
  validateUnitManifest,
} from "./unitManifest.js";

describe("validateUnitManifest", () => {
  it("validates extension manifests through the shared unit validator", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        {
          extension: {
            activationEvents: ["*"],
            dependencyMode: "external",
            contributes: { buildTargets: ["react-native"] },
          },
        },
        { unitName: "@workspace-extensions/a" },
      ),
    ).not.toThrow();
  });

  it("rejects unknown extension build-provider targets", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        { extension: { activationEvents: ["*"], contributes: { buildTargets: ["electron"] } } },
        { unitName: "@workspace-extensions/a" },
      ),
    ).toThrow(/contributes.buildTargets/);
  });

  it("rejects extension manifests with foreign kind blocks", () => {
    expect(() =>
      validateUnitManifest(
        extensionUnitManifestDescriptor,
        { extension: { activationEvents: ["*"] }, app: { target: "electron", renderer: "index.tsx" } },
        { unitName: "@workspace-extensions/a" },
      ),
    ).toThrow(UnitManifestError);
  });

  it("validates pure-thin Electron app manifests", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        {
          app: {
            target: "electron",
            renderer: "index.tsx",
            capabilities: ["native-menus", "notifications", "fs-write"],
          },
        },
        { unitName: "@workspace-apps/shell" },
      ),
    ).not.toThrow();
  });

  it("rejects native-process fields in app manifests", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "electron", renderer: "index.tsx", preload: "preload.ts" } },
        { unitName: "@workspace-apps/shell" },
      ),
    ).toThrow(/pure-thin/);
  });

  it("rejects dist as an app manifest target", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "dist", renderer: "index.tsx", distDir: "dist" } },
        { unitName: "@workspace-apps/prebuilt" },
      ),
    ).toThrow(/target must be "electron", "react-native", or "terminal"/);
  });

  it("validates terminal app manifests with connection management", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        {
          app: {
            target: "terminal",
            entry: "index.ts",
            capabilities: ["connection-management"],
          },
        },
        { unitName: "@workspace-apps/remote-cli" },
      ),
    ).not.toThrow();
  });

  it("requires React Native ABI and component name", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "react-native", renderer: "index.tsx", rnComponentName: "NatStack" } },
        { unitName: "@workspace-apps/mobile" },
      ),
    ).toThrow(/requires rnComponentName and rnHostAbi/);
  });

  it("rejects target-unknown capabilities", () => {
    expect(() =>
      validateUnitManifest(
        appUnitManifestDescriptor,
        { app: { target: "react-native", renderer: "index.tsx", capabilities: ["native-menus"] } },
        { unitName: "@workspace-apps/mobile" },
      ),
    ).toThrow(/known react-native capabilities/);
  });
});
