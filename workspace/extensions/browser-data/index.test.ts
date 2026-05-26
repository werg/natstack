import { describe, expect, it, vi } from "vitest";

vi.mock("@natstack/browser-data", async () => {
  const actual = await vi.importActual<typeof import("@natstack/browser-data")>("@natstack/browser-data");
  return {
    ...actual,
    detectBrowsers: vi.fn(() => []),
    resolveProfilePath: vi.fn(() => "/tmp/profile"),
    runImportPipeline: vi.fn(async (_request: unknown, store: {
      bookmarks: { addBatch(items: unknown[]): Promise<number> };
    }) => {
      await store.bookmarks.addBatch([{ title: "Example", url: "https://example.com" }]);
      return [{
        dataType: "bookmarks",
        success: true,
        itemCount: 1,
        skippedCount: 0,
        warnings: [],
      }];
    }),
  };
});

import { activate } from "./index.js";

function makeContext(callerKind = "shell") {
  const rpcCall = vi.fn(async (_targetId: string, method: string, ..._args: unknown[]) => {
    if (method === "addBookmarksBatch") return 1;
    if (method === "logImport") return undefined;
    if (method === "addBookmark") return 42;
    if (method === "getBookmarks") return [{ id: 1, title: "Example" }];
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
  return {
    ctx: {
      rpc: { call: rpcCall },
      workers: { resolveDurableObject },
      invocation: { current: () => ({ caller: { callerKind } }) },
      log: { info: vi.fn() },
      health,
      emit,
    },
    rpcCall,
    resolveDurableObject,
    emit,
    health,
  };
}

describe("@workspace-extensions/browser-data", () => {
  it("keeps sensitive methods shell-only inside the extension API", async () => {
    const { ctx } = makeContext("panel");
    const api = await activate(ctx as never);

    await expect(async () => api.getPasswords()).rejects.toMatchObject({ code: "EACCES" });
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
    );
    expect(rpcCall).toHaveBeenCalledWith(
      "do:natstack/internal:BrowserDataDO:global",
      "logImport",
      expect.objectContaining({ dataType: "bookmarks", itemsImported: 1 }),
    );
    expect(emit).toHaveBeenCalledWith("import-complete", expect.any(Array));
    expect(health.healthy).toHaveBeenLastCalledWith({ summary: "Browser data import completed" });
  });
});
