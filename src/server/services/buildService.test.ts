import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
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
            artifacts: [
              {
                path: "bundle.js",
                role: "primary",
                contentType: "text/javascript; charset=utf-8",
                encoding: "utf8",
                content: "export {};",
              },
            ],
            metadata: {
              kind: "extension",
              name: "@workspace-extensions/example",
              ev: "ev-1",
              sourcemap: true,
              details: {
                kind: "extension",
                runtimeDepsKey: null,
                runtimeAbi: "2",
              },
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
      path: "extensions/example",
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
  it("preserves the legacy { bundle } contract for library builds", async () => {
    const buildSystem = makeBuildSystem();
    vi.mocked(buildSystem.getBuild).mockResolvedValue({ bundle: "module.exports = {};" } as never);
    const service = createBuildService({ buildSystem });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getBuild", [
        "@workspace-packages/example",
        undefined,
        { library: true },
      ])
    ).resolves.toEqual({ bundle: "module.exports = {};" });
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-packages/example", undefined, {
      library: true,
    });
  });

  it("exposes build metadata by immutable build key", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "getBuildMetadata", [
        "build-key",
      ])
    ).resolves.toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/example",
      details: { kind: "extension", runtimeAbi: "2" },
    });
  });

  it("delegates doctorExtension reports", async () => {
    const buildSystem = makeBuildSystem();
    const service = createBuildService({ buildSystem });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "doctorExtension", [
        "@workspace-extensions/example",
      ])
    ).resolves.toMatchObject({
      name: "@workspace-extensions/example",
      checks: [expect.objectContaining({ name: "manifest", status: "pass" })],
    });
  });
});
