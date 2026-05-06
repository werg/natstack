import { describe, expect, it } from "vitest";
import { createBrowserDataService } from "./browserDataService.js";
import type { DODispatch } from "../doDispatch.js";
import type { DORef } from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";

interface DispatchCall {
  ref: DORef;
  method: string;
  args: unknown[];
}

function fakeDODispatch(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls: DispatchCall[] = [];
  const dispatch = async (ref: DORef, method: string, ...args: unknown[]) => {
    calls.push({ ref, method, args });
    const handler = handlers[method];
    if (!handler) throw new Error(`unmocked DO method: ${method}`);
    return handler(...args);
  };
  return { calls, dispatch: dispatch as DODispatch["dispatch"] } as { calls: DispatchCall[]; dispatch: DODispatch["dispatch"] };
}

interface EmittedEvent { event: string; payload: unknown }

function fakeEventService() {
  const emitted: EmittedEvent[] = [];
  return {
    emitted,
    eventService: {
      emit(event: string, payload: unknown) { emitted.push({ event, payload }); },
    } as never,
  };
}

const ctx: ServiceContext = { callerId: "shell-1", callerKind: "shell" };

describe("browserDataService — handler routing", () => {
  it("translates RPC method names to DO method names for the never-save / last-used surface", async () => {
    const fake = fakeDODispatch({
      addNeverSave: () => undefined,
      isNeverSave: (origin: unknown) => origin === "https://example.test",
      updateLastUsed: () => undefined,
    });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    await svc.handler(ctx, "addNeverSavePassword", ["https://example.test"]);
    await svc.handler(ctx, "updatePasswordLastUsed", [42]);
    const isNever = await svc.handler(ctx, "isNeverSavePassword", ["https://example.test"]);

    expect(fake.calls.map(c => c.method)).toEqual(["addNeverSave", "updateLastUsed", "isNeverSave"]);
    expect(fake.calls[0]!.args).toEqual(["https://example.test"]);
    expect(fake.calls[1]!.args).toEqual([42]);
    expect(fake.calls[2]!.args).toEqual(["https://example.test"]);
    expect(isNever).toBe(true);
  });

  it("emits browser-data-changed for mutating operations", async () => {
    const fake = fakeDODispatch({
      addBookmark: () => 7,
      deleteBookmark: () => undefined,
      clearAllHistory: () => undefined,
      deletePassword: () => undefined,
      addNeverSave: () => undefined,
      setPermission: () => undefined,
      clearCookies: () => 3,
    });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    await svc.handler(ctx, "addBookmark", [{ title: "ex", folderPath: "/", dateAdded: 1 }]);
    await svc.handler(ctx, "deleteBookmark", [7]);
    await svc.handler(ctx, "clearAllHistory", []);
    await svc.handler(ctx, "deletePassword", [11]);
    await svc.handler(ctx, "addNeverSavePassword", ["https://x.test"]);
    await svc.handler(ctx, "setPermission", ["https://x.test", "geolocation", "deny"]);
    await svc.handler(ctx, "clearCookies", ["x.test"]);

    expect(evt.emitted.map(e => (e.payload as { dataType: string }).dataType)).toEqual([
      "bookmarks",
      "bookmarks",
      "history",
      "passwords",
      "passwords",
      "permissions",
      "cookies",
    ]);
    expect(evt.emitted.every(e => e.event === "browser-data-changed")).toBe(true);
  });

  it("does not emit browser-data-changed for pure reads", async () => {
    const fake = fakeDODispatch({
      getBookmarks: () => [{ id: 1, title: "x" }],
      getHistory: () => [],
      searchHistory: () => [],
      getPasswords: () => [],
      getPasswordForSite: () => [],
      getAutofillSuggestions: () => [],
      getSearchEngines: () => [],
      getPermissions: () => [],
      getCookies: () => [],
      getImportHistory: () => [],
      isNeverSave: () => false,
    });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    await svc.handler(ctx, "getBookmarks", [undefined]);
    await svc.handler(ctx, "getHistory", [{ limit: 10 }]);
    await svc.handler(ctx, "searchHistory", ["query", 5]);
    await svc.handler(ctx, "getPasswords", []);
    await svc.handler(ctx, "getPasswordForSite", ["https://x.test"]);
    await svc.handler(ctx, "getAutofillSuggestions", ["email"]);
    await svc.handler(ctx, "getSearchEngines", []);
    await svc.handler(ctx, "getPermissions", []);
    await svc.handler(ctx, "getCookies", []);
    await svc.handler(ctx, "getImportHistory", []);
    await svc.handler(ctx, "isNeverSavePassword", ["https://x.test"]);

    expect(evt.emitted).toHaveLength(0);
  });

  it("translates DO bookmark rows into Netscape HTML and Chromium JSON exports", async () => {
    const allBookmarks = [
      { id: 1, title: "Example", url: "https://example.test", folder_path: "/", date_added: 1700000000000, tags: '["news"]', keyword: null },
      { id: 2, title: "Docs", url: "https://docs.test", folder_path: "/Reference", date_added: 1700000001000, tags: null, keyword: "docs" },
    ];
    const fake = fakeDODispatch({ getAllBookmarks: () => allBookmarks });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    const html = (await svc.handler(ctx, "exportBookmarks", ["html"])) as string;
    expect(html).toContain("<DL>");
    expect(html).toContain("https://example.test");
    expect(html).toContain("https://docs.test");

    const chromeJson = (await svc.handler(ctx, "exportBookmarks", ["chrome-json"])) as string;
    const chrome = JSON.parse(chromeJson) as Record<string, unknown>;
    expect(typeof chrome).toBe("object");

    const json = (await svc.handler(ctx, "exportBookmarks", ["json"])) as string;
    const arr = JSON.parse(json) as Array<{ title: string; url: string }>;
    expect(arr.map(b => b.title)).toEqual(["Example", "Docs"]);
  });

  it("exports passwords in chrome and firefox CSV formats", async () => {
    const passwords = [
      { id: 1, origin_url: "https://example.test", username: "alice", password: "p@ss", action_url: "https://example.test/login", realm: "" },
      { id: 2, origin_url: "https://other.test", username: "bob", password: "secret", action_url: "", realm: "Other" },
    ];
    const fake = fakeDODispatch({ getPasswords: () => passwords });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    const chromeCsv = (await svc.handler(ctx, "exportPasswords", ["csv-chrome"])) as string;
    expect(chromeCsv.split("\n")[0]).toMatch(/name|url|username|password/i);
    expect(chromeCsv).toContain("alice");
    expect(chromeCsv).toContain("bob");

    const firefoxCsv = (await svc.handler(ctx, "exportPasswords", ["csv-firefox"])) as string;
    expect(firefoxCsv).toContain("alice");
    expect(firefoxCsv).toContain("bob");
  });

  it("aggregates a full browser-data export bundle", async () => {
    const fake = fakeDODispatch({
      getAllBookmarks: () => [{ id: 1, title: "B", url: "https://b.test", folder_path: "/", date_added: 1, tags: null, keyword: null }],
      getHistory: (q: unknown) => {
        expect((q as { limit: number }).limit).toBe(2147483647);
        return [{ id: 1, url: "https://h.test", title: "H", visit_count: 3, last_visit: 1700000000000 }];
      },
      getCookies: () => [{ name: "c", value: "v", domain: "x.test", host_only: 1, path: "/", expiration_date: null, secure: 1, http_only: 0, same_site: "lax", source_scheme: "secure", source_port: 443 }],
      getPasswords: () => [{ id: 1, origin_url: "https://p.test", username: "u", password: "p", action_url: null, realm: null }],
    });
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });

    const bundleJson = (await svc.handler(ctx, "exportAll", [])) as string;
    const bundle = JSON.parse(bundleJson) as {
      version: number;
      bookmarks: unknown[];
      history: unknown[];
      cookies: Array<{ name: string; secure: boolean }>;
      passwords: unknown[];
    };
    expect(bundle.version).toBe(1);
    expect(bundle.bookmarks).toHaveLength(1);
    expect(bundle.history).toHaveLength(1);
    expect(bundle.cookies[0]!.secure).toBe(true);
    expect(bundle.passwords).toHaveLength(1);
  });

  it("rejects unknown methods", async () => {
    const fake = fakeDODispatch({});
    const evt = fakeEventService();
    const svc = createBrowserDataService({ eventService: evt.eventService, doDispatch: { dispatch: fake.dispatch } as DODispatch });
    await expect(svc.handler(ctx, "nonexistent", [])).rejects.toThrow(/Unknown browser-data method/);
  });
});
