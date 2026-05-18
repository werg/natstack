import { describe, expect, it, vi } from "vitest";

import { createBuildService } from "./buildService.js";
import type { BuildSystemV2 } from "../buildV2/index.js";

function makeBuildSystem(): BuildSystemV2 {
  return {
    getBuild: vi.fn(),
    getBuildNpm: vi.fn(),
    getBuildByKey: vi.fn((key: string) =>
      key === "build-key"
        ? {
            dir: "/tmp/build-key",
            bundlePath: "/tmp/build-key/bundle.js",
            bundle: "export {};",
            metadata: {
              kind: "extension",
              name: "@workspace-extensions/example",
              ev: "ev-1",
              sourcemap: true,
              extensionRuntimeAbi: "2",
              builtAt: "2026-01-01T00:00:00.000Z",
            },
          }
        : null
    ),
    getEffectiveVersion: vi.fn(),
    getExternalDeps: vi.fn(),
    doctorExtension: vi.fn(async () => ({
      name: "@workspace-extensions/example",
      kind: "extension" as const,
      path: "extensions/@workspace-extensions/example",
      dependencyDiagnostics: {
        dependencyMode: "auto" as const,
        classifiedDeps: [],
        runtimeExternalDeps: {},
        bundledDeps: {},
        notes: [],
      },
      buildMetadata: null,
      checks: [{ name: "manifest", status: "pass" as const, message: "ok" }],
    })),
    recompute: vi.fn(),
    gc: vi.fn(),
    getAboutPages: vi.fn(),
    hasUnit: vi.fn(),
    getGraph: vi.fn(() => ({ allNodes: () => [] })),
    getWorkspaceRoot: vi.fn(() => "/tmp/workspace"),
    onPushBuild: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as BuildSystemV2;
}

describe("build service extension diagnostics", () => {
  it("exposes build metadata by immutable build key", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem });

    await expect(
      service.handler({ callerId: "shell", callerKind: "shell" }, "getBuildMetadata", ["build-key"])
    ).resolves.toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
      extensionRuntimeAbi: "2",
    });
  });

  it("delegates doctorExtension reports", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem });

    await expect(
      service.handler({ callerId: "shell", callerKind: "shell" }, "doctorExtension", [
        "@workspace-extensions/example",
      ])
    ).resolves.toMatchObject({
      name: "@workspace-extensions/example",
      checks: [expect.objectContaining({ name: "manifest", status: "pass" })],
    });
  });
});
