import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
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

  it("indexes panels into FTS5 and returns matches via WorkspaceDO.panelSearch under real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([{ source: INTERNAL_DO_SOURCE, className: "WorkspaceDO" }]);
    const ref = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "workspace-fts5",
    };

    // Index two panels; the search index lives on panel_fts (FTS5 virtual
    // table) which is only available under real workerd, not sql.js.
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

    // slotCreate enforces a foreign key into entities, so activate the panel
    // entities first.
    for (const key of ["entry-a", "entry-b"]) {
      await harness.callDurableObject(ref, "entityActivate", {
        kind: "panel",
        source: { repoPath: "panels/example", effectiveVersion: "v1" },
        contextId: "ctx-1",
        key,
      });
    }
    // Slots must be open for panelSearch to surface them.
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
