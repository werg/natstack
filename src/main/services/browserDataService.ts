import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { EventService } from "@natstack/shared/eventsService";
import type { BrowserDataStore } from "@natstack/browser-data";
import {
  detectBrowsers,
  runImportPipeline,
  ImportRequestSchema,
  HistoryQuerySchema,
  BookmarkSchema,
  PasswordSchema,
  exportNetscapeBookmarks,
  exportChromiumBookmarks,
  exportCsvPasswords,
  exportNetscapeCookies,
  exportJson,
  deriveCookieUrl,
  resolveProfilePath,
} from "@natstack/browser-data";
import type {
  ImportRequest,
  ImportedBookmark,
  ImportedCookie,
  ImportedPassword,
  SameSiteValue,
  SourceScheme,
} from "@natstack/browser-data";
import { BROWSER_SESSION_PARTITION } from "@natstack/shared/panelInterfaces";

function storedCookieToImported(c: {
  name: string;
  value: string;
  domain: string;
  host_only: number;
  path: string;
  expiration_date: number | null;
  secure: number;
  http_only: number;
  same_site: string;
  source_scheme: string | null;
  source_port: number;
}): ImportedCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: c.host_only === 1,
    path: c.path,
    expirationDate: c.expiration_date ?? undefined,
    secure: c.secure === 1,
    httpOnly: c.http_only === 1,
    sameSite: (c.same_site as SameSiteValue) || "unspecified",
    sourceScheme: (c.source_scheme as SourceScheme) || "unset",
    sourcePort: c.source_port,
  };
}

/**
 * Push cookies from the browser-data store into an Electron session.
 * Skips NatStack's internal cookies (_ns_session, _ns_boot_*).
 */
async function syncStoreCookiesToSession(
  browserDataStore: BrowserDataStore,
  domain?: string,
): Promise<{ synced: number; failed: number }> {
  const { session } = await import("electron");
  const ses = session.fromPartition(BROWSER_SESSION_PARTITION);
  const storedCookies = browserDataStore.cookies.getByDomain(domain);
  let synced = 0;
  let failed = 0;

  for (const c of storedCookies) {
    // Skip NatStack internal cookies
    if (c.name.startsWith("_ns_")) continue;
    // Skip cookies with empty values (failed decryption)
    if (!c.value) continue;

    const imported = storedCookieToImported(c);
    const url = deriveCookieUrl(imported);

    try {
      const details: Electron.CookiesSetDetails = {
        url,
        name: imported.name,
        value: imported.value,
        path: imported.path,
        secure: imported.secure,
        httpOnly: imported.httpOnly,
        sameSite: imported.sameSite === "unspecified" ? "no_restriction" : imported.sameSite,
      };
      // Only set domain for domain cookies (leading dot = applies to subdomains)
      if (!imported.hostOnly) {
        details.domain = imported.domain;
      }
      if (imported.expirationDate != null) {
        details.expirationDate = imported.expirationDate;
      }
      await ses.cookies.set(details);
      synced++;
    } catch {
      failed++;
    }
  }

  return { synced, failed };
}

/**
 * Pull cookies from an Electron session into the browser-data store.
 */
async function syncSessionCookiesToStore(
  browserDataStore: BrowserDataStore,
  domain?: string,
): Promise<{ synced: number }> {
  const { session } = await import("electron");
  const ses = session.fromPartition(BROWSER_SESSION_PARTITION);

  const filter: Electron.CookiesGetFilter = {};
  if (domain) filter.domain = domain;
  const sessionCookies = await ses.cookies.get(filter);

  const imported: ImportedCookie[] = [];
  for (const c of sessionCookies) {
    // Skip NatStack internal cookies
    if (c.name.startsWith("_ns_")) continue;

    imported.push({
      name: c.name,
      value: c.value,
      domain: c.domain ?? "",
      hostOnly: !c.domain?.startsWith("."),
      path: c.path ?? "/",
      expirationDate: c.expirationDate,
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      sameSite: (c.sameSite as SameSiteValue) ?? "unspecified",
      sourceScheme: c.secure ? "secure" : "non_secure",
      sourcePort: c.secure ? 443 : 80,
    });
  }

  browserDataStore.cookies.addBatch(imported);
  return { synced: imported.length };
}

export function createBrowserDataService(deps: {
  eventService: EventService;
  browserDataStore: BrowserDataStore;
}): ServiceDefinition {
  const { eventService, browserDataStore } = deps;

  return {
    name: "browser-data",
    description: "Browser data import, export, and management",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      // Detection
      detectBrowsers: { args: z.tuple([]) },

      // Import
      startImport: { args: z.tuple([ImportRequestSchema]) },
      getImportHistory: { args: z.tuple([]) },

      // Bookmarks CRUD
      getBookmarks: { args: z.tuple([z.string().optional()]) },
      addBookmark: { args: z.tuple([BookmarkSchema]) },
      updateBookmark: { args: z.tuple([z.number(), BookmarkSchema.partial()]) },
      deleteBookmark: { args: z.tuple([z.number()]) },
      moveBookmark: { args: z.tuple([z.number(), z.string(), z.number()]) },
      searchBookmarks: { args: z.tuple([z.string()]) },

      // History
      getHistory: { args: z.tuple([HistoryQuerySchema]) },
      deleteHistoryEntry: { args: z.tuple([z.number()]) },
      deleteHistoryRange: { args: z.tuple([z.number(), z.number()]) },
      clearAllHistory: { args: z.tuple([]) },
      searchHistory: { args: z.tuple([z.string(), z.number().optional()]) },

      // Passwords
      getPasswords: { args: z.tuple([]) },
      getPasswordForSite: { args: z.tuple([z.string()]) },
      addPassword: { args: z.tuple([PasswordSchema]) },
      updatePassword: { args: z.tuple([z.number(), PasswordSchema.partial()]) },
      deletePassword: { args: z.tuple([z.number()]) },

      // Autofill
      getAutofillSuggestions: {
        args: z.tuple([z.string(), z.string().optional()]),
      },

      // Search Engines
      getSearchEngines: { args: z.tuple([]) },
      setDefaultEngine: { args: z.tuple([z.number()]) },

      // Permissions
      getPermissions: { args: z.tuple([z.string().optional()]) },
      setPermission: { args: z.tuple([z.string(), z.string(), z.string()]) },

      // Export
      exportBookmarks: {
        args: z.tuple([z.enum(["html", "json", "chrome-json"])]),
      },
      exportPasswords: {
        args: z.tuple([z.enum(["csv-chrome", "csv-firefox", "json"])]),
      },
      exportCookies: {
        args: z.tuple([z.enum(["json", "netscape-txt"])]),
      },
      exportAll: { args: z.tuple([]) },

      // Cookies
      getCookies: { args: z.tuple([z.string().optional()]) },
      deleteCookie: { args: z.tuple([z.number()]) },
      clearCookies: { args: z.tuple([z.string().optional()]) },
      syncCookiesToSession: { args: z.tuple([z.string().optional()]) },
      syncCookiesFromSession: { args: z.tuple([z.string().optional()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        // ---- Detection ----
        case "detectBrowsers":
          return detectBrowsers();

        // ---- Import ----
        case "startImport": {
          const [request] = args as [ImportRequest];
          const profilePath = resolveProfilePath(request);
          const results = await runImportPipeline(
            request,
            browserDataStore,
            (progress) => {
              eventService.emit("browser-import-progress", progress);
            },
          );

          // Log imports
          for (const result of results) {
            browserDataStore.importLog.log({
              browser: request.browser,
              profilePath,
              dataType: result.dataType,
              itemsImported: result.itemCount,
              itemsSkipped: result.skippedCount,
              warnings: result.warnings,
            });
          }

          eventService.emit("browser-import-complete", results);
          // Notify UI of changed data types
          for (const result of results) {
            if (result.success) {
              eventService.emit("browser-data-changed", { dataType: result.dataType });
            }
          }

          // Auto-sync imported cookies into the Electron session
          const cookieResult = results.find(
            (r) => r.dataType === "cookies" && r.success && r.itemCount > 0,
          );
          if (cookieResult) {
            try {
              await syncStoreCookiesToSession(browserDataStore);
            } catch (err) {
              console.error("[browser-data] Cookie session sync failed after import:", err);
              cookieResult.warnings.push(
                `Cookies imported to store but session sync failed: ${err instanceof Error ? err.message : String(err)}. ` +
                `Use syncCookiesToSession() to retry.`,
              );
            }
          }

          return results;
        }

        case "getImportHistory":
          return browserDataStore.importLog.getAll();

        // ---- Bookmarks ----
        case "getBookmarks": {
          const [folderPath] = args as [string | undefined];
          return browserDataStore.bookmarks.getByFolder(folderPath || "/");
        }
        case "addBookmark": {
          const [bookmark] = args as [
            z.infer<typeof BookmarkSchema>,
          ];
          const bookmarkId = browserDataStore.bookmarks.add({
            title: bookmark.title,
            url: bookmark.url,
            folderPath: bookmark.folderPath || "/",
            dateAdded: bookmark.dateAdded || Date.now(),
            tags: bookmark.tags,
            keyword: bookmark.keyword,
            position: bookmark.position || 0,
          });
          eventService.emit("browser-data-changed", { dataType: "bookmarks" });
          return bookmarkId;
        }
        case "updateBookmark": {
          const [id, partial] = args as [number, Partial<z.infer<typeof BookmarkSchema>>];
          browserDataStore.bookmarks.update(id, partial);
          eventService.emit("browser-data-changed", { dataType: "bookmarks" });
          return;
        }
        case "deleteBookmark": {
          const [id] = args as [number];
          browserDataStore.bookmarks.delete(id);
          eventService.emit("browser-data-changed", { dataType: "bookmarks" });
          return;
        }
        case "moveBookmark": {
          const [id, folder, position] = args as [number, string, number];
          browserDataStore.bookmarks.move(id, folder, position);
          eventService.emit("browser-data-changed", { dataType: "bookmarks" });
          return;
        }
        case "searchBookmarks": {
          const [query] = args as [string];
          return browserDataStore.bookmarks.search(query);
        }

        // ---- History ----
        case "getHistory": {
          const [query] = args as [z.infer<typeof HistoryQuerySchema>];
          return browserDataStore.history.query(query);
        }
        case "deleteHistoryEntry": {
          const [id] = args as [number];
          browserDataStore.history.delete(id);
          eventService.emit("browser-data-changed", { dataType: "history" });
          return;
        }
        case "deleteHistoryRange": {
          const [start, end] = args as [number, number];
          const deleted = browserDataStore.history.deleteRange(start, end);
          eventService.emit("browser-data-changed", { dataType: "history" });
          return deleted;
        }
        case "clearAllHistory":
          browserDataStore.history.clearAll();
          eventService.emit("browser-data-changed", { dataType: "history" });
          return;
        case "searchHistory": {
          const [query, limit] = args as [string, number | undefined];
          return browserDataStore.history.search(query, limit);
        }

        // ---- Passwords ----
        case "getPasswords":
          return browserDataStore.passwords.getAll();
        case "getPasswordForSite": {
          const [url] = args as [string];
          return browserDataStore.passwords.getForSite(url);
        }
        case "addPassword": {
          const [pw] = args as [z.infer<typeof PasswordSchema>];
          const pwId = browserDataStore.passwords.add(pw);
          eventService.emit("browser-data-changed", { dataType: "passwords" });
          return pwId;
        }
        case "updatePassword": {
          const [id, partial] = args as [number, Partial<z.infer<typeof PasswordSchema>>];
          browserDataStore.passwords.update(id, partial);
          eventService.emit("browser-data-changed", { dataType: "passwords" });
          return;
        }
        case "deletePassword": {
          const [id] = args as [number];
          browserDataStore.passwords.delete(id);
          eventService.emit("browser-data-changed", { dataType: "passwords" });
          return;
        }

        // ---- Autofill ----
        case "getAutofillSuggestions": {
          const [fieldName, prefix] = args as [string, string | undefined];
          return browserDataStore.autofill.getSuggestions(fieldName, prefix);
        }

        // ---- Search Engines ----
        case "getSearchEngines":
          return browserDataStore.searchEngines.getAll();
        case "setDefaultEngine": {
          const [id] = args as [number];
          browserDataStore.searchEngines.setDefault(id);
          eventService.emit("browser-data-changed", { dataType: "searchEngines" });
          return;
        }

        // ---- Permissions ----
        case "getPermissions": {
          const [origin] = args as [string | undefined];
          return browserDataStore.permissions.get(origin);
        }
        case "setPermission": {
          const [origin, permission, setting] = args as [string, string, string];
          browserDataStore.permissions.set(
            origin,
            permission,
            setting as "allow" | "block" | "ask",
          );
          eventService.emit("browser-data-changed", { dataType: "permissions" });
          return;
        }

        // ---- Export ----
        case "exportBookmarks": {
          const [format] = args as ["html" | "json" | "chrome-json"];
          const allBookmarks = browserDataStore.bookmarks.getAll();
          const imported: ImportedBookmark[] = allBookmarks.map((b) => ({
            title: b.title,
            url: b.url || "",
            dateAdded: b.date_added,
            dateModified: b.date_modified || undefined,
            folder: b.folder_path
              .split("/")
              .filter((s) => s.length > 0),
            tags: b.tags ? (JSON.parse(b.tags) as string[]) : undefined,
            keyword: b.keyword || undefined,
          }));

          if (format === "html") return exportNetscapeBookmarks(imported);
          if (format === "chrome-json") return exportChromiumBookmarks(imported);
          return JSON.stringify(imported, null, 2);
        }
        case "exportPasswords": {
          const [format] = args as ["csv-chrome" | "csv-firefox" | "json"];
          const allPasswords = browserDataStore.passwords.getAll();
          const imported: ImportedPassword[] = allPasswords.map((p) => ({
            url: p.origin_url,
            username: p.username,
            password: p.password,
            actionUrl: p.action_url || undefined,
            realm: p.realm || undefined,
          }));

          if (format === "csv-chrome")
            return exportCsvPasswords(imported, "chrome");
          if (format === "csv-firefox")
            return exportCsvPasswords(imported, "firefox");
          return JSON.stringify(imported, null, 2);
        }
        case "exportCookies": {
          const [format] = args as ["json" | "netscape-txt"];
          const allCookies = browserDataStore.cookies.getByDomain();
          const mappedCookies = allCookies.map(storedCookieToImported);
          if (format === "netscape-txt") return exportNetscapeCookies(mappedCookies);
          return JSON.stringify(mappedCookies, null, 2);
        }
        case "exportAll": {
          const bookmarks = browserDataStore.bookmarks.getAll();
          const history = browserDataStore.history.query({ limit: 2147483647 });
          const cookies = browserDataStore.cookies.getByDomain();
          const passwords = browserDataStore.passwords.getAll();
          return exportJson({
            exportedAt: new Date().toISOString(),
            version: 1,
            bookmarks: bookmarks.map((b) => ({
              title: b.title,
              url: b.url || "",
              dateAdded: b.date_added,
              folder: b.folder_path.split("/").filter((s) => s.length > 0),
            })),
            history: history.map((h) => ({
              url: h.url,
              title: h.title || "",
              visitCount: h.visit_count,
              lastVisitTime: h.last_visit,
            })),
            cookies: cookies.map(storedCookieToImported),
            passwords: passwords.map((p) => ({
              url: p.origin_url,
              username: p.username,
              password: p.password,
            })),
          });
        }

        // ---- Cookies ----
        case "getCookies": {
          const [domain] = args as [string | undefined];
          return browserDataStore.cookies.getByDomain(domain);
        }
        case "deleteCookie": {
          const [id] = args as [number];
          browserDataStore.cookies.delete(id);
          eventService.emit("browser-data-changed", { dataType: "cookies" });
          return;
        }
        case "clearCookies": {
          const [domain] = args as [string | undefined];
          const cleared = domain
            ? browserDataStore.cookies.clearByDomain(domain)
            : browserDataStore.cookies.clearAll();
          eventService.emit("browser-data-changed", { dataType: "cookies" });
          return cleared;
        }
        case "syncCookiesToSession": {
          const [domain] = args as [string | undefined];
          return syncStoreCookiesToSession(browserDataStore, domain);
        }
        case "syncCookiesFromSession": {
          const [domain] = args as [string | undefined];
          const result = await syncSessionCookiesToStore(browserDataStore, domain);
          eventService.emit("browser-data-changed", { dataType: "cookies" });
          return result;
        }

        default:
          throw new Error(`Unknown browser-data method: ${method}`);
      }
    },
  };
}
