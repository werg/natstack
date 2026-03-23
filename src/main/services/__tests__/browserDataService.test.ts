import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @natstack/browser-data
const { mockDetectBrowsers, mockRunImportPipeline, mockExportNetscapeBookmarks, mockExportChromiumBookmarks, mockExportCsvPasswords, mockExportNetscapeCookies, mockExportJson, mockDeriveCookieUrl } = vi.hoisted(() => ({
  mockDetectBrowsers: vi.fn(),
  mockRunImportPipeline: vi.fn(),
  mockExportNetscapeBookmarks: vi.fn(),
  mockExportChromiumBookmarks: vi.fn(),
  mockExportCsvPasswords: vi.fn(),
  mockExportNetscapeCookies: vi.fn(),
  mockExportJson: vi.fn(),
  mockDeriveCookieUrl: vi.fn().mockReturnValue("https://example.com/"),
}));

vi.mock("@natstack/browser-data", () => ({
  detectBrowsers: mockDetectBrowsers,
  runImportPipeline: mockRunImportPipeline,
  exportNetscapeBookmarks: mockExportNetscapeBookmarks,
  exportChromiumBookmarks: mockExportChromiumBookmarks,
  exportCsvPasswords: mockExportCsvPasswords,
  exportNetscapeCookies: mockExportNetscapeCookies,
  exportJson: mockExportJson,
  deriveCookieUrl: mockDeriveCookieUrl,
  ImportRequestSchema: { _def: {} },
  HistoryQuerySchema: { _def: {} },
  BookmarkSchema: { partial: () => ({}) },
  PasswordSchema: { partial: () => ({}) },
}));

// Mock electron
const mockCookiesSet = vi.fn().mockResolvedValue(undefined);
const mockCookiesGet = vi.fn().mockResolvedValue([]);
const mockBrowserSession = {
  cookies: {
    set: (...args: unknown[]) => mockCookiesSet(...args),
    get: (...args: unknown[]) => mockCookiesGet(...args),
  },
};
vi.mock("electron", () => ({
  session: {
    defaultSession: mockBrowserSession,
    fromPartition: () => mockBrowserSession,
  },
}));

import { createBrowserDataService } from "../browserDataService.js";
import type { EventService } from "../../../shared/eventsService.js";

function createMockStore() {
  return {
    bookmarks: {
      getByFolder: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      add: vi.fn().mockReturnValue(1),
      update: vi.fn(),
      delete: vi.fn(),
      move: vi.fn(),
      search: vi.fn().mockReturnValue([]),
    },
    history: {
      query: vi.fn().mockReturnValue([]),
      delete: vi.fn(),
      deleteRange: vi.fn().mockReturnValue(5),
      clearAll: vi.fn(),
      search: vi.fn().mockReturnValue([]),
    },
    passwords: {
      getAll: vi.fn().mockReturnValue([]),
      getForSite: vi.fn().mockReturnValue([]),
      add: vi.fn().mockReturnValue(1),
      update: vi.fn(),
      delete: vi.fn(),
    },
    cookies: {
      getByDomain: vi.fn().mockReturnValue([]),
      delete: vi.fn(),
      clearByDomain: vi.fn().mockReturnValue(3),
      clearAll: vi.fn().mockReturnValue(10),
      addBatch: vi.fn(),
    },
    autofill: {
      getSuggestions: vi.fn().mockReturnValue([]),
    },
    searchEngines: {
      getAll: vi.fn().mockReturnValue([]),
      setDefault: vi.fn(),
    },
    permissions: {
      get: vi.fn().mockReturnValue([]),
      set: vi.fn(),
    },
    importLog: {
      log: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
    },
    close: vi.fn(),
  };
}

function createMockEventService(): EventService & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as EventService & { emit: ReturnType<typeof vi.fn> };
}

describe("browserDataService", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let eventService: ReturnType<typeof createMockEventService>;
  let handler: (...args: any[]) => Promise<unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
    eventService = createMockEventService();
    const def = createBrowserDataService({
      eventService,
      browserDataStore: mockStore as any,
    });
    handler = def.handler;
  });

  // ---- Detection ----

  it("detectBrowsers delegates to the detection module", async () => {
    const browsers = [{ name: "chrome", displayName: "Google Chrome", profiles: [] }];
    mockDetectBrowsers.mockResolvedValue(browsers);

    const result = await handler({}, "detectBrowsers", []);
    expect(result).toEqual(browsers);
    expect(mockDetectBrowsers).toHaveBeenCalled();
  });

  // ---- Import ----

  it("startImport runs pipeline, logs results, and emits events", async () => {
    const importResults = [
      { dataType: "bookmarks", success: true, itemCount: 10, skippedCount: 0, warnings: [] },
      { dataType: "history", success: true, itemCount: 100, skippedCount: 2, warnings: ["some warning"] },
    ];
    mockRunImportPipeline.mockResolvedValue(importResults);

    const request = { browser: "chrome", profilePath: "/some/path", dataTypes: ["bookmarks", "history"] };
    const result = await handler({}, "startImport", [request]);

    expect(result).toEqual(importResults);
    expect(mockRunImportPipeline).toHaveBeenCalledWith(request, mockStore, expect.any(Function));

    // Should log each result
    expect(mockStore.importLog.log).toHaveBeenCalledTimes(2);
    expect(mockStore.importLog.log).toHaveBeenCalledWith({
      browser: "chrome",
      profilePath: "/some/path",
      dataType: "bookmarks",
      itemsImported: 10,
      itemsSkipped: 0,
      warnings: [],
    });

    // Should emit browser-import-complete
    expect(eventService.emit).toHaveBeenCalledWith("browser-import-complete", importResults);

    // Should emit browser-data-changed for each successful type
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "bookmarks" });
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "history" });
  });

  it("startImport auto-syncs cookies to session after cookie import", async () => {
    const storedCookies = [{
      name: "session_id", value: "abc123", domain: ".example.com",
      host_only: 0, path: "/", expiration_date: null, secure: 1,
      http_only: 0, same_site: "lax", source_scheme: "secure", source_port: 443,
    }];
    mockStore.cookies.getByDomain.mockReturnValue(storedCookies);

    const importResults = [
      { dataType: "cookies", success: true, itemCount: 5, skippedCount: 0, warnings: [] },
    ];
    mockRunImportPipeline.mockResolvedValue(importResults);

    await handler({}, "startImport", [
      { browser: "chrome", profilePath: "/path", dataTypes: ["cookies"] },
    ]);

    // Should have called electron session.cookies.set
    expect(mockCookiesSet).toHaveBeenCalled();
  });

  // ---- Bookmarks ----

  it("addBookmark returns ID and emits event", async () => {
    mockStore.bookmarks.add.mockReturnValue(42);
    const result = await handler({}, "addBookmark", [{
      title: "Test", url: "https://test.com",
    }]);

    expect(result).toBe(42);
    expect(mockStore.bookmarks.add).toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "bookmarks" });
  });

  it("deleteBookmark emits event", async () => {
    await handler({}, "deleteBookmark", [5]);
    expect(mockStore.bookmarks.delete).toHaveBeenCalledWith(5);
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "bookmarks" });
  });

  it("searchBookmarks passes query through", async () => {
    const bookmarks = [{ id: 1, title: "Test" }];
    mockStore.bookmarks.search.mockReturnValue(bookmarks);
    const result = await handler({}, "searchBookmarks", ["test"]);
    expect(result).toEqual(bookmarks);
    expect(mockStore.bookmarks.search).toHaveBeenCalledWith("test");
  });

  // ---- History ----

  it("clearAllHistory clears and emits event", async () => {
    await handler({}, "clearAllHistory", []);
    expect(mockStore.history.clearAll).toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "history" });
  });

  it("searchHistory passes query and limit", async () => {
    await handler({}, "searchHistory", ["github", 50]);
    expect(mockStore.history.search).toHaveBeenCalledWith("github", 50);
  });

  it("deleteHistoryRange emits event and returns count", async () => {
    const result = await handler({}, "deleteHistoryRange", [1000, 2000]);
    expect(result).toBe(5);
    expect(mockStore.history.deleteRange).toHaveBeenCalledWith(1000, 2000);
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "history" });
  });

  // ---- Passwords ----

  it("addPassword returns ID and emits event", async () => {
    mockStore.passwords.add.mockReturnValue(7);
    const result = await handler({}, "addPassword", [{
      url: "https://example.com", username: "user", password: "pass",
    }]);
    expect(result).toBe(7);
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "passwords" });
  });

  it("getPasswordForSite passes URL", async () => {
    await handler({}, "getPasswordForSite", ["https://example.com"]);
    expect(mockStore.passwords.getForSite).toHaveBeenCalledWith("https://example.com");
  });

  // ---- Cookie sync ----

  it("syncCookiesToSession pushes store cookies to electron session", async () => {
    const storedCookies = [{
      name: "token", value: "xyz", domain: ".example.com",
      host_only: 0, path: "/", expiration_date: 1700000000, secure: 1,
      http_only: 1, same_site: "strict", source_scheme: "secure", source_port: 443,
    }];
    mockStore.cookies.getByDomain.mockReturnValue(storedCookies);

    const result = await handler({}, "syncCookiesToSession", ["example.com"]);
    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(mockCookiesSet).toHaveBeenCalled();
  });

  it("syncCookiesFromSession pulls session cookies into store", async () => {
    mockCookiesGet.mockResolvedValue([
      { name: "session", value: "abc", domain: ".test.com", path: "/", secure: true, httpOnly: false, sameSite: "lax" },
    ]);

    const result = await handler({}, "syncCookiesFromSession", ["test.com"]);
    expect(result).toEqual({ synced: 1 });
    expect(mockStore.cookies.addBatch).toHaveBeenCalled();
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "cookies" });
  });

  it("syncCookiesFromSession skips internal _ns_ cookies", async () => {
    mockCookiesGet.mockResolvedValue([
      { name: "_ns_session", value: "internal", domain: ".natstack.local", path: "/" },
      { name: "real_cookie", value: "data", domain: ".test.com", path: "/" },
    ]);

    await handler({}, "syncCookiesFromSession", [undefined]);
    const addBatchCall = mockStore.cookies.addBatch.mock.calls[0]![0];
    expect(addBatchCall).toHaveLength(1);
    expect(addBatchCall[0].name).toBe("real_cookie");
  });

  // ---- Export ----

  it("exportBookmarks uses getAll() not getByFolder()", async () => {
    mockStore.bookmarks.getAll.mockReturnValue([
      { title: "Test", url: "https://test.com", date_added: 1000, date_modified: null, folder_path: "/Bar/", tags: null, keyword: null },
    ]);
    mockExportNetscapeBookmarks.mockReturnValue("<html>bookmarks</html>");

    await handler({}, "exportBookmarks", ["html"]);
    expect(mockStore.bookmarks.getAll).toHaveBeenCalled();
    expect(mockStore.bookmarks.getByFolder).not.toHaveBeenCalled();
    expect(mockExportNetscapeBookmarks).toHaveBeenCalled();
  });

  it("exportAll uses unlimited history query", async () => {
    mockStore.bookmarks.getAll.mockReturnValue([]);
    mockStore.history.query.mockReturnValue([]);
    mockStore.cookies.getByDomain.mockReturnValue([]);
    mockStore.passwords.getAll.mockReturnValue([]);
    mockExportJson.mockReturnValue("{}");

    await handler({}, "exportAll", []);
    expect(mockStore.history.query).toHaveBeenCalledWith({ limit: 2147483647 });
  });

  // ---- Permissions ----

  it("setPermission emits event", async () => {
    await handler({}, "setPermission", ["https://example.com", "notifications", "allow"]);
    expect(mockStore.permissions.set).toHaveBeenCalledWith("https://example.com", "notifications", "allow");
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "permissions" });
  });

  // ---- Search Engines ----

  it("setDefaultEngine emits event", async () => {
    await handler({}, "setDefaultEngine", [3]);
    expect(mockStore.searchEngines.setDefault).toHaveBeenCalledWith(3);
    expect(eventService.emit).toHaveBeenCalledWith("browser-data-changed", { dataType: "searchEngines" });
  });

  // ---- Error handling ----

  it("throws on unknown method", async () => {
    await expect(handler({}, "nonExistentMethod", [])).rejects.toThrow("Unknown browser-data method: nonExistentMethod");
  });
});
