import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { PrincipalRegistry } from "../../packages/shared/src/principalRegistry.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { postToDurableObject, type DORef } from "./workerdRpcRelay.js";
import { WorkerdManager, type WorkerdManagerDeps } from "./workerdManager.js";

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
    principalRegistry: new PrincipalRegistry(),
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

  return { manager, callDurableObject };
}

describe("internal storage DOs under workerd", () => {
  let manager: WorkerdManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.shutdown();
      manager = null;
    }
  });

  it("supports PanelStoreDO FTS5 search in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "PanelStoreDO" }]);

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "PanelStoreDO",
      objectKey: "workspace-fts",
    };
    const snapshot = {
      source: "panels/search/index.tsx",
      contextId: "ctx-search",
      options: {},
      stateArgs: {},
    };
    await harness.callDurableObject(
      ref,
      "appendOp",
      {
        opId: "op-create-root",
        type: "panel.create",
        panelId: "root",
        parentId: null,
        positionId: "000001000000",
        snapshot,
        title: "Root",
      },
      "actor-a"
    );
    await harness.callDurableObject(
      ref,
      "appendOp",
      {
        opId: "op-create-child",
        type: "panel.create",
        panelId: "child",
        parentId: "root",
        positionId: "000002000000",
        snapshot,
        title: "Search Console",
      },
      "actor-a"
    );
    await harness.callDurableObject(ref, "indexPanel", {
      id: "child",
      title: "Search Console",
      path: "panels/search/index.tsx",
      manifestDescription: "Finds durable object storage records",
      tags: ["storage", "fts"],
    });

    await expect(harness.callDurableObject(ref, "search", "durable", 5)).resolves.toMatchObject([
      { id: "child", title: "Search Console" },
    ]);
    await harness.callDurableObject(
      ref,
      "appendOp",
      {
        opId: "op-archive-child",
        type: "panel.archive",
        panelId: "child",
      },
      "actor-a"
    );
    await expect(harness.callDurableObject(ref, "search", "durable", 5)).resolves.toEqual([]);
  }, 30_000);

  it("persists PanelStoreDO ops and returns consistent snapshots", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "PanelStoreDO" }]);

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "PanelStoreDO",
      objectKey: "workspace-ops",
    };
    const snapshot = {
      source: "panels/search/index.tsx",
      contextId: "ctx-search",
      options: {},
      stateArgs: {},
    };
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        {
          opId: "op-create-root",
          type: "panel.create",
          panelId: "root",
          parentId: null,
          positionId: "000001000000",
          snapshot,
          title: "Root",
        },
        "actor-a"
      )
    ).resolves.toMatchObject({ accepted: true, revision: 1 });
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        {
          opId: "op-title-root",
          type: "panel.setTitle",
          panelId: "root",
          title: "Renamed",
        },
        "actor-b"
      )
    ).resolves.toMatchObject({ accepted: true, revision: 2 });
    const nextSnapshot = {
      source: "panels/other/index.tsx",
      contextId: "ctx-search",
      options: {},
      stateArgs: { q: "next" },
    };
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        {
          opId: "op-snapshot-root",
          type: "panel.setSnapshot",
          panelId: "root",
          snapshot: nextSnapshot,
          history: { entries: [snapshot, nextSnapshot], index: 1 },
        },
        "actor-a"
      )
    ).resolves.toMatchObject({ accepted: true, revision: 3 });
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        {
          opId: "op-title-root",
          type: "panel.setTitle",
          panelId: "root",
          title: "Renamed",
        },
        "actor-b"
      )
    ).resolves.toMatchObject({ accepted: false, alreadyApplied: true, revision: 2 });

    await expect(harness.callDurableObject(ref, "getOpsSince", 0)).resolves.toMatchObject({
      revision: 3,
      ops: [
        { opId: "op-create-root", actorId: "actor-a", revision: 1 },
        { opId: "op-title-root", actorId: "actor-b", revision: 2 },
        { opId: "op-snapshot-root", actorId: "actor-a", revision: 3 },
      ],
    });
    await expect(harness.callDurableObject(ref, "getSnapshot")).resolves.toMatchObject({
      revision: 3,
      tree: [
        {
          id: "root",
          title: "Renamed",
          snapshot: nextSnapshot,
          history: { entries: [snapshot, nextSnapshot], index: 1 },
        },
      ],
    });
    await expect(harness.callDurableObject(ref, "compactOps", 1)).resolves.toMatchObject({
      compactedThroughRevision: 1,
      retainedOps: 2,
      revision: 3,
    });
    await expect(harness.callDurableObject(ref, "getOpsSince", 0)).resolves.toMatchObject({
      revision: 3,
      snapshotRequired: true,
      ops: [],
    });
    await expect(harness.callDurableObject(ref, "getOpsSince", 1)).resolves.toMatchObject({
      revision: 3,
      ops: [
        { opId: "op-title-root", actorId: "actor-b", revision: 2 },
        { opId: "op-snapshot-root", actorId: "actor-a", revision: 3 },
      ],
    });
  }, 30_000);

  it("rejects malformed PanelStoreDO history and rolls back failed batches", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "PanelStoreDO" }]);

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "PanelStoreDO",
      objectKey: "workspace-op-validation",
    };
    const snapshot = { source: "panels/root/index.tsx", contextId: "ctx-root", options: {} };
    await harness.callDurableObject(
      ref,
      "appendOp",
      {
        opId: "create-root",
        type: "panel.create",
        panelId: "root",
        parentId: null,
        positionId: "000001000000",
        snapshot,
        title: "Root",
      },
      "actor-a"
    );

    await expect(
      harness.callDurableObject(
        ref,
        "appendOps",
        [
          { opId: "rename-root", type: "panel.setTitle", panelId: "root", title: "Renamed" },
          {
            opId: "bad-history",
            type: "panel.setSnapshot",
            panelId: "root",
            snapshot,
            history: { entries: [], index: 0 },
          },
        ],
        "actor-a"
      )
    ).resolves.toMatchObject({
      acceptedOps: [],
      rejectedOps: [{ opId: "bad-history", reason: "MALFORMED_HISTORY" }],
      revision: 1,
    });

    await expect(harness.callDurableObject(ref, "getSnapshot")).resolves.toMatchObject({
      revision: 1,
      tree: [{ id: "root", title: "Root", history: { entries: [snapshot], index: 0 } }],
    });
  }, 30_000);

  it("applies PanelStoreDO tombstone and restore rules", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "PanelStoreDO" }]);

    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "PanelStoreDO",
      objectKey: "workspace-tombstones",
    };
    const snapshot = { source: "panels/search/index.tsx", contextId: "ctx", options: {} };
    await harness.callDurableObject(
      ref,
      "appendOps",
      [
        {
          opId: "create-root",
          type: "panel.create",
          panelId: "root",
          parentId: null,
          positionId: "000001000000",
          snapshot,
          title: "Root",
        },
        {
          opId: "create-child",
          type: "panel.create",
          panelId: "child",
          parentId: "root",
          positionId: "000001000000",
          snapshot,
          title: "Child",
        },
      ],
      "actor-a"
    );
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        { opId: "archive-root", type: "panel.archive", panelId: "root" },
        "actor-a"
      )
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        {
          opId: "move-child-while-archived",
          type: "panel.move",
          panelId: "child",
          parentId: null,
          positionId: "000002000000",
        },
        "actor-b"
      )
    ).resolves.toMatchObject({ accepted: false, rejectedReason: "ARCHIVED" });
    await expect(
      harness.callDurableObject(
        ref,
        "appendOp",
        { opId: "restore-child", type: "panel.restore", panelId: "child" },
        "actor-b"
      )
    ).resolves.toMatchObject({ accepted: true });
    await expect(harness.callDurableObject(ref, "getSnapshot")).resolves.toMatchObject({
      tree: [{ id: "child", title: "Child" }],
    });
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
          logLevel: "silent",
        });
        return {
          bundle: result.outputFiles[0]!.text,
          metadata: { ev: "gad-store-test" },
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
    const head = (await harness.callDurableObject(ref, "ensurePiBranch", {
      branchId: "branch-live",
      channelId: "channel-live",
      metadata: { contextId: "context-live" },
    })) as { branchId: string; headEntryHash: string | null; headStateHash: string };
    const userMessageId = "01900000-0000-7000-8000-000000000001";
    await harness.callDurableObject(ref, "appendPiEntryBatch", {
      branchId: head.branchId,
      expectedHeadEntryHash: head.headEntryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: userMessageId,
          parentEntryId: null,
          entryType: "message",
          actor: "user",
          payload: {
            message: {
              role: "user",
              content: [{ type: "text", text: "write the file" }],
              timestamp: 1,
            },
          },
        },
      ],
    });
    await harness.callDurableObject(ref, "appendGadEvents", {
      events: [
        {
          eventId: "01900000-0000-7000-8000-000000000002",
          kind: "file_mutation_planned",
          anchorKind: "tool_call",
          anchorId: "tool-live",
          payload: {
            mutationId: "mutation-live",
            toolCallId: "tool-live",
            path: "src/live.ts",
            operation: "write",
            plannedTool: "write",
            beforeHash: null,
            beforeSize: null,
            plannedParams: { path: "src/live.ts" },
          },
        },
        {
          eventId: "01900000-0000-7000-8000-000000000003",
          kind: "file_mutation_observed",
          anchorKind: "tool_call",
          anchorId: "tool-live",
          payload: {
            mutationId: "mutation-live",
            toolCallId: "tool-live",
            path: "src/live.ts",
            afterHash: "d".repeat(64),
            afterSize: 12,
            outcome: "ok",
          },
        },
      ],
    });
    const status = (await harness.callDurableObject(ref, "getStatus")) as Array<{
      metric: string;
      value: number;
    }>;
    expect(status.find((row) => row.metric === "Pi branches")?.value).toBe(1);
    expect(status.find((row) => row.metric === "Pi entries")?.value).toBe(1);
    expect(status.find((row) => row.metric === "GAD events")?.value).toBe(2);
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
