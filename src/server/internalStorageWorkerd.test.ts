import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { DODispatch } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
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

function createWorkerdHarness() {
  const tokenManager = new TokenManager();
  const manager = new WorkerdManager({
    tokenManager,
    fsService: {
      registerCallerContext: () => {},
      unregisterCallerContext: () => {},
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
    codeIdentityResolver: {
      upsertCallerIdentity: () => {},
      unregisterCaller: () => {},
    },
  } satisfies WorkerdManagerDeps);

  const dispatch = new DODispatch();
  dispatch.setTokenManager(tokenManager);
  dispatch.setGetWorkerdUrl(() => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd port is not available");
    return `http://127.0.0.1:${port}`;
  });
  dispatch.setGetDispatchSecret(() => manager.getDispatchSecret());
  dispatch.setGetWorkerdGatewayToken(() => manager.getWorkerdGatewayToken());
  dispatch.setEnsureDO((source, className, objectKey) => manager.ensureDO(source, className, objectKey));

  return { manager, dispatch };
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
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "PanelStoreDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "PanelStoreDO", objectKey: "workspace-fts" };
    const snapshot = { source: "panels/search/index.tsx", stateArgs: {} };
    await harness.dispatch.dispatch(ref, "createPanel", { id: "root", title: "Root", parentId: null, snapshot });
    await harness.dispatch.dispatch(ref, "createPanel", { id: "child", title: "Search Console", parentId: "root", snapshot });
    await harness.dispatch.dispatch(ref, "indexPanel", {
      id: "child",
      title: "Search Console",
      path: "panels/search/index.tsx",
      manifestDescription: "Finds durable object storage records",
      tags: ["storage", "fts"],
    });

    await expect(harness.dispatch.dispatch(ref, "search", "durable", 5)).resolves.toMatchObject([
      { id: "child", title: "Search Console" },
    ]);
    await harness.dispatch.dispatch(ref, "archivePanel", "child");
    await expect(harness.dispatch.dispatch(ref, "search", "durable", 5)).resolves.toEqual([]);
  }, 30_000);

  it("supports BrowserDataDO history FTS5 search in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    await harness.dispatch.dispatch(ref, "addHistoryBatch", [{
      url: "https://example.com/docs/storage",
      title: "Durable storage guide",
      visitCount: 3,
      typedCount: 1,
      firstVisitTime: 100,
      lastVisitTime: 200,
    }]);

    await expect(harness.dispatch.dispatch(ref, "searchHistory", "durable", 10)).resolves.toMatchObject([
      { url: "https://example.com/docs/storage", title: "Durable storage guide" },
    ]);
    await expect(harness.dispatch.dispatch(ref, "deleteHistoryRange", 100, 200)).resolves.toBe(1);
    await expect(harness.dispatch.dispatch(ref, "searchHistory", "durable", 10)).resolves.toEqual([]);
  }, 30_000);

  it("records BrowserDataDO history visits and title updates without double-counting", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global-record" };
    await harness.dispatch.dispatch(ref, "recordHistoryVisit", {
      url: "https://example.com/app",
      title: "Example App",
      transition: "typed",
      typed: true,
      visitTime: 100,
    });
    await harness.dispatch.dispatch(ref, "updateHistoryTitle", {
      url: "https://example.com/app",
      title: "Example App Updated",
      observedAt: 150,
    });
    await expect(harness.dispatch.dispatch(ref, "searchHistoryForAutocomplete", { query: "updated", limit: 10 })).resolves.toMatchObject([
      {
        url: "https://example.com/app",
        title: "Example App Updated",
        visit_count: 1,
        typed_count: 1,
        first_visit: 100,
        last_visit: 100,
      },
    ]);
    await harness.dispatch.dispatch(ref, "recordHistoryVisit", {
      url: "https://example.com/app",
      transition: "back_forward",
      typed: false,
      visitTime: 200,
    });

    await expect(harness.dispatch.dispatch(ref, "searchHistoryForAutocomplete", { query: "updated", limit: 10 })).resolves.toMatchObject([
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
    await harness.dispatch.dispatch(ref, "addCookiesBatch", [
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

    await expect(harness.dispatch.dispatch(ref, "clearCookies", "example.com")).resolves.toBe(1);
    await expect(harness.dispatch.dispatch(ref, "clearCookies")).resolves.toBe(1);
  }, 30_000);

  it("round-trips BrowserDataDO encrypted passwords in real workerd storage", async () => {
    const harness = createWorkerdHarness();
    manager = harness.manager;
    await manager.registerAllDOClasses([
      { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO" },
    ]);

    const ref = { source: INTERNAL_DO_SOURCE, className: "BrowserDataDO", objectKey: "global" };
    const id = await harness.dispatch.dispatch(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "correct horse battery staple",
      actionUrl: "https://example.com/session",
      realm: "",
    });

    expect(typeof id).toBe("number");
    await expect(harness.dispatch.dispatch(ref, "getPasswordForSite", "https://example.com/login")).resolves.toMatchObject([
      {
        origin_url: "https://example.com/login",
        username: "ada",
        password: "correct horse battery staple",
        action_url: "https://example.com/session",
      },
    ]);

    await harness.dispatch.dispatch(ref, "updatePassword", id, { password: "updated secret" });
    await expect(harness.dispatch.dispatch(ref, "getPasswords")).resolves.toMatchObject([
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
    const id = await harness.dispatch.dispatch(ref, "addPassword", {
      url: "https://example.com/login",
      username: "ada",
      password: "first secret",
      actionUrl: "https://example.com/session",
      realm: "",
      timesUsed: 0,
    }) as number;

    await expect(harness.dispatch.dispatch(ref, "getPasswordForSite", "https://example.com")).resolves.toMatchObject([
      {
        id,
        origin_url: "https://example.com/login",
        username: "ada",
        password: "first secret",
      },
    ]);

    await expect(harness.dispatch.dispatch(ref, "isNeverSave", "https://never.example")).resolves.toBe(false);
    await harness.dispatch.dispatch(ref, "addNeverSave", "https://never.example");
    await expect(harness.dispatch.dispatch(ref, "isNeverSave", "https://never.example")).resolves.toBe(true);

    await harness.dispatch.dispatch(ref, "updateLastUsed", id);
    await expect(harness.dispatch.dispatch(ref, "getPasswords")).resolves.toMatchObject([
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
    await expect(harness.dispatch.dispatch(ref, "addPasswordsBatch", [password])).resolves.toBe(1);
    await expect(harness.dispatch.dispatch(ref, "addPasswordsBatch", [{ ...password, password: "second secret", timesUsed: 7 }])).resolves.toBe(1);
    await expect(harness.dispatch.dispatch(ref, "getPasswords")).resolves.toMatchObject([
      {
        origin_url: "https://example.com/login",
        username: "ada",
        password: "second secret",
        times_used: 7,
      },
    ]);
  }, 30_000);
});
