import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/browser-data", async () => {
  const actual = await vi.importActual<typeof import("@workspace/browser-data")>("@workspace/browser-data");
  return {
    ...actual,
    detectBrowsers: vi.fn(() => []),
    readOpenTabs: vi.fn(() => [
      {
        url: "https://example.com/",
        title: "Example",
        browser: "chrome",
        profilePath: "/tmp/profile",
        windowIndex: 0,
        tabIndex: 0,
        active: true,
      },
      {
        url: "chrome://settings/",
        title: "Settings",
        browser: "chrome",
        profilePath: "/tmp/profile",
        windowIndex: 0,
        tabIndex: 1,
        active: false,
      },
    ]),
    resolveProfilePath: vi.fn(() => "/tmp/profile"),
    runImportPipeline: vi.fn(async (request: { dataTypes: string[] }, store: {
      bookmarks: { addBatch(items: unknown[], meta?: unknown): Promise<number> };
      history: { addBatch(items: unknown[], meta?: unknown): Promise<number> };
    }) => {
      const results = [];
      if (request.dataTypes.includes("bookmarks")) {
        await store.bookmarks.addBatch([{ title: "Example", url: "https://example.com" }]);
        results.push({
          dataType: "bookmarks",
          success: true,
          itemCount: 1,
          skippedCount: 0,
          warnings: [],
        });
      }
      if (request.dataTypes.includes("history")) {
        await store.history.addBatch(
          [{ url: "https://example.com/docs", title: "Docs", visitCount: 1, lastVisitTime: 100 }],
          { browser: "chrome", profilePath: "/tmp/profile" },
        );
        results.push({
          dataType: "history",
          success: true,
          itemCount: 1,
          skippedCount: 0,
          warnings: [],
        });
      }
      return results;
    }),
  };
});

import { activate } from "./index.js";

type ApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: string };

function makeContext(
  callerKind: string | null = "shell",
  callerId = "shell",
  approvalChoice: ApprovalChoice = { kind: "choice", choice: "allow" },
) {
  const rpcCall = vi.fn(async (_targetId: string, method: string, ..._args: unknown[]) => {
    if (method === "addBookmarksBatch") return 1;
    if (method === "addHistoryBatch") return 1;
    if (method === "recordImportRun") return 1;
    if (method === "addBookmark") return 42;
    if (method === "getBookmarks") return [{ id: 1, title: "Example" }];
    if (method === "getPasswords") return [{ id: 7, origin_url: "https://example.com" }];
    if (method === "panelTree.create") return { id: "browser-panel-1", title: "Example" };
    return [];
  });
  const emit = vi.fn();
  const health = {
    healthy: vi.fn(),
    degraded: vi.fn(),
    unhealthy: vi.fn(),
  };
  const resolveDurableObject = vi.fn(async () => ({
    targetId: "do:natstack/internal:BrowserDataDO:global",
  }));
  const approvalsRequest = vi.fn(async () => approvalChoice);
  return {
    ctx: {
      rpc: { call: rpcCall },
      workers: { resolveDurableObject },
      invocation: {
        current: () => (callerKind === null ? null : { caller: { callerId, callerKind } }),
      },
      approvals: { request: approvalsRequest },
      log: { info: vi.fn() },
      health,
      emit,
    },
    rpcCall,
    resolveDurableObject,
    approvalsRequest,
    emit,
    health,
  };
}

describe("@workspace-extensions/browser-data", () => {
  it("gates sensitive methods behind approval and rejects when the user denies", async () => {
    const { ctx, approvalsRequest } = makeContext("panel", "panel-1", { kind: "choice", choice: "deny" });
    const api = await activate(ctx as never);

    await expect(api.getPasswords()).rejects.toMatchObject({ code: "EACCES" });
    expect(approvalsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ subject: { id: "browser-data:getPasswords", label: expect.any(String) } }),
    );
  });

  it("allows sensitive methods for a userland caller once approved", async () => {
    const { ctx, approvalsRequest } = makeContext("panel", "panel-1", { kind: "choice", choice: "allow" });
    const api = await activate(ctx as never);

    await expect(api.getPasswords()).resolves.toEqual([{ id: 7, origin_url: "https://example.com" }]);
    expect(approvalsRequest).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for non-sensitive view methods", async () => {
    const { ctx, approvalsRequest } = makeContext("panel", "panel-1");
    const api = await activate(ctx as never);

    await expect(api.getBookmarks()).resolves.toEqual([{ id: 1, title: "Example" }]);
    expect(approvalsRequest).not.toHaveBeenCalled();
  });

  it("does not prompt trusted shell callers for sensitive methods", async () => {
    const { ctx, approvalsRequest } = makeContext("shell");
    const api = await activate(ctx as never);

    await expect(api.getPasswords()).resolves.toEqual([{ id: 7, origin_url: "https://example.com" }]);
    expect(approvalsRequest).not.toHaveBeenCalled();
  });

  it("rejects sensitive methods with ENOCALLER when there is no caller", async () => {
    const { ctx } = makeContext(null);
    const api = await activate(ctx as never);

    await expect(api.getPasswords()).rejects.toMatchObject({ code: "ENOCALLER" });
  });

  it("routes shell calls to BrowserDataDO", async () => {
    const { ctx, rpcCall, resolveDurableObject } = makeContext();
    const api = await activate(ctx as never);

    await expect(api.getBookmarks()).resolves.toEqual([{ id: 1, title: "Example" }]);
    expect(resolveDurableObject).toHaveBeenCalledWith("natstack/internal", "BrowserDataDO", "global");
    expect(rpcCall).toHaveBeenCalledWith("do:natstack/internal:BrowserDataDO:global", "getBookmarks", "/");
  });

  it("emits change events for mutations", async () => {
    const { ctx, emit } = makeContext();
    const api = await activate(ctx as never);

    await expect(api.addBookmark({ title: "Example", url: "https://example.com" })).resolves.toBe(42);
    expect(emit).toHaveBeenCalledWith("data-changed", { dataType: "bookmarks" });
  });

  it("logs import results, emits import-complete, and reports healthy import status", async () => {
    const { ctx, rpcCall, emit, health } = makeContext();
    const api = await activate(ctx as never);

    await expect(api.startImport({
      browser: "chrome",
      profile: "/tmp/profile",
      dataTypes: ["bookmarks"],
    })).resolves.toMatchObject([{ dataType: "bookmarks", success: true }]);

    expect(rpcCall).toHaveBeenCalledWith(
      "do:natstack/internal:BrowserDataDO:global",
      "addBookmarksBatch",
      [{ title: "Example", url: "https://example.com" }],
      { browser: "chrome", profilePath: "/tmp/profile" },
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "do:natstack/internal:BrowserDataDO:global",
      "recordImportRun",
      expect.objectContaining({
        browser: "chrome",
        status: "success",
        summaries: expect.arrayContaining([
          expect.objectContaining({ dataType: "bookmarks", scanned: 1 }),
        ]),
      }),
    );
    expect(emit).toHaveBeenCalledWith("import-complete", expect.any(Array));
    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "Browser data import completed" });
  });

  it("passes browser profile metadata when importing history", async () => {
    const { ctx, rpcCall } = makeContext();
    const api = await activate(ctx as never);

    await expect(api.startImport({
      browser: "chrome",
      profile: "/tmp/profile",
      dataTypes: ["history"],
    })).resolves.toMatchObject([{ dataType: "history", success: true }]);

    expect(rpcCall).toHaveBeenCalledWith(
      "do:natstack/internal:BrowserDataDO:global",
      "addHistoryBatch",
      [{ url: "https://example.com/docs", title: "Docs", visitCount: 1, lastVisitTime: 100 }],
      { browser: "chrome", profilePath: "/tmp/profile" },
    );
  });

  it("opens imported HTTP tabs as child browser panels of the invoking caller", async () => {
    const { ctx, rpcCall } = makeContext("panel", "panel-parent");
    const api = await activate(ctx as never);

    await expect(api.openTabsAsPanels({
      browser: "chrome",
      profile: "/tmp/profile",
    })).resolves.toEqual({
      tabsFound: 2,
      panelsOpened: 1,
      panels: [{ id: "browser-panel-1", title: "Example", url: "https://example.com/" }],
      skipped: [{ url: "chrome://settings/", reason: "unsupported browser-panel URL scheme" }],
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "main",
      "panelTree.create",
      "https://example.com/",
      {
        parentId: "panel-parent",
        name: "Example (1.1)",
        focus: false,
      },
    );
  });
});
