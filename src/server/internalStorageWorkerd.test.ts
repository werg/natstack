import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { DODispatch } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { postToDurableObject, type DORef } from "./workerdRpcRelay.js";
import { WorkerdManager, type WorkerdManagerDeps } from "./workerdManager.js";
import { LifecycleDriver } from "./services/lifecycleDriver.js";
import type { BuildResult } from "./buildV2/buildStore.js";

const workspaceAliasPlugin: esbuild.Plugin = {
  name: "workspace-alias",
  setup(build) {
    build.onResolve({ filter: /^@workspace\/agentic-protocol$/ }, () => ({
      path: resolve("workspace/packages/agentic-protocol/src/index.ts"),
    }));
  },
};

beforeAll(async () => {
  mkdirSync("dist", { recursive: true });
  await esbuild.build({
    entryPoints: ["src/server/internalDOs/index.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    outfile: "dist/internal-do.bundle.mjs",
    conditions: ["worker", "browser"],
    external: ["node:*", "electron"],
    logLevel: "silent",
  });
});

function createWorkerdHarness(overrides: Partial<WorkerdManagerDeps> = {}) {
  const tokenManager = new TokenManager();
  const manager = new WorkerdManager({
    tokenManager,
    fsService: {
      closeHandlesForCaller: () => {},
    } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => "http://127.0.0.1:9",
    getBuild: async () => {
      throw new Error("workspace builds are not used by internal DO tests");
    },
    workspacePath: mkdtempSync(join(tmpdir(), "natstack-workerd-workspace-")),
    statePath: mkdtempSync(join(tmpdir(), "natstack-workerd-state-")),
    getProxyPort: () => 9,
    getWorkerdGatewayToken: () => "internal-test-workerd-gateway-token",
    ...overrides,
  } satisfies WorkerdManagerDeps);

  const callDurableObject = async (
    ref: DORef,
    method: string,
    ...args: unknown[]
  ): Promise<unknown> => {
    await manager.ensureDO(ref.source, ref.className, ref.objectKey);
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return postToDurableObject(ref, method, args, {
      workerdUrl: `http://127.0.0.1:${port}`,
      workerdGatewayToken: manager.getWorkerdGatewayToken(),
      workerdDispatchSecret: manager.getDispatchSecret(),
    });
  };

  return { manager, tokenManager, callDurableObject };
}

function createDODispatch(manager: WorkerdManager, tokenManager: TokenManager): DODispatch {
  const dispatch = new DODispatch();
  dispatch.setTokenManager(tokenManager);
  dispatch.setGetWorkerdGatewayToken(() => manager.getWorkerdGatewayToken());
  dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
  dispatch.setGetWorkerdUrl(() => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return `http://127.0.0.1:${port}`;
  });
  dispatch.setEnsureDO((source, className, objectKey) =>
    manager.ensureDO(source, className, objectKey)
  );
  return dispatch;
}

async function bundleWorker(source: string, entryPoint: string, ev: string): Promise<BuildResult> {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "esm",
    write: false,
    conditions: ["worker", "browser"],
    external: ["node:*", "electron"],
    logLevel: "silent",
  });
  return buildResult(source, ev, result.outputFiles[0]!.text);
}

function buildResult(source: string, ev: string, bundle: string): BuildResult {
  return {
    dir: `/tmp/natstack-${ev}-build`,
    metadata: {
      kind: "worker",
      name: source,
      ev,
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

describe("internal storage DOs under workerd", () => {
  let manager: WorkerdManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
  });

  it("round-trips entity activate / resolve / retire / gc through WorkspaceDO under workerd", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" }]);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-test",
    };

    const activateInput = {
      kind: "panel",
      source: { repoPath: "panels/example", effectiveVersion: "v1" },
      contextId: "ctx-1",
      key: "entry-1",
    };
    const record = (await harness.callDurableObject(ref, "entityActivate", activateInput)) as {
      id: string;
      kind: string;
      status: string;
    };
    expect(record.kind).toBe("panel");
    expect(record.status).toBe("active");

    const resolved = (await harness.callDurableObject(ref, "entityResolveActive", record.id)) as {
      id: string;
      status: string;
    };
    expect(resolved.id).toBe(record.id);
    expect(resolved.status).toBe("active");

    const retired = (await harness.callDurableObject(ref, "entityRetire", record.id)) as {
      id: string;
      status: string;
    };
    expect(retired.status).toBe("retired");

    const deleted = (await harness.callDurableObject(ref, "entityGc", {
      all: true,
      graceMs: 0,
    })) as string[];
    expect(deleted).toEqual([record.id]);
    await expect(
      harness.callDurableObject(ref, "entityResolveActive", record.id)
    ).resolves.toBeNull();
  }, 30_000);

  it("drives lifecycle prepare and resume through real workerd restart hooks", async () => {
    const probeBuild = await bundleWorker(
      "workers/lifecycle-probe",
      "src/server/testFixtures/lifecycleProbeWorker.ts",
      "lifecycle-probe-test"
    );
    const triggerBuild = buildResult(
      "workers/restart-trigger",
      "restart-trigger-test",
      `export default { fetch() { return new Response("trigger"); } };`
    );
    const harness = createWorkerdHarness({
      getBuild: async (source: string) => {
        if (source === "workers/lifecycle-probe") return probeBuild;
        if (source === "workers/restart-trigger") return triggerBuild;
        throw new Error(`unexpected build source ${source}`);
      },
    });
    manager = harness.manager;
    const doDispatch = createDODispatch(manager, harness.tokenManager);
    const lifecycleDriver = new LifecycleDriver({
      workerdManager: manager,
      doDispatch,
      workspaceId: "workspace-lifecycle",
      prepareDeadlineMs: 3_000,
      concurrency: 2,
    });
    const workspaceRef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-lifecycle",
    };
    const probeRef = {
      source: "workers/lifecycle-probe",
      className: "LifecycleProbeDO",
      objectKey: "probe-1",
    };

    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" },
      { source: "workers/lifecycle-probe", className: "LifecycleProbeDO" },
    ]);
    lifecycleDriver.start();
    try {
      await expect(
        harness.callDurableObject(probeRef, "__lifecycle/prepare", {
          epoch: "raw",
          reason: "raw",
          deadlineMs: 1_000,
        })
      ).rejects.toThrow("403");

      await doDispatch.dispatch(workspaceRef, "lifecycleLeaseUpsert", {
        source: probeRef.source,
        className: probeRef.className,
        objectKey: probeRef.objectKey,
        detail: { test: "planned-restart" },
      });

      await manager.createInstance({
        source: "workers/restart-trigger",
        contextId: "ctx-lifecycle",
        name: "restart-trigger",
      });

      expect(manager.getBootGeneration()).toBe(2);
      await expect(doDispatch.dispatch(probeRef, "currentBootGeneration")).resolves.toBe("2");
      await expect(doDispatch.dispatch(probeRef, "lifecycleEvents")).resolves.toMatchObject([
        {
          kind: "prepare",
          input: expect.objectContaining({ reason: "planned" }),
          bootGeneration: "1",
        },
        {
          kind: "resume",
          input: expect.objectContaining({
            reason: "planned",
            previousGeneration: 1,
            currentGeneration: 2,
          }),
          bootGeneration: "2",
        },
      ]);

      const leases = await doDispatch.dispatch(workspaceRef, "lifecycleListLeases");
      expect(leases).toEqual([
        expect.objectContaining({
          source: probeRef.source,
          className: probeRef.className,
          objectKey: probeRef.objectKey,
        }),
      ]);
    } finally {
      lifecycleDriver.stop();
    }
  }, 30_000);

  it("indexes panels into FTS5 and returns matches via WorkspaceDO.panelSearch under real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" }]);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-fts5",
    };

    // Production order is slotCreate → panelIndex: the slot needs to exist
    // and bind to a current entity before panelIndex can stamp the title
    // onto entities.display_title (the new source of truth for titles).
    for (const key of ["entry-a", "entry-b"]) {
      await harness.callDurableObject(ref, "entityActivate", {
        kind: "panel",
        source: { repoPath: "panels/example", effectiveVersion: "v1" },
        contextId: "ctx-1",
        key,
      });
    }
    await harness.callDurableObject(ref, "slotCreate", {
      slotId: "slot-alpha",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: "entry-a",
        entityId: "panel:entry-a",
        source: "panels/example",
        contextId: "ctx-1",
      },
    });
    await harness.callDurableObject(ref, "slotCreate", {
      slotId: "slot-beta",
      parentSlotId: null,
      positionId: "000002000000",
      initialEntry: {
        entryKey: "entry-b",
        entityId: "panel:entry-b",
        source: "panels/example",
        contextId: "ctx-1",
      },
    });
    await harness.callDurableObject(ref, "panelIndex", {
      id: "slot-alpha",
      title: "Alpha chat panel",
      manifestDescription: "primary chat workspace",
      keywords: ["chat", "alpha"],
    });
    await harness.callDurableObject(ref, "panelIndex", {
      id: "slot-beta",
      title: "Beta notes panel",
      manifestDescription: "scratchpad for notes",
      keywords: ["notes"],
    });

    const matches = (await harness.callDurableObject(ref, "panelSearch", "chat", 10)) as Array<{
      id: string;
      title: string;
    }>;
    expect(matches.map((m) => m.id)).toContain("slot-alpha");
    expect(matches.find((m) => m.id === "slot-alpha")?.title).toBe("Alpha chat panel");
    expect(matches.find((m) => m.id === "slot-beta")).toBeUndefined();
  }, 30_000);

  it("supports BrowserDataDO history FTS5 search in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    await harness.callDurableObject(ref, "addHistoryBatch", [
      {
        url: "https://example.com/docs/storage",
        title: "Durable storage guide",
        visitCount: 3,
        typedCount: 1,
        firstVisitTime: 100,
        lastVisitTime: 200,
      },
    ]);

    await expect(
      harness.callDurableObject(ref, "searchHistory", "durable", 10)
    ).resolves.toMatchObject([
      { url: "https://example.com/docs/storage", title: "Durable storage guide" },
    ]);
    await expect(harness.callDurableObject(ref, "deleteHistoryRange", 100, 200)).resolves.toBe(1);
    await expect(harness.callDurableObject(ref, "searchHistory", "durable", 10)).resolves.toEqual(
      []
    );
  }, 30_000);

  it("persists gad provenance through real workerd DO dispatch", async () => {
    const harness = createWorkerdHarness({
      getBuild: async (source: string) => {
        expect(source).toBe("workers/gad-store");
        const result = await esbuild.build({
          entryPoints: ["workspace/workers/gad-store/index.ts"],
          bundle: true,
          platform: "browser",
          target: "es2022",
          format: "esm",
          write: false,
          conditions: ["worker", "browser"],
          external: ["node:*", "electron"],
          plugins: [workspaceAliasPlugin],
          logLevel: "silent",
        });
        const bundle = result.outputFiles[0]!.text;
        return {
          dir: "/tmp/natstack-gad-store-test-build",
          metadata: {
            kind: "worker",
            name: "workers/gad-store",
            ev: "gad-store-test",
            sourcemap: false,
            details: { kind: "generic" },
            builtAt: "2026-01-01T00:00:00.000Z",
          },
          artifacts: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8",
              content: bundle,
            },
          ],
        } as never;
      },
    });
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: "workers/gad-store", className: "GadWorkspaceDO" },
    ]);

    const ref = {
      source: "workers/gad-store",
      className: "GadWorkspaceDO",
      objectKey: "workspace-gad",
    };
    const userMessageId = "01900000-0000-7000-8000-000000000001";
    await harness.callDurableObject(ref, "appendTrajectoryBatch", {
      trajectoryId: "trajectory-live",
      branchId: "branch-live",
      owner: { kind: "agent", id: "test" },
      events: [
        {
          eventId: userMessageId,
          event: {
            kind: "message.completed",
            actor: { kind: "user", id: "user" },
            causality: { messageId: userMessageId },
            payload: {
              protocol: "agentic.trajectory.v1",
              role: "user",
              content: "write the file",
              blocks: [{ type: "text", content: "write the file" }],
            },
            createdAt: new Date(1).toISOString(),
          },
        },
        {
          eventId: "01900000-0000-7000-8000-000000000002",
          event: {
            kind: "state.file_mutation_intended",
            actor: { kind: "agent", id: "pi" },
            causality: { invocationId: "tool-live", modelToolCallId: "tool-live" },
            payload: {
              protocol: "agentic.trajectory.v1",
              mutationId: "mutation-live",
              path: "src/live.ts",
              operation: "write",
              metadata: { plannedParams: { path: "src/live.ts" } },
            },
            createdAt: new Date(2).toISOString(),
          },
        },
        {
          eventId: "01900000-0000-7000-8000-000000000003",
          event: {
            kind: "state.file_mutation_applied",
            actor: { kind: "agent", id: "pi" },
            causality: { invocationId: "tool-live", modelToolCallId: "tool-live" },
            payload: {
              protocol: "agentic.trajectory.v1",
              mutationId: "mutation-live",
              path: "src/live.ts",
              afterHash: "d".repeat(64),
              size: 12,
              summary: "ok",
            },
            createdAt: new Date(3).toISOString(),
          },
        },
      ],
    });
    const status = (await harness.callDurableObject(ref, "getStatus")) as Array<{
      metric: string;
      value: number;
    }>;
    expect(status.find((row) => row.metric === "Trajectory branches")?.value).toBe(1);
    expect(status.find((row) => row.metric === "Trajectory events")?.value).toBe(3);
    expect(status.find((row) => row.metric === "File mutations")?.value).toBe(1);
  }, 30_000);

  it("records BrowserDataDO history visits and title updates without double-counting", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "BrowserDataDO",
      objectKey: "global-record",
    };
    await harness.callDurableObject(ref, "recordHistoryVisit", {
      url: "https://example.com/app",
      title: "Example App",
      transition: "typed",
      typed: true,
      visitTime: 100,
    });
    await harness.callDurableObject(ref, "updateHistoryTitle", {
      url: "https://example.com/app",
      title: "Example App Updated",
      observedAt: 150,
    });
    await expect(
      harness.callDurableObject(ref, "searchHistoryForAutocomplete", {
        query: "updated",
        limit: 10,
      })
    ).resolves.toMatchObject([
      {
        url: "https://example.com/app",
        title: "Example App Updated",
        visit_count: 1,
        typed_count: 1,
        first_visit: 100,
        last_visit: 100,
      },
    ]);
    await harness.callDurableObject(ref, "recordHistoryVisit", {
      url: "https://example.com/app",
      transition: "back_forward",
      typed: false,
      visitTime: 200,
    });

    await expect(
      harness.callDurableObject(ref, "searchHistoryForAutocomplete", {
        query: "updated",
        limit: 10,
      })
    ).resolves.toMatchObject([
      {
        url: "https://example.com/app",
        title: "Example App Updated",
        visit_count: 2,
        typed_count: 1,
        first_visit: 100,
        last_visit: 200,
      },
    ]);
  }, 30_000);

  it("returns affected counts for BrowserDataDO cookie clears", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    await harness.callDurableObject(ref, "addCookiesBatch", [
      {
        name: "sid",
        value: "one",
        domain: ".example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        sourceScheme: "secure",
        sourcePort: 443,
      },
      {
        name: "sid",
        value: "two",
        domain: ".other.test",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        sourceScheme: "secure",
        sourcePort: 443,
      },
    ]);

    await expect(harness.callDurableObject(ref, "clearCookies", "example.com")).resolves.toBe(1);
    await expect(harness.callDurableObject(ref, "clearCookies")).resolves.toBe(1);
  }, 30_000);

  it("round-trips BrowserDataDO encrypted passwords in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    const id = await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "correct horse battery staple",
      actionUrl: "https://example.com/session",
      realm: "",
    });

    expect(typeof id).toBe("number");
    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com/login")
    ).resolves.toMatchObject([
      {
        origin_url: "https://example.com/login",
        username: "ada",
        password: "correct horse battery staple",
        action_url: "https://example.com/session",
      },
    ]);

    await harness.callDurableObject(ref, "updatePassword", id, { password: "updated secret" });
    await expect(harness.callDurableObject(ref, "getPasswords")).resolves.toMatchObject([
      { id, username: "ada", password: "updated secret" },
    ]);
  }, 30_000);

  it("supports BrowserDataDO autofill password lookup semantics in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    const id = (await harness.callDurableObject(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 0,
    })) as number;

    await expect(
      harness.callDurableObject(ref, "getPasswordForSite", "https://example.com")
    ).resolves.toMatchObject([
      {
        id,
        origin_url: "https://example.com/login",
        username: "ada",
        password: "first secret",
      },
    ]);

    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(false);
    await harness.callDurableObject(ref, "addNeverSave", "https://never.example");
    await expect(
      harness.callDurableObject(ref, "isNeverSave", "https://never.example")
    ).resolves.toBe(true);

    await harness.callDurableObject(ref, "updateLastUsed", id);
    await expect(harness.callDurableObject(ref, "getPasswords")).resolves.toMatchObject([
      { id, times_used: 1 },
    ]);
  }, 30_000);

  it("upserts duplicate BrowserDataDO password batch imports in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    const password = {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 1,
    };
    await expect(harness.callDurableObject(ref, "addPasswordsBatch", [password])).resolves.toBe(1);
    await expect(
      harness.callDurableObject(ref, "addPasswordsBatch", [
        { ...password, password: "second secret", timesUsed: 7 },
      ])
    ).resolves.toBe(1);
    await expect(harness.callDurableObject(ref, "getPasswords")).resolves.toMatchObject([
      {
        origin_url: "https://example.com/login",
        username: "ada",
        password: "second secret",
        times_used: 7,
      },
    ]);
  }, 30_000);
});
