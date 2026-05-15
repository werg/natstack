import type { ImportedPassword } from "../types.js";
import type { RecordHistoryVisitRequest, UpdateHistoryTitleRequest } from "../types.js";
import type { StoredBookmark, StoredCookie, StoredHistory, StoredPassword, StoredSearchEngine } from "../storage/types.js";

interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

const BROWSER_DATA_EXTENSION = "@workspace-extensions/browser-data";

export interface BrowserDataClient {
  cookies: {
    getByDomain(domain?: string): Promise<StoredCookie[]>;
  };
  history: {
    get(query: { limit: number }): Promise<StoredHistory[]>;
    searchForAutocomplete(query: string, limit?: number): Promise<StoredHistory[]>;
    recordVisit(request: RecordHistoryVisitRequest): Promise<number>;
    updateTitle(request: UpdateHistoryTitleRequest): Promise<void>;
  };
  bookmarks: {
    search(query: string): Promise<StoredBookmark[]>;
  };
  searchEngines: {
    getAll(): Promise<StoredSearchEngine[]>;
  };
  passwords: {
    getForOrigin(origin: string): Promise<StoredPassword[]>;
    updateLastUsed(id: number): Promise<void>;
    update(id: number, partial: Partial<{ username: string; password: string; actionUrl: string; realm: string }>): Promise<void>;
    add(password: { url: string; username: string; password: string; actionUrl?: string; realm?: string }): Promise<number>;
    addNeverSave(origin: string): Promise<void>;
    isNeverSave(origin: string): Promise<boolean>;
  };
}

export function createBrowserDataRpcClient(
  rpc: RpcLike,
): BrowserDataClient {
  // Browser data lives in the @workspace-extensions/browser-data extension —
  // calls go through the dispatcher's `extensions.invoke` relay rather than a
  // dedicated host service.
  const call = <T>(method: string, ...args: unknown[]) => {
    return rpc.call("extensions", "invoke", [
      BROWSER_DATA_EXTENSION,
      method,
      args,
    ]) as Promise<T>;
  };

  return {
    cookies: {
      getByDomain: (domain?: string) => call("getCookies", domain),
    },
    history: {
      get: (query: { limit: number }) => call("getHistory", query),
      searchForAutocomplete: (query: string, limit?: number) => call("searchHistoryForAutocomplete", { query, limit }),
      recordVisit: (request: RecordHistoryVisitRequest) => call("recordHistoryVisit", request),
      updateTitle: (request: UpdateHistoryTitleRequest) => call("updateHistoryTitle", request),
    },
    bookmarks: {
      search: (query: string) => call("searchBookmarks", query),
    },
    searchEngines: {
      getAll: () => call("getSearchEngines"),
    },
    passwords: {
      getForOrigin: (origin: string) => call("getPasswordForSite", origin),
      updateLastUsed: (id: number) => call<void>("updatePasswordLastUsed", id),
      update: (id: number, partial: Partial<ImportedPassword>) => call("updatePassword", id, partial),
      add: (password) => call("addPassword", password),
      addNeverSave: (origin: string) => call<void>("addNeverSavePassword", origin),
      isNeverSave: (origin: string) => call<boolean>("isNeverSavePassword", origin),
    },
  };
}
