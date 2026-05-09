import { session } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import type { BrowserDataClient, StoredCookie } from "@natstack/browser-data";
import type { ManagedService } from "@natstack/shared/managedService";
import { BROWSER_SESSION_PARTITION } from "@natstack/shared/panelInterfaces";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import type { ServerClient } from "../serverClient.js";

const log = createDevLogger("BrowserSessionSync");
const SUBSCRIBER_ID = "browser-session-sync";

export function createBrowserSessionSyncService(deps: {
  eventService: EventService;
  serverClient: ServerClient;
  browserDataClient: BrowserDataClient;
}): ManagedService {
  let destroyed = false;

  const syncCookies = async () => {
    try {
      const cookies = await deps.browserDataClient.cookies.getByDomain();
      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      for (const cookie of cookies) {
        await browserSession.cookies.set(toElectronCookie(cookie));
      }
      log.info(`Synced ${cookies.length} imported cookie(s) into browser session`);
    } catch (err) {
      log.warn(`Cookie session sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const subscriber: Subscriber = {
    callerKind: "server",
    get isAlive() {
      return !destroyed;
    },
    send(channel, payload) {
      if (channel !== "event:browser-import-complete") return;
      const results = Array.isArray(payload) ? payload : [];
      if (!results.some((r) => isCookieImportSuccess(r))) return;
      void syncCookies();
    },
    isBoundTo: () => false,
    onDestroyed: () => {},
  };

  return {
    name: "browser-session-sync",
    async start() {
      deps.eventService.subscribe("browser-import-complete", SUBSCRIBER_ID, subscriber);
      await deps.serverClient.call("events", "subscribe", ["browser-import-complete"]).catch((err: unknown) => {
        log.warn(`Server event subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return { syncCookies };
    },
    async stop() {
      destroyed = true;
      deps.eventService.unsubscribe("browser-import-complete", SUBSCRIBER_ID);
      await deps.serverClient.call("events", "unsubscribe", ["browser-import-complete"]).catch(() => {});
    },
  };
}

function isCookieImportSuccess(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["dataType"] === "cookies" && record["success"] === true;
}

export function toElectronCookie(cookie: StoredCookie): Electron.CookiesSetDetails {
  const details: Electron.CookiesSetDetails = {
    url: deriveCookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure === 1,
    httpOnly: cookie.http_only === 1,
    expirationDate: cookie.expiration_date ?? undefined,
    sameSite: toElectronSameSite(cookie.same_site),
  };
  if (cookie.host_only !== 1) details.domain = cookie.domain;
  return details;
}

function deriveCookieUrl(cookie: StoredCookie): string {
  const scheme = cookie.secure === 1 ? "https" : "http";
  const host = cookie.domain.replace(/^\./, "");
  return `${scheme}://${host}${cookie.path || "/"}`;
}

function toElectronSameSite(value: string): Electron.CookiesSetDetails["sameSite"] {
  if (value === "no_restriction" || value === "lax" || value === "strict") return value;
  return "unspecified";
}
