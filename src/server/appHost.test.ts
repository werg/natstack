import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { execGitFileSync } from "@natstack/shared/gitRuntime";
import { writeProductSeedSourceRecord } from "@natstack/shared/productSeedTrust";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import { AppHost } from "./appHost.js";

const roots: string[] = [];
const originalAppDevStatus = process.env["NATSTACK_APP_DEV_STATUS"];
const REACT_NATIVE_PROVIDER = {
  name: "@workspace-extensions/react-native",
  activeEv: "ev-provider",
  activeBuildKey: "provider-build",
  contractVersion: "natstack-build-provider-v1",
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalAppDevStatus === undefined) delete process.env["NATSTACK_APP_DEV_STATUS"];
  else process.env["NATSTACK_APP_DEV_STATUS"] = originalAppDevStatus;
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-app-host-"));
  roots.push(root);
  return root;
}

function makeHarness(
  opts: {
    seeded?: boolean;
    invalidManifest?: boolean;
    approvalDecision?: "once" | "session" | "version" | "repo" | "deny";
  } = {}
) {
  const root = tempRoot();
  const workspacePath = path.join(root, "source");
  const appPath = path.join(workspacePath, "apps", "shell");
  fs.mkdirSync(path.join(workspacePath, "meta"), { recursive: true });
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({
      name: "@workspace-apps/shell",
      version: "1.0.0",
      natstack: {
        displayName: "Shell App",
        app: {
          target: "electron",
          renderer: "index.tsx",
          capabilities: ["notifications"],
          ...(opts.invalidManifest ? { preload: "preload.ts" } : {}),
        },
      },
    })
  );
  fs.writeFileSync(path.join(appPath, "index.tsx"), "export default null;\n");
  if (opts.seeded) {
    writeProductSeedSourceRecord({
      unitDir: appPath,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });
  }
  const artifact = {
    path: "index.html",
    role: "html",
    contentType: "text/html; charset=utf-8",
    encoding: "utf8",
    content: "<!doctype html><div>app</div>",
  } as const;
  const graphNode = {
    name: "@workspace-apps/shell",
    kind: "app",
    relativePath: "apps/shell",
    path: appPath,
    internalDeps: [],
    manifest: {
      displayName: "Shell App",
      app: { target: "electron" as const, capabilities: ["notifications" as const] },
    },
  };
  const providerChangeCallbacks: Array<
    (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      };
    }) => void
  > = [];
  const buildSystem = {
    getBuild: vi.fn(async () => ({
      dir: path.join(root, "state", "builds", "app-key"),
      metadata: {
        ev: "ev-app",
        details: { kind: "app", target: "electron", integrity: "sha256-app" },
      },
      artifacts: [artifact],
    })),
    getBuildByKey: vi.fn((key: string) =>
      key === "app-key"
        ? {
            dir: path.join(root, "state", "builds", "app-key"),
            metadata: {
              ev: "ev-app",
              details: { kind: "app", target: "electron", integrity: "sha256-app" },
            },
            artifacts: [artifact],
          }
        : null
    ),
    getEffectiveVersion: vi.fn((name: string) =>
      name === "@workspace-apps/shell" ? "ev-app" : null
    ),
    getExternalDeps: vi.fn(() => ({})),
    getBuildProviderDetails: vi.fn(
      () =>
        null as {
          name: string;
          activeEv: string | null;
          activeBuildKey: string | null;
          contractVersion: string;
        } | null
    ),
    onBuildProviderChange: vi.fn(
      (
        callback: (event: {
          type: "registered" | "unregistered";
          target: "react-native";
          provider: {
            name: string;
            activeEv: string | null;
            activeBuildKey: string | null;
            contractVersion: string;
          };
        }) => void
      ) => {
        providerChangeCallbacks.push(callback);
        return () => {
          const index = providerChangeCallbacks.indexOf(callback);
          if (index >= 0) providerChangeCallbacks.splice(index, 1);
        };
      }
    ),
    getGraph: vi.fn(() => ({
      allNodes: () => [graphNode],
    })),
    onPushBuild: vi.fn(),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const approvalQueue = { request: vi.fn(async () => opts.approvalDecision ?? ("once" as const)) };
  const notificationService = { show: vi.fn(() => "notification-id") };
  const entityCache = new EntityCache();
  const host = new AppHost({
    statePath: path.join(root, "state"),
    workspacePath,
    workspaceId: "ws",
    buildSystem,
    eventService: eventService as never,
    approvalQueue,
    notificationService,
    entityCache,
    getGatewayUrl: () => "http://127.0.0.1:1234",
  });
  return {
    host,
    buildSystem,
    eventService,
    approvalQueue,
    notificationService,
    graphNode,
    appPath,
    entityCache,
    providerChangeCallbacks,
  };
}

function initRepo(repoPath: string): void {
  execGitFileSync(["init", "-b", "main"], { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] });
  execGitFileSync(["add", "-A"], { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] });
  execGitFileSync(
    ["-c", "user.name=NatStack", "-c", "user.email=natstack@local", "commit", "-m", "Initial app"],
    { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] }
  );
}

function panelCaller(callerId = "panel-1") {
  return createVerifiedCaller(callerId, "panel", {
    callerId,
    callerKind: "panel",
    repoPath: "panels/test",
    effectiveVersion: "ev-panel",
  });
}

function installApp(host: AppHost, graphNode: ReturnType<typeof makeHarness>["graphNode"]): void {
  host.registry.upsert({
    unitKind: "app",
    name: graphNode.name,
    version: "1.0.0",
    target: "electron",
    capabilities: ["notifications"],
    source: { kind: "internal-git", repo: graphNode.relativePath, ref: "main" },
    installedAt: Date.now(),
    activeEv: "ev-app",
    activeSha: "abc123",
    activeBundleKey: "app-key",
    activeDependencyEvs: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    enabled: true,
    status: "running",
    lastError: null,
    previousVersions: [],
  });
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0) as Buffer<ArrayBufferLike>,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk?: string | Buffer) {
      this.body = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === "string" ? chunk : "");
    },
  };
}

describe("AppHost", () => {
  it("approves, builds, registers, and emits available Electron apps", async () => {
    const { host, buildSystem, eventService, approvalQueue, entityCache } = makeHarness();

    await host.reconcileDeclared([
      { source: "apps/shell", target: "electron", ref: "main", enabled: true, autostart: true },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "system:apps",
        title: "Approve workspace apps",
        units: [expect.objectContaining({ unitKind: "app", unitName: "@workspace-apps/shell" })],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      target: "electron",
      activeBundleKey: "app-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        target: "electron",
        url: "http://127.0.0.1:1234/_a/app-key/index.html",
        capabilities: ["notifications"],
      })
    );
    expect(entityCache.resolveActive("@workspace-apps/shell")).toMatchObject({
      id: "@workspace-apps/shell",
      kind: "app",
      source: { repoPath: "apps/shell", effectiveVersion: "ev-app" },
      status: "active",
    });
  });

  it("surfaces push rebuild failures and keeps the previous app build active", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode } = makeHarness();
    installApp(host, graphNode);
    buildSystem.getBuild.mockRejectedValueOnce(new Error("broken app code"));

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "error",
      lastError: "broken app code",
      lastErrorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
      activeBundleKey: "app-key",
      activeEv: "ev-app",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "error",
        error: "broken app code",
        errorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
        buildKey: "app-key",
        canRollback: false,
      })
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "update-error",
        appId: "@workspace-apps/shell",
        error: "broken app code",
        errorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "App update failed",
      })
    );
  });

  it("records app version history and can roll back to the previous build", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode } = makeHarness();
    installApp(host, graphNode);
    const buildByKey = new Map([
      [
        "app-key",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key"),
          metadata: {
            ev: "ev-app",
            details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app" },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>old</div>",
            },
          ],
        },
      ],
      [
        "app-key-2",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
          metadata: {
            ev: "ev-app-2",
            details: {
              kind: "app" as const,
              target: "electron" as const,
              integrity: "sha256-app-2",
            },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>new</div>",
            },
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      (key: string) => (buildByKey.get(key) ?? null) as never
    );
    buildSystem.getBuild.mockResolvedValueOnce(buildByKey.get("app-key-2")! as never);

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key-2",
      activeEv: "ev-app-2",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key", activeEv: "ev-app" }),
      ],
    });
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Desktop app update available",
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "app.applyUpdate",
            command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
          }),
          expect.objectContaining({
            id: "app.rollback",
            command: { type: "app.rollback", appId: "@workspace-apps/shell" },
          }),
        ]),
      })
    );
    const res = createMockResponse();
    host.handleAppArtifactRequest(
      { method: "GET" } as never,
      res as never,
      "app-key",
      "index.html"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toContain("old");

    host.rollbackAppVersion("@workspace-apps/shell");

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key",
      activeEv: "ev-app",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key-2", activeEv: "ev-app-2" }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "rolled-back",
        appId: "@workspace-apps/shell",
        buildKey: "app-key",
        canRollback: true,
      })
    );
  });

  it("emits a development app status diagnostic for dirty app source", async () => {
    process.env["NATSTACK_APP_DEV_STATUS"] = "1";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const { host, notificationService, appPath } = makeHarness();
    initRepo(appPath);
    fs.appendFileSync(path.join(appPath, "index.tsx"), "export const dirty = true;\n");

    try {
      await host.reconcileDeclared([
        { source: "apps/shell", target: "electron", ref: "main", enabled: true, autostart: true },
      ]);
      await host.whenSettled();

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("@workspace-apps/shell"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ev=ev-app"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("build=app-key"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("dirty=1"));
      expect(notificationService.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Workspace app source has uncommitted changes",
          message: expect.stringContaining("index.tsx"),
        })
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("bakes only the active approved app build for dist packaging", () => {
    const { host, graphNode } = makeHarness();
    installApp(host, graphNode);
    const outDir = path.join(tempRoot(), "dist", "baked-app");

    const manifest = host.bakeDist("apps/shell", outDir);

    expect(manifest).toMatchObject({
      app: {
        name: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
      },
      build: {
        key: "app-key",
        effectiveVersion: "ev-app",
        target: "electron",
        integrity: "sha256-app",
      },
    });
    expect(fs.existsSync(path.join(outDir, "manifest.json"))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "artifacts", "index.html"), "utf8")).toBe(
      "<!doctype html><div>app</div>"
    );
  });

  it("registers device-scoped React Native app principals for native-held grants", async () => {
    const { host, graphNode, entityCache } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "mobile-key",
      capabilities: ["notifications"],
    });

    const callerId = host.registerReactNativeAppPrincipal("device-1");

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      id: "app:apps/mobile:device-1",
      kind: "app",
      source: { repoPath: "apps/mobile", effectiveVersion: "ev-mobile" },
      status: "active",
    });

    expect(host.retireReactNativeAppPrincipal("device-1")).toBe(1);
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toBeNull();
  });

  it("registers mobile app grants for the same canonical source used by bootstrap", async () => {
    const { host, graphNode, entityCache } = makeHarness();
    installApp(host, graphNode);
    const base = host.registry.get(graphNode.name);
    if (!base) throw new Error("expected test app registry entry");
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/other-mobile", ref: "main" },
      activeEv: "ev-other-mobile",
      activeBundleKey: "other-mobile-key",
      capabilities: ["notifications"],
    });
    host.registry.upsert({
      ...base,
      name: "@workspace-apps/mobile",
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "mobile-key",
      capabilities: ["notifications"],
    });

    const callerId = host.registerReactNativeAppPrincipal("device-1");

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      source: { repoPath: "apps/mobile", effectiveVersion: "ev-mobile" },
    });
    expect(entityCache.resolveActive("app:apps/other-mobile:device-1")).toBeNull();
  });

  it("authorizes app capabilities by installed app and device-scoped principals", () => {
    const { host, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      capabilities: ["connection-management"],
      source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
    });
    const authorizer = host.capabilityAuthorizer();

    expect(
      authorizer.check(
        createVerifiedCaller("@workspace-apps/shell", "app"),
        "connection-management"
      )
    ).toEqual({ allowed: true });
    expect(
      authorizer.check(
        createVerifiedCaller("app:apps/shell:device-1", "app"),
        "connection-management"
      )
    ).toEqual({ allowed: true });
    expect(
      authorizer.check(createVerifiedCaller("@workspace-apps/shell", "app"), "panel-hosting")
    ).toMatchObject({ allowed: false });
    expect(() =>
      authorizer.require(createVerifiedCaller("@workspace-apps/shell", "app"), "panel-hosting")
    ).toThrow(/does not have capability 'panel-hosting'/);
  });

  it("activates terminal apps as artifact-only app builds", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    fs.writeFileSync(
      path.join(graphNode.path, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/shell",
        version: "1.0.0",
        natstack: {
          displayName: "Remote CLI",
          app: {
            target: "terminal",
            entry: "index.ts",
            capabilities: ["connection-management"],
          },
        },
      })
    );
    graphNode.manifest = {
      displayName: "Remote CLI",
      app: { target: "terminal", capabilities: ["connection-management"] },
    } as never;
    const terminalBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key"),
      metadata: {
        ev: "ev-terminal",
        details: {
          kind: "app",
          target: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
      },
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf8",
          content: "export {};\n",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(terminalBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "terminal-key" ? (terminalBuild as never) : null
    );

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        target: "terminal",
        ref: "main",
        enabled: true,
        autostart: false,
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "terminal",
      activeBundleKey: "terminal-key",
      capabilities: ["connection-management"],
      status: "available",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        target: "terminal",
        launchMode: "artifact-only",
        url: "http://127.0.0.1:1234/_a/terminal-key/index.mjs",
      })
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "available",
        error: null,
      })
    );
  });

  it("trusts exact product-seeded app source without an approval prompt", async () => {
    const { host, buildSystem, eventService, approvalQueue } = makeHarness({ seeded: true });

    await host.reconcileDeclared([
      { source: "apps/shell", target: "electron", ref: "main", enabled: true, autostart: true },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      activeBundleKey: "app-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
      })
    );
  });

  it("re-gates React Native apps when the active build provider changes", async () => {
    const { host, buildSystem, eventService, approvalQueue, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "ev-provider-old:provider-build-old:natstack-build-provider-v1",
      },
    });
    const provider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-new",
      activeBuildKey: "provider-build-new",
      contractVersion: "natstack-build-provider-v1",
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key"),
      metadata: {
        ev: "ev-app",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-1",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-app-key" ? (rnBuild as never) : null
    );

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        target: "react-native",
        ref: "main",
        enabled: true,
        autostart: true,
      },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [
          expect.objectContaining({
            unitKind: "app",
            target: "react-native",
            provider,
            externalDeps: expect.objectContaining({
              "build-provider:@workspace-extensions/react-native":
                "ev-provider-new:provider-build-new:natstack-build-provider-v1",
            }),
          }),
        ],
      })
    );
    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "react-native",
      activeBundleKey: "rn-app-key",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "ev-provider-new:provider-build-new:natstack-build-provider-v1",
      },
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        target: "react-native",
        url: expect.stringContaining("/_a/rn-app-key/index.android.bundle"),
        integrity: "sha256-rn-app",
        rnHostAbi: "rn-host-1",
        provider,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "index.android.bundle",
            role: "primary",
            platform: "android",
            integrity: "sha256-android",
            url: expect.stringContaining("/_a/rn-app-key/index.android.bundle"),
          }),
          expect.objectContaining({
            path: "index.ios.bundle",
            role: "primary",
            platform: "ios",
            integrity: "sha256-ios",
            url: expect.stringContaining("/_a/rn-app-key/index.ios.bundle"),
          }),
        ]),
      })
    );
    expect(host.getReactNativeBootstrap(graphNode.relativePath)).toMatchObject({
      appId: "@workspace-apps/shell",
      buildKey: "rn-app-key",
      capabilities: ["notifications"],
      rnHostAbi: "rn-host-1",
      integrity: "sha256-rn-app",
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: "sha256-android",
          url: expect.stringContaining("/_a/rn-app-key/index.android.bundle"),
        }),
        expect.objectContaining({
          path: "index.ios.bundle",
          platform: "ios",
          integrity: "sha256-ios",
          url: expect.stringContaining("/_a/rn-app-key/index.ios.bundle"),
        }),
      ]),
      provider,
    });
  });

  it("reconciles declared React Native apps when a build provider is registered", async () => {
    const { host, buildSystem, approvalQueue, graphNode, providerChangeCallbacks } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "ev-provider-old:provider-build-old:natstack-build-provider-v1",
      },
    });
    const oldProvider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-old",
      activeBuildKey: "provider-build-old",
      contractVersion: "natstack-build-provider-v1",
    };
    const newProvider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-new",
      activeBuildKey: "provider-build-new",
      contractVersion: "natstack-build-provider-v1",
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(oldProvider);
    const declaration = {
      source: graphNode.relativePath,
      target: "react-native" as const,
      ref: "main",
      enabled: true,
      autostart: true,
    };

    await host.reconcileDeclared([declaration]);
    await host.whenSettled();
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalQueue.request.mockClear();
    buildSystem.getBuildProviderDetails.mockReturnValue(newProvider);
    const providerChangeBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-provider-change-key"
      ),
      metadata: {
        ev: "ev-app",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-1",
          provider: newProvider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(providerChangeBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-provider-change-key" ? (providerChangeBuild as never) : null
    );

    providerChangeCallbacks[0]?.({
      type: "registered",
      target: "react-native",
      provider: newProvider,
    });
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        units: [
          expect.objectContaining({
            provider: newProvider,
            externalDeps: expect.objectContaining({
              "build-provider:@workspace-extensions/react-native":
                "ev-provider-new:provider-build-new:natstack-build-provider-v1",
            }),
          }),
        ],
      })
    );
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBe("rn-provider-change-key");
  });

  it("does not produce React Native bootstrap for platformless primary artifacts", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-platformless-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-platformless-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-platformless-key"
            ),
            metadata: {
              ev: "ev-mobile",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-1",
                provider: REACT_NATIVE_PROVIDER,
              },
            },
            artifacts: [
              {
                path: "index.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                content: "bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.getReactNativeBootstrap("apps/mobile")).toBeNull();
  });

  it("produces React Native bootstrap for platform-specific mobile builds", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-android-only-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-android-only-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-android-only-key"
            ),
            metadata: {
              ev: "ev-mobile",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-1",
                provider: REACT_NATIVE_PROVIDER,
              },
            },
            artifacts: [
              {
                path: "index.android.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "android",
                integrity: "sha256-android",
                content: "bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.getReactNativeBootstrap("apps/mobile")).toMatchObject({
      buildKey: "rn-android-only-key",
      artifacts: [
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: "sha256-android",
        }),
      ],
    });
  });

  it("does not produce React Native bootstrap without provider identity", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "internal-git", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-no-provider-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-no-provider-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-no-provider-key"
            ),
            metadata: {
              ev: "ev-mobile",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-1",
                provider: null,
              },
            },
            artifacts: [
              {
                path: "index.android.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "android",
                integrity: "sha256-android",
                content: "android bundle",
              },
              {
                path: "index.ios.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "ios",
                integrity: "sha256-ios",
                content: "ios bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.getReactNativeBootstrap("apps/mobile")).toBeNull();
  });

  it("fails closed before activating React Native builds without provider identity", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-no-provider-key"
      ),
      metadata: {
        ev: "ev-app",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-1",
          provider: null,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        target: "react-native",
        ref: "main",
        enabled: true,
        autostart: true,
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("provider identity"),
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({ target: "react-native" })
    );
  });

  it("fails closed before activating React Native builds without platform-keyed primary artifacts", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key"),
      metadata: {
        ev: "ev-app",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-1",
          provider: REACT_NATIVE_PROVIDER,
        },
      },
      artifacts: [
        {
          path: "index.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          content: "bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        target: "react-native",
        ref: "main",
        enabled: true,
        autostart: true,
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("missing a mobile platform"),
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({ target: "react-native" })
    );
  });

  it("activates React Native builds with a single platform primary artifact", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-android-only-key"
      ),
      metadata: {
        ev: "ev-app",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-1",
          provider: REACT_NATIVE_PROVIDER,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        target: "react-native",
        ref: "main",
        enabled: true,
        autostart: true,
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-android-only-key",
      lastError: null,
    });
  });

  it("fails closed when an approved app manifest drifts to native fields", async () => {
    const { host, buildSystem, eventService, approvalQueue } = makeHarness({
      invalidManifest: true,
    });

    await host.reconcileDeclared([
      { source: "apps/shell", target: "electron", ref: "main", enabled: true, autostart: true },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("pure-thin"),
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "error",
      })
    );
  });

  it("stores a four-hour dev-session grant for app main pushes", async () => {
    const { host, approvalQueue, graphNode } = makeHarness({ approvalDecision: "session" });
    installApp(host, graphNode);
    const request = {
      caller: panelCaller("panel-1"),
      repoPath: graphNode.relativePath,
      branch: "main",
      commit: "def456",
    };

    await expect(host.authorizeSourcePush(request)).resolves.toEqual({ allowed: true });
    await expect(host.authorizeSourcePush({ ...request, commit: "def457" })).resolves.toEqual({
      allowed: true,
    });
    await expect(
      host.authorizeSourcePush({
        ...request,
        caller: panelCaller("panel-2"),
        commit: "def458",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-panel",
        trigger: "source-push",
        title: "@workspace-apps/shell app source push",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            ev: "ev-app",
            source: expect.objectContaining({ repo: graphNode.relativePath, ref: "main" }),
          }),
        ],
      })
    );
  });

  it("does not gate unknown app repos or non-active branches", async () => {
    const { host, approvalQueue, graphNode } = makeHarness();
    installApp(host, graphNode);

    await expect(
      host.authorizeSourcePush({
        caller: panelCaller(),
        repoPath: "apps/unknown",
        branch: "main",
        commit: "def456",
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      host.authorizeSourcePush({
        caller: panelCaller(),
        repoPath: graphNode.relativePath,
        branch: "feature",
        commit: "def456",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});
