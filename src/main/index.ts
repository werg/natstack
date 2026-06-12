import {
  app,
  dialog,
  BaseWindow,
  nativeTheme,
  session,
  ipcMain,
  shell,
  type Session,
  type WebContents,
} from "electron";
import * as path from "path";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { createDevLogger } from "@natstack/dev-log";
import {
  enqueueFirstArgvLink,
  getPendingConnectLink,
  installEarlyOpenUrlBuffer,
  onConnectLink,
  registerProtocol,
} from "./protocolHandler.js";

const log = createDevLogger("App");
const APP_NAME = "NatStack";
const APP_SHUTDOWN_TIMEOUT_MS = 15_000;
const IS_HEADLESS_HOST =
  process.env["NATSTACK_HEADLESS_HOST"] === "1" || process.argv.includes("--headless-host");

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function logSuppressedErrorDialog(title: string, content: string): void {
  console.error(`[App] Suppressed error dialog: ${title}\n${content}`);
}

// Electron's default main-process exception handling can show a blocking
// "A JavaScript Error Occurred in the main process" alert. NatStack should log
// these errors instead of interrupting the user with generic native dialogs.
process.on("uncaughtException", (error) => {
  console.error("[App] Uncaught exception in main process:", formatUnknownError(error));
});
process.on("unhandledRejection", (reason) => {
  console.error("[App] Unhandled rejection in main process:", formatUnknownError(reason));
});
dialog.showErrorBox = logSuppressedErrorDialog;

app.setName(APP_NAME);

import { PanelRegistry } from "@natstack/shared/panelRegistry";
import { asPanelSlotId } from "@natstack/shared/panel/ids";
import { getPanelSource } from "@natstack/shared/panel/accessors";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { panelLogMethods } from "@natstack/shared/serviceSchemas/panelLog";
import { corsApprovalMethods } from "@natstack/shared/serviceSchemas/corsApproval";
import { externalOpenMethods } from "@natstack/shared/serviceSchemas/externalOpen";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { PanelOrchestrator } from "./panelOrchestrator.js";
import { PanelView } from "./panelView.js";
import { AppOrchestrator } from "./appOrchestrator.js";
import { resolveElectronViewCaller } from "./callerResolution.js";
import { BrowserHistoryRecorder } from "./browserHistoryRecorder.js";
import {
  setupMenu,
  setMenuPanelLifecycle,
  setMenuPanelRegistry,
  setMenuViewManager,
  setMenuEventService,
} from "./menu.js";
import { getAppRoot, getResourcesPath } from "./paths.js";
import { loadCentralEnv, deleteWorkspaceDir } from "@natstack/shared/workspace/loader";
import { CentralDataManager } from "@natstack/shared/centralData";
import {
  resolveStartupMode,
  resolveLocalStartupMode,
  shouldRequestSingleInstanceLock,
  getRemoteUserDataDir,
  type StartupMode,
} from "./startupMode.js";
import { establishServerSession, type SessionConnection } from "./serverSession.js";
import type { ServerClient } from "./serverClient.js";
import { CdpHostProvider } from "./cdpHostProvider.js";
import { EventService } from "@natstack/shared/eventsService";
import type { EventName } from "@natstack/shared/events";
import { createServerEventBridge } from "./serverEventBridge.js";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";
import { createApprovalAttention, type ApprovalAttention } from "./approvalAttention.js";
import type { PendingApproval } from "@natstack/shared/approvals";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";
import { installPinnedTlsForAllPartitions } from "./tlsPinning.js";
import { BROWSER_SESSION_PARTITION } from "@natstack/shared/panelInterfaces";

const eventService = new EventService();
import { ViewManager } from "./viewManager.js";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  parseServiceMethod,
  type ServiceContext,
} from "@natstack/shared/serviceDispatcher";
import { autofillMethods } from "@natstack/shared/serviceSchemas/autofill";
import { ServiceContainer } from "@natstack/shared/serviceContainer";
import { createEventsServiceDefinition } from "@natstack/shared/eventsService";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { startMemoryMonitor, setMemoryMonitorViewManager } from "./memoryMonitor.js";
// ServerProcessManager and createServerClient are now used by serverSession.ts
import { assertPresent } from "../lintHelpers";

// =============================================================================
// Early Diagnostics (enabled via NATSTACK_DEBUG_PATHS=1)
// =============================================================================

if (process.env["NATSTACK_DEBUG_PATHS"] === "1") {
  console.log("=".repeat(60));
  console.log("[diagnostics] NatStack startup diagnostics");
  console.log("[diagnostics] process.platform:", process.platform);
  console.log("[diagnostics] process.arch:", process.arch);
  console.log("[diagnostics] process.cwd():", process.cwd());
  console.log("[diagnostics] process.execPath:", process.execPath);
  console.log("[diagnostics] app.getAppPath():", app.getAppPath());
  console.log("[diagnostics] app.getPath('userData'):", app.getPath("userData"));
  console.log("[diagnostics] NODE_ENV:", process.env["NODE_ENV"]);
  console.log("[diagnostics] isDev():", isDev());
  console.log("[diagnostics] getAppRoot():", getAppRoot());
  console.log("=".repeat(60));
}

// =============================================================================
// GPU/Compositor Flags (optional, must happen before app ready)
// =============================================================================

// If WebContentsViews become transparent after extended idle periods (compositor stalls),
// try enabling these flags. The 3-second keepalive in ViewManager should handle this,
// but these are a more aggressive fallback if needed.
// app.commandLine.appendSwitch("disable-renderer-backgrounding");
// app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// =============================================================================
// Configuration Initialization
// =============================================================================

// Load central environment variables first (.env from ~/.config/natstack/)
loadCentralEnv();

const centralData = new CentralDataManager();
let startupMode: StartupMode;
let workspaceId: string = "unknown";

try {
  startupMode = resolveStartupMode(centralData);
} catch (error) {
  console.error("[Workspace] Failed to initialize workspace:", error);
  app.quit();
  process.exit(1);
}

if (
  shouldRequestSingleInstanceLock(startupMode, {
    isHeadlessHost: IS_HEADLESS_HOST,
    isDevelopment: isDev(),
  }) &&
  !app.requestSingleInstanceLock()
) {
  app.exit(0);
  process.exit(0);
}
registerProtocol();
installEarlyOpenUrlBuffer();
enqueueFirstArgvLink(process.argv);

if (startupMode.kind === "local") {
  workspaceId = startupMode.workspaceId;
  app.setPath(
    "userData",
    path.join(startupMode.wsDir, IS_HEADLESS_HOST ? "state-headless-host" : "state")
  );
} else {
  app.setPath(
    "userData",
    IS_HEADLESS_HOST ? path.join(getRemoteUserDataDir(), "headless-host") : getRemoteUserDataDir()
  );
}

installRemoteTlsPinning(startupMode);

function applyLocalStartupMode(reason: string): void {
  const localMode = resolveLocalStartupMode(centralData);
  startupMode = localMode;
  workspaceId = localMode.workspaceId;
  app.setPath(
    "userData",
    path.join(localMode.wsDir, IS_HEADLESS_HOST ? "state-headless-host" : "state")
  );
  log.warn(`[Workspace] Falling back to local mode: ${reason}`);
}

function shouldFallbackToLocalForRemoteCredential(error: unknown): boolean {
  if (startupMode.kind !== "remote" || startupMode.bootstrap !== "device") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /Device credential expired or revoked|re-pair from the server/i.test(message);
}

let cdpHostProvider: CdpHostProvider | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelOrchestrator: PanelOrchestrator | null = null;
let panelView: PanelView | null = null;
let appOrchestrator: AppOrchestrator | null = null;
let shellCore: ReturnType<
  typeof import("./shellCore/createElectronShellCore.js").createElectronShellCore
> | null = null;
let serverSession: SessionConnection | null = null;
let mainWindow: BaseWindow | null = null;
let viewManager: ViewManager | null = null;
let approvalAttention: ApprovalAttention | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler
let autofillManager: import("./autofill/autofillManager.js").AutofillManager | null = null;
const corsApprovalCache = new Set<string>();
const pendingCorsApprovals = new Map<string, Promise<{ allowed: boolean; cacheable: boolean }>>();
let browserDataStoreForCredentialCapture: {
  cookies: {
    getByDomain(domain?: string): Promise<
      Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expiration_date: number | null;
        secure: number;
        http_only: number;
        same_site: string;
      }>
    >;
  };
} | null = null;

type AppCapability = import("@natstack/shared/unitManifest").AppCapability;

const APP_FS_READ_METHODS = new Set([
  "readFile",
  "readdir",
  "stat",
  "lstat",
  "exists",
  "realpath",
  "readlink",
  "handleRead",
  "handleStat",
]);

const APP_FS_WRITE_METHODS = new Set([
  "writeFile",
  "appendFile",
  "mkdir",
  "rmdir",
  "rm",
  "unlink",
  "rename",
  "truncate",
  "chmod",
  "chown",
  "utimes",
  "handleWrite",
  "mktemp",
  "symlink",
]);

function openFlagsRequireWrite(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return true;
  if (typeof flags !== "string") return true;
  return flags.includes("w") || flags.includes("a") || flags.includes("+");
}

function appFsCapabilitiesForMethod(
  method: string,
  args: readonly unknown[]
): readonly AppCapability[] {
  if (APP_FS_READ_METHODS.has(method)) return ["fs-read"];
  if (APP_FS_WRITE_METHODS.has(method)) return ["fs-write"];
  if (method === "copyFile") return ["fs-read", "fs-write"];
  if (method === "handleClose") return [];
  if (method === "access") {
    const mode = typeof args[1] === "number" ? args[1] : 0;
    return mode & 2 ? ["fs-write"] : ["fs-read"];
  }
  if (method === "open") return [openFlagsRequireWrite(args[1]) ? "fs-write" : "fs-read"];
  throw new Error(`Unsupported app fs method: ${method}`);
}

function authorizeAppServerCall(
  callerId: string,
  service: string,
  method: string,
  args: readonly unknown[]
): void {
  if (service !== "fs") return;
  const required = appFsCapabilitiesForMethod(method, args);
  if (required.length === 0) return;
  const viewInfo = viewManager?.getViewInfo(callerId);
  if (viewInfo?.type !== "app") {
    throw new Error(`fs.${method} requires an active app view for ${callerId}`);
  }
  for (const capability of required) {
    if (!viewInfo.capabilities.includes(capability)) {
      throw new Error(`fs.${method} requires app capability '${capability}' for ${callerId}`);
    }
  }
}

const INCOMING_PAIR_LINK_CAPABILITY: AppCapability = "incoming-pair-links";

function canAccessIncomingPairLinks(webContentsId: number): boolean {
  if (!viewManager) return false;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
    return true;
  }
  const viewId = viewManager.findViewIdByWebContentsId(webContentsId);
  if (!viewId) return false;
  const viewInfo = viewManager.getViewInfo(viewId);
  return viewInfo?.type === "app" && viewInfo.capabilities.includes(INCOMING_PAIR_LINK_CAPABILITY);
}

function sendIncomingPairLink(link: unknown): void {
  if (!viewManager) return;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed()) {
    shellContents.send("natstack:incoming-pair-link", link);
  }
  for (const viewId of viewManager.getViewIds()) {
    if (viewId === "shell") continue;
    const viewInfo = viewManager.getViewInfo(viewId);
    if (
      viewInfo?.type !== "app" ||
      !viewInfo.capabilities.includes(INCOMING_PAIR_LINK_CAPABILITY)
    ) {
      continue;
    }
    const contents = viewManager.getWebContents(viewId);
    if (contents && !contents.isDestroyed()) {
      contents.send("natstack:incoming-pair-link", link);
    }
  }
}

function createCdpRegistrationAdapter() {
  return {
    registerTarget(panelId: string, contentsId: number): void {
      cdpHostProvider?.registerTarget(panelId, contentsId);
    },
    unregisterTarget(panelId: string): void {
      cdpHostProvider?.unregisterTarget(panelId);
    },
    cleanupPanelAccess(panelId: string): void {
      cdpHostProvider?.cleanupPanelAccess(panelId);
    },
    getAccessibilityTree(panelId: string): Promise<unknown[]> {
      if (cdpHostProvider) return cdpHostProvider.getAccessibilityTree(panelId);
      return Promise.resolve([]);
    },
  };
}

log.info(` Starting in main mode`);

type CredentialSessionCaptureRequest = Record<string, unknown> & {
  kind?: unknown;
  signInUrl?: unknown;
  origins?: unknown;
  cookieNames?: unknown;
  completionUrlPattern?: unknown;
  maxTtlSeconds?: unknown;
  browser?: unknown;
  assertion?: unknown;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function normalizeCaptureOrigins(value: unknown): string[] {
  const origins = toStringArray(value).map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("capture origin must use http or https");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function buildCookieHeader(
  cookies: Electron.Cookie[],
  cookieNames: string[]
): {
  header: string;
  expiresAt?: number;
  cookies: Record<string, unknown>[];
} | null {
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie]));
  const selected: Electron.Cookie[] = [];
  for (const name of cookieNames) {
    const cookie = byName.get(name);
    if (!cookie || !cookie.value) return null;
    selected.push(cookie);
  }
  const expiringCookies = selected
    .map((cookie) =>
      typeof cookie.expirationDate === "number"
        ? Math.floor(cookie.expirationDate * 1000)
        : undefined
    )
    .filter((value): value is number => typeof value === "number" && value > 0);
  return {
    header: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    expiresAt: expiringCookies.length > 0 ? Math.min(...expiringCookies) : undefined,
    cookies: selected.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      partitionKey:
        typeof (cookie as { partitionKey?: unknown }).partitionKey === "string"
          ? (cookie as { partitionKey?: string }).partitionKey
          : undefined,
    })),
  };
}

function buildImportedCookieHeader(
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expiration_date: number | null;
    secure: number;
    http_only: number;
    same_site: string;
  }>,
  cookieNames: string[],
  origins: string[]
): {
  header: string;
  expiresAt?: number;
  cookies: Record<string, unknown>[];
} | null {
  const selected: typeof cookies = [];
  for (const name of cookieNames) {
    const cookie = cookies.find(
      (entry) =>
        entry.name === name &&
        !!entry.value &&
        origins.some((origin) => importedCookieMatchesOrigin(entry, origin))
    );
    if (!cookie) return null;
    selected.push(cookie);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiringCookies = selected
    .map((cookie) => cookie.expiration_date ?? undefined)
    .filter((value): value is number => typeof value === "number" && value > nowSeconds);
  if (
    selected.some(
      (cookie) => typeof cookie.expiration_date === "number" && cookie.expiration_date <= nowSeconds
    )
  ) {
    return null;
  }
  return {
    header: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    expiresAt: expiringCookies.length > 0 ? Math.min(...expiringCookies) * 1000 : undefined,
    cookies: selected.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure === 1,
      httpOnly: cookie.http_only === 1,
      sameSite: cookie.same_site,
      expirationDate: cookie.expiration_date ?? undefined,
    })),
  };
}

function importedCookieMatchesOrigin(
  cookie: { domain: string; path: string; secure: number },
  origin: string
): boolean {
  const url = new URL(origin);
  if (cookie.secure === 1 && url.protocol !== "https:") return false;
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const domainMatches = cookie.domain.startsWith(".")
    ? host === cookieDomain || host.endsWith(`.${cookieDomain}`)
    : host === cookieDomain;
  if (!domainMatches) return false;
  const cookiePath = cookie.path || "/";
  return (
    url.pathname === cookiePath ||
    url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)
  );
}

function getHttpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getWebRequestPanelCallerId(
  details: Electron.OnHeadersReceivedListenerDetails
): string | null {
  if (!viewManager) return null;
  const webContentsId = details.webContentsId ?? details.webContents?.id;
  if (typeof webContentsId !== "number") return null;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
    return null;
  }
  return viewManager.findViewIdByWebContentsId(webContentsId);
}

function getCorsRequestOrigin(details: Electron.OnHeadersReceivedListenerDetails): string | null {
  const referrerOrigin = details.referrer ? getHttpOrigin(details.referrer) : null;
  if (referrerOrigin) return referrerOrigin;
  const currentUrl =
    details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : "";
  return currentUrl ? getHttpOrigin(currentUrl) : null;
}

async function authorizeCorsResponseAccess(
  details: Electron.OnHeadersReceivedListenerDetails
): Promise<{ allowed: boolean; requestOrigin: string | null }> {
  if (details.resourceType !== "xhr") {
    return { allowed: false, requestOrigin: null };
  }
  const targetOrigin = getHttpOrigin(details.url);
  const requestOrigin = getCorsRequestOrigin(details);
  if (!targetOrigin || !requestOrigin || targetOrigin === requestOrigin) {
    return { allowed: false, requestOrigin };
  }

  const callerId = getWebRequestPanelCallerId(details);
  if (!callerId || !serverSession?.serverClient) {
    return { allowed: false, requestOrigin };
  }

  const cacheKey = `${callerId}\x00${targetOrigin}`;
  if (corsApprovalCache.has(cacheKey)) {
    return { allowed: true, requestOrigin };
  }

  let pending = pendingCorsApprovals.get(cacheKey);
  if (!pending) {
    const client = serverSession.serverClient;
    pending = createTypedServiceClient("corsApproval", corsApprovalMethods, (svc, m, a) =>
      client.call(svc, m, a)
    )
      .authorize({ targetUrl: details.url, requestOrigin })
      .then((response) => {
        const allowed = response.allowed === true;
        const cacheable = allowed && response.decision !== "once";
        if (cacheable) corsApprovalCache.add(cacheKey);
        return { allowed, cacheable };
      })
      .catch((error: unknown) => {
        log.warn(`CORS approval failed: ${error instanceof Error ? error.message : String(error)}`);
        return { allowed: false, cacheable: false };
      })
      .finally(() => {
        pendingCorsApprovals.delete(cacheKey);
      });
    pendingCorsApprovals.set(cacheKey, pending);
  }

  const result = await pending;
  return { allowed: result.allowed, requestOrigin };
}

function withCorsRelaxedHeaders(
  responseHeaders: Record<string, string[]> | undefined,
  requestOrigin: string
): Record<string, string[]> {
  const strippedCorsHeaderNames = new Set([
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-credentials",
    "access-control-expose-headers",
  ]);
  const headers: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (!strippedCorsHeaderNames.has(lower)) {
      headers[key] = value;
    }
  }
  headers["access-control-allow-origin"] = [requestOrigin];
  headers["access-control-allow-headers"] = ["*"];
  headers["access-control-allow-methods"] = ["GET, POST, PUT, PATCH, DELETE, OPTIONS"];
  headers["access-control-allow-credentials"] = ["true"];
  headers["access-control-expose-headers"] = ["*"];
  return headers;
}

async function handleCredentialSessionCaptureRequest(
  msg: CredentialSessionCaptureRequest
): Promise<Record<string, unknown>> {
  try {
    if (msg.kind !== "cookies" && msg.kind !== "saml") {
      return { error: "unsupported session capture kind" };
    }
    if (typeof msg.signInUrl !== "string") {
      return { error: "missing signInUrl" };
    }
    const signInUrl = new URL(msg.signInUrl);
    if (signInUrl.protocol !== "https:" && signInUrl.protocol !== "http:") {
      return { error: "signInUrl must use http or https" };
    }
    const cookieNames = toStringArray(msg.cookieNames);
    if (cookieNames.length === 0) {
      return { error: "cookie capture requires declared cookie names" };
    }
    const origins =
      msg.kind === "cookies" ? normalizeCaptureOrigins(msg.origins) : [signInUrl.origin];
    if (msg.kind === "saml" && msg.assertion && cookieNames.length === 0) {
      return { error: "raw SAML assertion capture is not supported by this host adapter" };
    }
    if (msg.browser === "external") {
      if (!browserDataStoreForCredentialCapture) {
        return { error: "external browser cookie import is unavailable" };
      }
      const imported = await browserDataStoreForCredentialCapture.cookies.getByDomain();
      const material = buildImportedCookieHeader(imported, cookieNames, origins);
      if (!material) {
        return {
          error: "external browser cookie import did not contain the declared session cookies",
        };
      }
      const maxTtlSeconds =
        typeof msg.maxTtlSeconds === "number" && msg.maxTtlSeconds > 0
          ? Math.floor(msg.maxTtlSeconds)
          : undefined;
      const maxExpiresAt = maxTtlSeconds ? Date.now() + maxTtlSeconds * 1000 : undefined;
      return {
        cookieHeader: material.header,
        cookieSession: {
          origins,
          cookies: material.cookies,
        },
        expiresAt:
          material.expiresAt && maxExpiresAt
            ? Math.min(material.expiresAt, maxExpiresAt)
            : (material.expiresAt ?? maxExpiresAt),
      };
    }
    if (!panelOrchestrator || !viewManager) {
      return { error: "internal browser is unavailable" };
    }

    const panel = await panelOrchestrator.createBrowserUrlPanel("shell", signInUrl.href, {
      name: "Credential sign-in",
      focus: true,
    });

    try {
      const webContents = viewManager.getWebContents(panel.id);
      if (!webContents || webContents.isDestroyed()) {
        return { error: "failed to create browser panel" };
      }

      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      const completionPattern =
        typeof msg.completionUrlPattern === "string" ? msg.completionUrlPattern : undefined;
      const timeout = 300_000;

      // Helper to check if cookies are captured
      const tryCaptureCredentials = async (): Promise<Record<string, unknown> | null> => {
        const captured: Electron.Cookie[] = [];
        for (const origin of origins) {
          const originCookies = await browserSession.cookies.get({ url: origin });
          for (const cookie of originCookies) {
            if (cookieNames.includes(cookie.name)) {
              captured.push(cookie);
            }
          }
        }
        const material = buildCookieHeader(captured, cookieNames);
        if (material) {
          const maxTtlSeconds =
            typeof msg.maxTtlSeconds === "number" && msg.maxTtlSeconds > 0
              ? Math.floor(msg.maxTtlSeconds)
              : undefined;
          const maxExpiresAt = maxTtlSeconds ? Date.now() + maxTtlSeconds * 1000 : undefined;
          return {
            cookieHeader: material.header,
            cookieSession: {
              origins,
              cookies: material.cookies,
            },
            expiresAt:
              material.expiresAt && maxExpiresAt
                ? Math.min(material.expiresAt, maxExpiresAt)
                : (material.expiresAt ?? maxExpiresAt),
          };
        }
        return null;
      };

      type CaptureResult = Record<string, unknown> | { error: string };
      type CookieChangeCause =
        | "explicit"
        | "overwrite"
        | "expired"
        | "evicted"
        | "expired-overwrite";

      const immediate = await tryCaptureCredentials();
      if (immediate && !completionPattern) return immediate;

      const captureResult = await new Promise<CaptureResult>((resolve) => {
        let settled = false;
        let completionReached =
          !completionPattern ||
          (!!webContents.getURL() && globMatches(completionPattern, webContents.getURL()));
        let captureInFlight: Promise<void> | null = null;

        const cleanup = () => {
          clearTimeout(timeoutId);
          browserSession.cookies.off("changed", onCookiesChanged);
          webContents.off("did-navigate", onNavigate);
          webContents.off("did-navigate-in-page", onNavigate);
          webContents.off("did-redirect-navigation", onRedirect);
          webContents.off("destroyed", onDestroyed);
        };

        const finish = (result: CaptureResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const attemptCapture = () => {
          if (settled || !completionReached || captureInFlight) return;
          captureInFlight = tryCaptureCredentials()
            .then((result) => {
              if (result) finish(result);
            })
            .catch((error: unknown) => {
              finish({ error: error instanceof Error ? error.message : String(error) });
            })
            .finally(() => {
              captureInFlight = null;
            });
        };

        const markCompletionIfMatched = (url: string) => {
          if (completionPattern && globMatches(completionPattern, url)) {
            completionReached = true;
          }
          attemptCapture();
        };

        const onCookiesChanged = (
          _event: Electron.Event,
          cookie: Electron.Cookie,
          _cause: CookieChangeCause,
          removed: boolean
        ) => {
          if (removed || !cookieNames.includes(cookie.name)) return;
          attemptCapture();
        };
        const onNavigate = (_event: Electron.Event, url: string) => markCompletionIfMatched(url);
        const onRedirect = (
          details: Electron.Event<Electron.WebContentsDidRedirectNavigationEventParams>
        ) => markCompletionIfMatched(details.url);
        const onDestroyed = () => finish({ error: "user closed sign-in window" });
        const timeoutId = setTimeout(() => finish({ error: "session capture timed out" }), timeout);

        browserSession.cookies.on("changed", onCookiesChanged);
        webContents.on("did-navigate", onNavigate);
        webContents.on("did-navigate-in-page", onNavigate);
        webContents.on("did-redirect-navigation", onRedirect);
        webContents.on("destroyed", onDestroyed);

        if (immediate && completionReached) {
          finish(immediate);
          return;
        }

        attemptCapture();
      });

      return captureResult;
    } finally {
      // Always close the panel on exit (success, timeout, or user close)
      await panelOrchestrator.closePanel(panel.id).catch(() => {});
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install TLS fingerprint pinning across the default session AND every
 * `persist:browser` / `persist:panel:*` partition when the user configured an
 * explicit leaf certificate fingerprint. A CA path is trust material, not a
 * leaf pin, so it is handled by Node/Electron certificate validation instead.
 */
function installRemoteTlsPinning(mode: StartupMode): void {
  if (mode.kind !== "remote" || mode.remoteUrl.protocol !== "https:") {
    return;
  }

  const expectedFingerprint = mode.tls?.fingerprint;

  if (!expectedFingerprint) {
    return;
  }

  installPinnedTlsForAllPartitions(mode.remoteUrl.hostname, expectedFingerprint);
}

async function syncElectronHostTarget(serverClient: Pick<ServerClient, "call">): Promise<void> {
  try {
    const workspaceClient = createTypedServiceClient("workspace", workspaceMethods, (svc, m, a) =>
      serverClient.call(svc, m, a)
    );
    const result = await workspaceClient.hostTargets.launch("electron");
    if (!result.launched) {
      log.warn("[apps] No launchable Electron host target is selected");
    }
  } catch (error) {
    log.warn(
      `[apps] Failed to synchronize Electron host target: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// =============================================================================
// Window Creation
// =============================================================================

function createWindow(): void {
  // Create BaseWindow (no webContents of its own)
  // Start hidden to avoid layout flash - shown after shell content loads
  mainWindow = new BaseWindow({
    width: 1200,
    height: 600,
    show: false,
    skipTaskbar: IS_HEADLESS_HOST,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin"
      ? {
          titleBarOverlay: true,
        }
      : {}),
  });

  // Initialize ViewManager with shell view (IPC transport — no WS args needed)
  viewManager = new ViewManager({
    window: mainWindow,
    shellPreload: path.join(__dirname, "bootstrapPreload.cjs"),
    shellOverlayPreload: path.join(__dirname, "shellOverlayPreload.cjs"),
    shellHtmlPath: path.join(__dirname, "index.html"),
    shellAdditionalArguments: [],
    devTools: false,
    showWindowOnShellLoad: !IS_HEADLESS_HOST,
  });

  // Set native window title for OS taskbar / window switcher (Alt+Tab / dock)
  mainWindow.setTitle(
    IS_HEADLESS_HOST ? `NatStack Headless Host — ${workspaceId}` : `NatStack — ${workspaceId}`
  );

  mainWindow.on("focus", () => approvalAttention?.handleWindowFocus());

  mainWindow.on("closed", () => {
    mainWindow = null;
    viewManager = null;
    panelView = null; // Clear so getPanelView() returns null until recreated
    appOrchestrator = null;
  });

  if (viewManager && panelRegistry && panelOrchestrator && serverSession) {
    const browserHistoryRecorder = new BrowserHistoryRecorder(serverSession.serverClient);
    panelView = new PanelView({
      viewManager,
      panelRegistry,
      serverInfo: serverSession.serverInfo,
      cdpHost: createCdpRegistrationAdapter(),
      panelOrchestrator,
      sendPanelEvent: (panelId, event, payload) => {
        const wc = viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("natstack:event", event, payload);
        }
      },
      autofillManager: autofillManager ?? undefined,
      autofillPreloadPath: path.join(__dirname, "autofillPreload.cjs"),
      panelPreloadPath: path.join(__dirname, "panelPreload.cjs"),
      appPreloadPath: path.join(__dirname, "appPreload.cjs"),
      browserPreloadPath: path.join(__dirname, "browserPreload.cjs"),
      browserHistoryRecorder,
    });
    appOrchestrator = new AppOrchestrator({
      getPanelView: () => panelView,
      statePath: startupMode.kind === "remote" ? getRemoteUserDataDir() : serverSession.statePath,
    });
    void syncElectronHostTarget(serverSession.serverClient);
    void appOrchestrator
      .loadBakedApp(path.join(getResourcesPath(), "baked-app"))
      .catch((error: unknown) => {
        log.error(
          `[dist] Failed to load baked app payload: ${error instanceof Error ? error.message : String(error)}`
        );
      });

    // Wire autofill overlay to window, z-order changes, and panel switches
    if (autofillManager && mainWindow && viewManager) {
      autofillManager.setWindow(mainWindow);
      viewManager.onViewOrderChanged(() => autofillManager?.onViewOrderChanged());
      viewManager.onViewHidden((viewId) => autofillManager?.onPanelHidden(viewId));
    }

    viewManager.onViewCrashed((viewId, reason) => {
      assertPresent(panelView).handleViewCrashed(viewId, reason);
    });

    setupTestApi(panelOrchestrator, panelRegistry, panelView);
  }

  // Optional memory diagnostics (env-driven).
  if (viewManager) setMemoryMonitorViewManager(viewManager);
  startMemoryMonitor();

  // Setup application menu (uses shell webContents for menu events)
  if (viewManager) setMenuViewManager(viewManager);
  if (!IS_HEADLESS_HOST)
    setupMenu(mainWindow, viewManager.getShellWebContents(), {
      onHistoryBack: () => {
        if (!panelRegistry || !viewManager) return;
        const panelId = panelRegistry.getFocusedPanelId();
        if (!panelId) return;
        const contents = viewManager.getWebContents(panelId);
        if (contents && !contents.isDestroyed() && contents.canGoBack()) {
          contents.goBack();
        }
      },
      onHistoryForward: () => {
        if (!panelRegistry || !viewManager) return;
        const panelId = panelRegistry.getFocusedPanelId();
        if (!panelId) return;
        const contents = viewManager.getWebContents(panelId);
        if (contents && !contents.isDestroyed() && contents.canGoForward()) {
          contents.goForward();
        }
      },
    });

  // Initialize panel tree after window is ready
  if (panelOrchestrator) {
    panelOrchestrator.initializePanelTree().catch((error) => {
      console.error("[App] Failed to initialize panel tree:", error);
      eventService.emit("panel-initialization-error", {
        path: "",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  performance.mark("startup:ready");

  ipcMain.handle("natstack:drain-pair-link", (event) => {
    if (!canAccessIncomingPairLinks(event.sender.id)) {
      throw new Error("Incoming pairing links require app capability 'incoming-pair-links'");
    }
    return getPendingConnectLink();
  });
  onConnectLink((link) => {
    if (IS_HEADLESS_HOST) return;
    sendIncomingPairLink(link);
    mainWindow?.show();
    mainWindow?.focus();
  });

  // Default to browser CORS. For panel fetch/XHR responses, relax CORS only
  // after the trusted shell approval flow grants that panel access to the
  // target origin. Browser panels use a separate "persist:browser" partition
  // and are unaffected.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    void authorizeCorsResponseAccess(details)
      .then(({ allowed, requestOrigin }) => {
        callback({
          responseHeaders:
            allowed && requestOrigin
              ? withCorsRelaxedHeaders(details.responseHeaders, requestOrigin)
              : details.responseHeaders,
        });
      })
      .catch((error: unknown) => {
        log.warn(
          `CORS header handling failed: ${error instanceof Error ? error.message : String(error)}`
        );
        callback({ responseHeaders: details.responseHeaders });
      });
  });

  // -------------------------------------------------------------------------
  // Default-deny permission handlers (audit finding #37 / 01-MEDIUM-4).
  //
  // Without these, Electron grants panel webContents the ability to request
  // geolocation, notifications, microphone, camera, mediaKeySystem, midi,
  // pointerLock, display-capture, etc. Browser panels load arbitrary external
  // URLs, so unknown/panel senders stay denied. App senders are allowed only
  // when their active app manifest declared the matching capability.
  // -------------------------------------------------------------------------
  const SENSITIVE_PERMISSIONS = new Set<string>([
    "geolocation",
    "notifications",
    "media",
    "mediaKeySystem",
    "midi",
    "midiSysex",
    "pointerLock",
    "fullscreen",
    "openExternal",
    "display-capture",
  ]);

  const capabilityForElectronPermission = (
    permission: string
  ): import("@natstack/shared/unitManifest").AppCapability | null => {
    switch (permission) {
      case "notifications":
        return "notifications";
      case "openExternal":
        return "open-external";
      case "fullscreen":
      case "pointerLock":
      case "display-capture":
        return "window-management";
      default:
        return null;
    }
  };

  const appWebContentsHasPermissionCapability = (
    contents: WebContents | null | undefined,
    permission: string
  ): boolean => {
    if (!contents || !viewManager) return false;
    const capability = capabilityForElectronPermission(permission);
    if (!capability) return false;
    const viewId = viewManager.findViewIdByWebContentsId(contents.id);
    if (!viewId) return false;
    const viewInfo = viewManager.getViewInfo(viewId);
    return viewInfo?.type === "app" && viewInfo.capabilities.includes(capability);
  };

  const installPermissionHandlers = (targetSession: Session): void => {
    targetSession.setPermissionRequestHandler((contents, permission, callback) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        if (appWebContentsHasPermissionCapability(contents, permission)) {
          callback(true);
          return;
        }
        console.warn(`[permissions] denied request for '${permission}'`);
        callback(false);
        return;
      }
      // Permissive default for non-sensitive permissions (clipboard read/etc.)
      callback(true);
    });
    targetSession.setPermissionCheckHandler((contents, permission) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        return appWebContentsHasPermissionCapability(contents, permission);
      }
      return true;
    });
  };

  // Apply to default session up-front, and to every session created later
  // (panel partitions, persist:browser, etc.) via the session-created hook.
  installPermissionHandlers(session.defaultSession);
  app.on("session-created", (s) => {
    try {
      installPermissionHandlers(s);
    } catch (err) {
      console.warn(
        `[permissions] failed to install handlers on session: ${(err as Error).message}`
      );
    }
  });

  // Auto-update check (production only)
  if (!isDev()) {
    try {
      // Dynamic import to avoid bundling electron-updater in development
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require("electron-updater") as {
        autoUpdater: {
          logger: unknown;
          autoDownload: boolean;
          autoInstallOnAppQuit: boolean;
          on: (
            event: string,
            callback: (info: { version?: string; message?: string }) => void
          ) => void;
          checkForUpdates: () => Promise<unknown>;
        };
      };

      autoUpdater.logger = {
        info: (msg: string) => console.log(`[AutoUpdater] ${msg}`),
        warn: (msg: string) => console.warn(`[AutoUpdater] ${msg}`),
        error: (msg: string) => console.error(`[AutoUpdater] ${msg}`),
        debug: (msg: string) => console.log(`[AutoUpdater:debug] ${msg}`),
      };
      autoUpdater.autoDownload = false; // Don't auto-download, let user decide
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("update-available", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update available: ${info.version}`);
      });

      autoUpdater.on("update-downloaded", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
      });

      autoUpdater.on("error", (error: { message?: string }) => {
        console.warn(`[AutoUpdater] Error: ${error.message}`);
      });

      // Check for updates (non-blocking)
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.warn(`[AutoUpdater] Failed to check for updates: ${err.message}`);
      });
    } catch {
      // electron-updater not available or failed to load - this is fine in development
      console.log("[AutoUpdater] Not available (this is normal in development)");
    }
  }

  const dispatcher = new ServiceDispatcher();

  performance.mark("startup:services-registered");

  let serverClientRef: import("./serverClient.js").ServerClient | null = null;
  const serverEventSubscriptions = createServerEventSubscriptionBridge({
    getServerClient: () => serverClientRef,
    log,
  });
  const recoverShellStateFromServer = async (_kind: "resubscribe" | "cold-recover") => {
    await serverEventSubscriptions.replay({ force: true });
    // Catch up on approvals that arrived while the event stream was down.
    void approvalAttention?.refresh();
    if (!panelOrchestrator) return;
    await panelOrchestrator
      .recoverShellSnapshot({ loadFocusedView: false })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[recovery] shell snapshot failed: ${msg}`);
      });
  };

  if (!IS_HEADLESS_HOST) {
    approvalAttention = createApprovalAttention({
      getWindow: () => mainWindow,
      listPending: async () => {
        const client = serverClientRef;
        if (!client) return null;
        return (await client.call("shellApproval", "listPending", [])) as PendingApproval[];
      },
      log,
    });
  }

  const handleServerEvent = createServerEventBridge({
    eventService,
    getPanelOrchestrator: () => panelOrchestrator,
    getAppOrchestrator: () => appOrchestrator,
    getServerClient: () => serverClientRef,
    openExternal: (url) => shell.openExternal(url),
    warn: (message) => log.warn(message),
    onApprovalPendingChanged: (pending) => approvalAttention?.handlePendingChanged(pending),
  });

  try {
    performance.mark("startup:server-spawn-begin");

    // Emit a synthetic "connecting" sample so the connection badge has a
    // state to render from the very first frame (rather than flickering
    // from empty → connected). This mirrors what ServerClient's own
    // onConnectionStatusChanged callback will emit a few moments later
    // once the WS lifecycle begins.
    eventService.emit("server-connection-changed", {
      status: "connecting",
      isRemote: startupMode.kind === "remote",
      remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
    });

    let previousStatus: import("./serverClient.js").ConnectionStatus | null = null;
    const establish = (mode: StartupMode) =>
      establishServerSession({
        mode,
        centralData,
        onServerEvent: handleServerEvent,
        onIpcRequest: async (type, msg) => {
          if (type === "credential-session-capture-request") {
            return handleCredentialSessionCaptureRequest(msg);
          }
          return null;
        },
        onConnectionStatusChanged: (status) => {
          eventService.emit("server-connection-changed", {
            status,
            isRemote: startupMode.kind === "remote",
            remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
          });
          // On every transition into "connected" (including the very first one
          // and any subsequent reconnect), replay shell subscriptions. The
          // first callback may fire before `serverClientRef` is assigned; the
          // post-establish replay below covers that startup ordering.
          if (status === "connected" && previousStatus !== "connected") {
            void serverEventSubscriptions.replay({ force: true });
          }
          previousStatus = status;
        },
        onRecovery: (kind) => {
          void recoverShellStateFromServer(kind).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[recovery] ${kind} failed: ${msg}`);
          });
        },
      });

    // Phase 1: Establish server session (spawn or connect)
    try {
      serverSession = await establish(startupMode);
    } catch (error) {
      if (!shouldFallbackToLocalForRemoteCredential(error)) throw error;
      applyLocalStartupMode(error instanceof Error ? error.message : String(error));
      serverSession = await establish(startupMode);
    }
    serverClientRef = serverSession.serverClient;
    serverEventSubscriptions.add("apps:available");
    serverEventSubscriptions.add("external-open:open");
    serverEventSubscriptions.add("browser-panel:open");
    serverEventSubscriptions.add("panel-tree-updated");
    serverEventSubscriptions.add("panel-title-updated");
    serverEventSubscriptions.add("panel:runtimeLeaseChanged");
    serverEventSubscriptions.add("shell-approval:pending-changed");
    await serverEventSubscriptions.replay({ force: true });
    // Seed badge/seen-set from approvals already pending at launch without
    // firing OS notifications for them — the bar shows them once the shell
    // window is up.
    void approvalAttention?.refresh({ quiet: true });
    workspaceId = serverSession.workspaceId;

    performance.mark("startup:server-spawned");
    performance.mark("startup:server-connected");

    if (mainWindow) {
      mainWindow.setTitle(`NatStack — ${workspaceId}`);
    }

    // Remote-mode only: poll /healthz from main-process every 60s and emit
    // `server-health` samples to the renderer. Local mode manages the
    // server process directly and doesn't need polled liveness info.
    if (startupMode.kind === "remote") {
      const { startRemoteHealthPoll } = await import("./remoteHealthPoll.js");
      startRemoteHealthPoll({
        baseUrl: startupMode.remoteUrl,
        adminToken: startupMode.adminToken,
        caPath: startupMode.tls?.caPath,
        fingerprint: startupMode.tls?.fingerprint,
        eventService,
      });
    }

    // Create PanelRegistry (pure in-memory — server owns persistence)
    panelRegistry = new PanelRegistry({
      onTreeUpdated: (snapshot) => eventService.emit("panel-tree-updated", snapshot),
    });

    const { createElectronShellCore } = await import("./shellCore/createElectronShellCore.js");
    shellCore = createElectronShellCore({
      statePath: startupMode.kind === "remote" ? getRemoteUserDataDir() : serverSession.statePath,
      workspaceId: serverSession.workspaceId,
      workspacePath: serverSession.workspacePath,
      // In remote mode the workspace source tree lives on the server, so the
      // Electron process cannot require local panel manifests during bootstrap.
      allowMissingManifests: startupMode.kind === "remote",
      registry: panelRegistry,
      serverClient: serverSession.serverClient,
      gatewayConfig: serverSession.gatewayConfig,
      workspaceConfig: serverSession.workspaceConfig,
    });

    // PanelHttpServer is created by serverSession (RPC-backed proxy)
    const conn = assertPresent(serverSession);

    // Create IpcDispatcher (replaces Electron-side RpcServer for shell)
    // Forwards server-service calls to the server, dispatches Electron-local
    // services to the local dispatcher.
    const { IpcDispatcher } = await import("./ipcDispatcher.js");
    new IpcDispatcher({
      dispatcher,
      serverClient: conn.serverClient,
      getShellWebContents: () => viewManager?.getShellWebContents() ?? null,
      resolveCallerForWebContents: (webContentsId) => {
        if (!viewManager) return null;
        const shellContents = viewManager.getShellWebContents();
        if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
          return { callerId: "shell", callerKind: "shell" };
        }
        const callerId = viewManager.findViewIdByWebContentsId(webContentsId);
        if (!callerId) return null;
        const viewInfo = viewManager.getViewInfo(callerId);
        return resolveElectronViewCaller(callerId, viewInfo);
      },
      getCodeIdentityForCaller: (callerId) => {
        const viewInfo = viewManager?.getViewInfo(callerId);
        if (viewInfo?.type !== "app") return null;
        const identity = viewInfo.appIdentity;
        if (!identity?.source || !identity.effectiveVersion) return null;
        return {
          callerId,
          callerKind: "app",
          repoPath: identity.source,
          effectiveVersion: identity.effectiveVersion,
        };
      },
      getWebContentsForCaller: (callerId) => viewManager?.getWebContents(callerId) ?? null,
      authorizeAppServerCall,
      eventService,
    });
    log.info(`[PanelHTTP] Using server's panel HTTP via gateway port ${conn.gatewayPort}`);

    // Create PanelOrchestrator
    panelOrchestrator = new PanelOrchestrator({
      registry: panelRegistry,
      eventService,
      serverClient: conn.serverClient,
      shellCore: shellCore.panelManager,
      cdpHost: createCdpRegistrationAdapter(),
      getPanelView: () => panelView,
      panelHttpServer: conn.panelHttpServer,
      externalHost: conn.externalHost,
      protocol: conn.protocol,
      gatewayPort: conn.gatewayPort,
      sendPanelEvent: (panelId, event, payload) => {
        const wc = viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("natstack:event", event, payload);
        }
      },
      workspaceConfig: conn.workspaceConfig,
      runtimeClient: IS_HEADLESS_HOST
        ? {
            label: "Headless",
            platform: "headless",
            supportsCdp: true,
            loadOnLeaseAssignment: true,
            restorePolicy: "none",
          }
        : undefined,
    });

    await panelOrchestrator.registerRuntimeClient();

    // Batch panel warn/error + lifecycle diagnostics into `panelLog.append`
    // so panel failures land in the server's per-unit diagnostics store
    // (queryable by workspace agents). Best-effort: drops on send failure.
    const panelLogClient = createTypedServiceClient("panelLog", panelLogMethods, (svc, m, a) =>
      conn.serverClient.call(svc, m, a)
    );
    const panelLogQueue: import("@natstack/shared/serviceSchemas/panelLog").PanelLogRecord[] = [];
    let panelLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPanelLog = () => {
      panelLogFlushTimer = null;
      const batch = panelLogQueue.splice(0, panelLogQueue.length);
      if (batch.length === 0) return;
      void panelLogClient.append(batch).catch(() => {});
    };
    const forwardPanelDiagnostic = (
      panelId: string,
      entry: import("./cdpHostProvider.js").PanelConsoleHistoryEntry
    ) => {
      const panel = panelRegistry?.getPanel(panelId);
      if (!panel) return;
      const rawSource = getPanelSource(panel);
      // Browser panels aren't workspace units; their console isn't unit health.
      if (rawSource.startsWith("browser:")) return;
      const unitSource = rawSource.split(/[?#]/)[0];
      if (!unitSource) return;
      panelLogQueue.push({
        unitSource,
        panelId,
        timestamp: entry.timestamp,
        level:
          entry.level === "warning" ? "warn" : entry.level === "unknown" ? "info" : entry.level,
        message: entry.message,
        source: entry.source === "lifecycle" ? "lifecycle" : "console",
        fields: entry.fields,
        url: entry.url || undefined,
        line: entry.line || undefined,
      });
      if (panelLogQueue.length >= 50) {
        if (panelLogFlushTimer) clearTimeout(panelLogFlushTimer);
        flushPanelLog();
      } else if (!panelLogFlushTimer) {
        panelLogFlushTimer = setTimeout(flushPanelLog, 500);
      }
    };

    cdpHostProvider = new CdpHostProvider({
      serverUrl: conn.gatewayConfig.serverUrl,
      authToken: () => conn.shellToken || conn.adminToken,
      hostConnectionId: panelOrchestrator.getRuntimeClientSessionId(),
      getViewManager: () => viewManager,
      diagnosticsStore: new RuntimeDiagnosticsStore({
        statePath: startupMode.kind === "remote" ? getRemoteUserDataDir() : serverSession.statePath,
      }),
      forwardDiagnostic: forwardPanelDiagnostic,
      onHostCommand: async (panelId, action, args) => {
        if (action === "openDevTools") {
          if (!viewManager) throw new Error("ViewManager not initialized");
          const mode = args[0] === "right" || args[0] === "bottom" ? args[0] : "detach";
          viewManager.openDevTools(panelId, mode);
          return null;
        }
        if (action === "rebuildPanel") {
          return panelOrchestrator?.rebuildPanel(panelId) ?? null;
        }
        if (action === "rebuildAndReload") {
          return panelOrchestrator?.rebuildAndReloadPanel(panelId) ?? null;
        }
        if (action === "accessibilityTree") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.getAccessibilityTree(panelId);
        }
        if (action === "consoleHistory") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.getConsoleHistory(
            panelId,
            (args[0] as import("./cdpHostProvider.js").PanelConsoleHistoryOptions | undefined) ??
              undefined
          );
        }
        throw new Error(`Unknown host command: ${action}`);
      },
    });
    cdpHostProvider.start();

    // Set up test API for E2E testing (only when NATSTACK_TEST_MODE=1)
    setupTestApi(panelOrchestrator, panelRegistry, null);
    setMenuPanelLifecycle(panelOrchestrator);
    setMenuPanelRegistry(panelRegistry);
    setMenuEventService(eventService);

    const adBlockManager = new AdBlockManager();

    // Autofill manager — password auto-fill for browser panels
    const { AutofillManager } = await import("./autofill/autofillManager.js");

    // Register all Electron-main RPC services via ServiceContainer
    // PanelView needs viewManager which doesn't exist yet, so we use a lazy wrapper
    const getPanelView = (): PanelView => {
      if (!panelView) throw new Error("PanelView not initialized yet");
      return panelView;
    };
    const getViewManager = () => assertPresent(viewManager);

    const { createAppService } = await import("./services/appService.js");
    const { createPanelShellService } = await import("./services/panelShellService.js");
    const { createViewService } = await import("./services/viewService.js");
    const { createMenuService } = await import("./services/menuService.js");
    const { createNotificationService } = await import("./services/notificationService.js");
    const { createSettingsService } = await import("./services/settingsService.js");
    const { createAdblockService } = await import("./services/adblockService.js");
    // FS and git-local services removed — server owns these via panel service
    const { createBrowserDataRpcClient } = await import("@natstack/browser-data");

    const electronContainer = new ServiceContainer(dispatcher);

    const { serverClient: sc } = conn;

    // Shell-only services
    electronContainer.registerRpc(
      createAppService({
        panelOrchestrator,
        serverClient: sc,
        getViewManager,
        getAppOrchestrator: () => appOrchestrator,
        connectionMode: startupMode.kind === "remote" ? "remote" : "local",
        remoteHost: startupMode.kind === "remote" ? startupMode.remoteUrl.hostname : undefined,
      })
    );
    electronContainer.registerRpc(
      createPanelShellService({
        panelOrchestrator,
        panelRegistry,
        get panelView(): PanelView {
          return getPanelView();
        },
        getViewManager,
        serverClient: sc,
      })
    );
    electronContainer.registerRpc(createViewService({ getViewManager }));
    electronContainer.registerRpc(
      createMenuService({
        panelOrchestrator,
        panelRegistry,
        getViewManager,
        serverClient: sc,
      })
    );
    electronContainer.registerRpc(createNotificationService({ eventService, getViewManager }));
    // Workspace operations live entirely on the server now (single source of
    // truth, accessible to panels/workers/shell). The shell renderer's
    // `workspace.*` calls reach the server by default because only true
    // Electron-local services are routed here. Workspace.select (relaunch) is
    // signalled from the server back to Electron main via
    // ServerProcessManager.onRelaunch (wired in serverSession.ts).
    electronContainer.registerRpc(createSettingsService({ serverClient: sc, getViewManager }));
    const { createRemoteCredService } = await import("./services/remoteCredService.js");
    electronContainer.registerRpc(
      createRemoteCredService({ startupMode, getServerClient: () => serverClientRef })
    );
    electronContainer.registerRpc(createAdblockService({ adBlockManager }));
    // Browser-data persistence lives on the server; Electron keeps only the
    // host-bound autofill adapter.
    {
      electronContainer.registerManaged({
        name: "browser-data-host",
        async start() {
          const browserDataClient = createBrowserDataRpcClient(sc);
          browserDataStoreForCredentialCapture = browserDataClient;
          autofillManager = new AutofillManager({
            passwordStore: browserDataClient.passwords,
            eventService,
            getViewManager: () => assertPresent(viewManager),
            autofillOverlayPreloadPath: path.join(__dirname, "autofillOverlayPreload.cjs"),
          });
          return browserDataClient;
        },
        async stop() {
          browserDataStoreForCredentialCapture = null;
          if (autofillManager) {
            autofillManager.destroy();
            autofillManager = null;
          }
        },
      });
      const { createBrowserSessionSyncService } = await import("./services/browserSessionSync.js");
      electronContainer.registerManaged(
        createBrowserSessionSyncService({
          eventService,
          serverClient: sc,
          browserDataClient: createBrowserDataRpcClient(sc),
        })
      );
    }

    // Register autofill service (uses lazy resolution since autofillManager is created in browser-data start)
    electronContainer.registerRpc({
      name: "autofill",
      description: "Password autofill management",
      policy: { allowed: ["shell"] },
      methods: autofillMethods,
      handler: async (_ctx, method, args) => {
        if (!autofillManager) throw new Error("Autofill not initialized");
        const def = autofillManager.getServiceDefinition();
        return def.handler(_ctx, method, args);
      },
    });
    // Events service — local subscription on main's EventService plus a
    // bridge-owned server subscription. Main owns the remote subscription set:
    // renderer unmount/remount churn can remove local listeners, but it must
    // not race a remote unsubscribe against a newer remote subscribe and leave
    // server-originated approval/notification events stranded.
    //
    // The workspace shell now runs as an app view, so an app with
    // `panel-hosting` has the same event-bus role.
    {
      const baseEventsService = createEventsServiceDefinition(eventService);
      const shouldForwardServerEvents = (caller: ServiceContext["caller"]): boolean => {
        if (caller.runtime.kind === "shell") return true;
        if (caller.runtime.kind !== "app") return false;
        const viewInfo = viewManager?.getViewInfo(caller.runtime.id);
        return viewInfo?.type === "app" && viewInfo.capabilities.includes("panel-hosting");
      };
      electronContainer.registerRpc({
        ...baseEventsService,
        handler: async (ctx, method, args) => {
          const result = await baseEventsService.handler(ctx, method, args);
          if (!shouldForwardServerEvents(ctx.caller)) return result;

          if (method === "subscribe") {
            serverEventSubscriptions.add(args[0] as EventName);
          } else if (method === "unsubscribe") {
            serverEventSubscriptions.delete(args[0] as EventName);
          } else if (method === "unsubscribeAll") {
            serverEventSubscriptions.clear();
          }
          return result;
        },
      });
    }

    await electronContainer.startAll();

    dispatcher.markInitialized();

    // =========================================================================
    // Register ipcMain.handle handlers for __natstackElectron (panel preload)
    // =========================================================================
    // These handlers service panel IPC calls. Caller identity is resolved
    // via ViewManager's findViewIdByWebContentsId (which tracks the
    // webContents.id → viewId mapping for all created views).
    // The shell webContents is registered as viewId "shell".

    const resolveCallerId = (event: Electron.IpcMainInvokeEvent): string => {
      if (!viewManager) throw new Error("ViewManager not initialized");
      // Check if it's the shell
      const shellContents = viewManager.getShellWebContents();
      if (shellContents && !shellContents.isDestroyed() && shellContents.id === event.sender.id) {
        return "shell";
      }
      const viewId = viewManager.findViewIdByWebContentsId(event.sender.id);
      if (!viewId) throw new Error("Unknown caller webContents");
      return viewId;
    };

    const tryResolveCallerId = (event: Electron.IpcMainInvokeEvent): string | null => {
      if (!viewManager) return null;
      try {
        return resolveCallerId(event);
      } catch {
        return null;
      }
    };

    /**
     * Resolve both the caller id and caller kind from an IPC event sender.
     * Audit findings #19 / #43 / #44: handlers must derive callerKind from
     * authenticated transport metadata, not assume "shell". The shell
     * webContents has a known id; everything else is a panel/browser view.
     */
    const resolveCaller = (
      event: Electron.IpcMainInvokeEvent
    ): { callerId: string; callerKind: "shell" | "panel" | "app" } => {
      const callerId = resolveCallerId(event);
      return resolveElectronViewCaller(callerId, viewManager?.getViewInfo(callerId));
    };

    const codeIdentityForCallerId = (callerId: string) => {
      const viewInfo = viewManager?.getViewInfo(callerId);
      if (viewInfo?.type !== "app") return null;
      const identity = viewInfo.appIdentity;
      if (!identity?.source || !identity.effectiveVersion) return null;
      return {
        callerId,
        callerKind: "app" as const,
        repoPath: identity.source,
        effectiveVersion: identity.effectiveVersion,
      };
    };

    /**
     * Reject if the sender is not the shell webContents. Used for IPC
     * channels that should only be reachable from the trusted shell UI
     * (native dialogs, etc.). Audit finding #43.
     */
    const requireShellSender = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
      const { callerKind, callerId } = resolveCaller(event);
      if (callerKind !== "shell") {
        console.warn(`[ipc] Rejecting ${channel} from non-shell sender (callerId=${callerId})`);
        throw new Error(`Channel '${channel}' is shell-only`);
      }
    };

    const requireAppCapabilityForIpc = (
      event: Electron.IpcMainInvokeEvent,
      capability: AppCapability,
      channel: string
    ): { callerId: string; callerKind: "shell" | "panel" | "app" } => {
      const caller = resolveCaller(event);
      if (caller.callerKind !== "app") return caller;
      const viewInfo = viewManager?.getViewInfo(caller.callerId);
      if (viewInfo?.type === "app" && viewInfo.capabilities.includes(capability)) {
        return caller;
      }
      console.warn(
        `[ipc] Rejecting ${channel} from app ${caller.callerId} without capability '${capability}'`
      );
      throw new Error(`Channel '${channel}' requires app capability '${capability}'`);
    };

    ipcMain.handle("natstack:getPanelInit", async (event) => {
      const callerId = tryResolveCallerId(event);
      if (!callerId) return null;
      return panelOrchestrator?.getBootstrapConfig(callerId);
    });

    // Panel lifecycle
    ipcMain.handle("natstack:panel.close", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.close");
      return assertPresent(panelOrchestrator).closePanel(panelId);
    });
    ipcMain.handle("natstack:focusPanel", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:focusPanel");
      assertPresent(panelOrchestrator).focusPanel(panelId);
    });
    ipcMain.handle(
      "natstack:panel.create",
      async (
        event,
        source: string,
        opts?: { name?: string; focus?: boolean; stateArgs?: Record<string, unknown> }
      ) => {
        const { callerId } = requireAppCapabilityForIpc(
          event,
          "panel-hosting",
          "natstack:panel.create"
        );
        return assertPresent(panelOrchestrator).createRuntimePanel(callerId, source, opts);
      }
    );
    ipcMain.handle("natstack:panel.list", async (event, parentId?: string | null) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.list");
      return assertPresent(panelOrchestrator).listRuntimePanels(parentId);
    });
    ipcMain.handle("natstack:bridge.getInfo", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getInfo(asPanelSlotId(callerId));
    });
    ipcMain.handle(
      "natstack:bridge.setStateArgs",
      async (event, updates: Record<string, unknown>) => {
        const callerId = resolveCallerId(event);
        return panelOrchestrator
          ? panelOrchestrator.handleSetStateArgs(callerId, updates)
          : shellCore?.panelManager.updateStateArgs(asPanelSlotId(callerId), updates);
      }
    );
    ipcMain.handle("natstack:panel.getStateArgs", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.getStateArgs");
      return assertPresent(panelOrchestrator).getStateArgs(panelId);
    });
    ipcMain.handle(
      "natstack:panel.setStateArgs",
      async (event, panelId: string, updates: Record<string, unknown>) => {
        requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.setStateArgs");
        return assertPresent(panelOrchestrator).handleSetStateArgs(panelId, updates);
      }
    );
    ipcMain.handle("natstack:panel.reload", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.reload");
      return assertPresent(panelOrchestrator).reloadPanel(panelId);
    });
    ipcMain.handle("natstack:panel.snapshot", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.snapshot");
      return assertPresent(panelOrchestrator).snapshot(panelId);
    });
    ipcMain.handle(
      "natstack:panel.callAgent",
      async (
        event,
        panelId: string,
        method: string,
        args?: unknown[],
        options?: { timeoutMs?: number }
      ) => {
        requireAppCapabilityForIpc(event, "panel-hosting", "natstack:panel.callAgent");
        return assertPresent(panelOrchestrator).callAgent(panelId, method, args ?? [], options);
      }
    );
    ipcMain.on(
      "natstack:panel.callAgent.response",
      (
        _event,
        requestId: number,
        response: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }
      ) => {
        panelOrchestrator?.resolveAgentCallResponse(requestId, _event.sender.id, response);
      }
    );
    ipcMain.handle("natstack:getBootstrapConfig", async (event) => {
      const callerId = tryResolveCallerId(event);
      if (!callerId) return null;
      return panelOrchestrator?.getBootstrapConfig(callerId);
    });

    // Electron-native
    ipcMain.handle("natstack:openDevtools", async (event) => {
      const callerId = resolveCallerId(event);
      if (!viewManager) throw new Error("ViewManager not initialized");
      viewManager.openDevTools(callerId);
    });
    ipcMain.handle("natstack:openFolderDialog", async (event, opts?: { title?: string }) => {
      requireShellSender(event, "natstack:openFolderDialog");
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Select Folder",
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle(
      "natstack:openFileDialog",
      async (
        event,
        opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }
      ) => {
        requireShellSender(event, "natstack:openFileDialog");
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          title: opts?.title ?? "Select File",
          filters: opts?.filters,
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
    );
    ipcMain.handle("natstack:openExternal", async (event, url: string, options?: unknown) => {
      const caller = resolveCaller(event);
      if (caller.callerKind === "shell") {
        const externalOpen = createTypedServiceClient(
          "externalOpen",
          externalOpenMethods,
          (svc, m, a) => sc.call(svc, m, a)
        );
        await externalOpen.openExternal(
          url,
          options as import("@natstack/shared/externalOpen").OpenExternalOptions | undefined
        );
      } else {
        throw new Error("Panel openExternal must use its authenticated RPC transport");
      }
    });

    // Generic Electron service dispatch — lets panels call Electron-local
    // services (browser-data, autofill, etc.) directly via IPC instead of
    // going through the server, which may be remote.
    ipcMain.handle("natstack:serviceCall", async (event, method: string, args: unknown[]) => {
      // CallerKind is derived from the IPC sender's webContents id (shell vs
      // panel), and ServiceDispatcher.dispatch now enforces the per-service
      // policy at the choke point — see audit findings #3 / #18 / #19.
      const { callerId, callerKind } = resolveCaller(event);
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}". Expected "service.method"`);
      if (callerKind === "app" && parsed.service === "fs") {
        authorizeAppServerCall(callerId, parsed.service, parsed.method, args);
        return sc.callAs({ callerId, callerKind }, parsed.service, parsed.method, args);
      }
      return dispatcher.dispatch(
        { caller: createVerifiedCaller(callerId, callerKind, codeIdentityForCallerId(callerId)) },
        parsed.service,
        parsed.method,
        args
      );
    });

    // createWindow will create ViewManager, PanelView, and initialize panel tree
    void createWindow();

    performance.mark("startup:window-created");

    // Log startup timing in dev mode
    if (isDev()) {
      performance.measure("startup:total", "startup:ready", "startup:window-created");
      performance.measure(
        "startup:server-spawn",
        "startup:server-spawn-begin",
        "startup:server-spawned"
      );
      performance.measure(
        "startup:server-connect",
        "startup:server-spawned",
        "startup:server-connected"
      );
      performance.measure(
        "startup:post-connect",
        "startup:server-connected",
        "startup:window-created"
      );
      const entries = performance
        .getEntriesByType("measure")
        .filter((e) => e.name.startsWith("startup:"));
      for (const entry of entries) {
        console.log(`[Perf] ${entry.name}: ${Math.round(entry.duration)}ms`);
      }
    }

    // Defer ad-block initialization (non-critical, ~500-1000ms).
    // The onBeforeRequest handler has a !this.engine fast path that passes requests through.
    setTimeout(async () => {
      try {
        await adBlockManager.initialize();
        adBlockManager.enableForSession(session.defaultSession);
        console.log("[AdBlock] Initialized and enabled for default session");
      } catch (error) {
        console.warn("[AdBlock] Failed to initialize (non-fatal):", error);
      }
    }, 100);
  } catch (error) {
    console.error("[App] Startup failed:", error);

    // Fail-fast: clean up all partial state, show error, and exit.
    const cleanupPromises: Promise<void>[] = [];

    if (serverSession?.serverClient) {
      cleanupPromises.push(
        serverSession.serverClient
          .close()
          .catch((e) => console.error("[App] serverClient cleanup error:", e))
      );
    }
    if (serverSession?.serverProcessManager) {
      cleanupPromises.push(
        serverSession.serverProcessManager
          .shutdown()
          .catch((e) => console.error("[App] serverProcess cleanup error:", e))
      );
    }
    serverSession = null;
    if (cdpHostProvider) {
      cdpHostProvider.stop();
      cdpHostProvider = null;
    }
    await Promise.all(cleanupPromises);

    console.error("[App] Startup failed; exiting:", formatUnknownError(error));
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  // Prevent re-entry - if we're already cleaning up, let the app exit
  if (isCleaningUp) {
    return;
  }

  // Cleanup helper for ephemeral dev workspaces (called sync, after servers stop)
  const isEphemeral = startupMode.kind === "local" && startupMode.isEphemeral;
  const cleanupDevWorkspace = () => {
    if (isEphemeral && workspaceId) {
      try {
        deleteWorkspaceDir(workspaceId);
        centralData.removeWorkspace(workspaceId);
        console.log(`[App] Deleted ephemeral dev workspace "${workspaceId}"`);
      } catch (e) {
        console.error("[App] Failed to delete dev workspace:", e);
      }
    }
  };

  const hasResourcesToClean = serverSession || cdpHostProvider;
  if (hasResourcesToClean) {
    isCleaningUp = true;
    event.preventDefault();

    console.log("[App] Shutting down...");

    const stopPromises: Promise<void>[] = [];

    // Server client (caller-token WS connection) + server process
    if (serverSession) {
      // Run panel cleanup via server (archive childless shell panels),
      // then close the connection and stop the server process.
      const session = serverSession;
      serverSession = null;

      const cleanupThenClose = (async () => {
        if (panelRegistry && shellCore) {
          const livePanelIds = panelRegistry.listPanels().map((p) => asPanelSlotId(p.panelId));
          await shellCore.panelManager
            .shutdownCleanup(livePanelIds)
            .catch((e: unknown) => console.error("[App] Failed to run shutdown cleanup:", e));
        }
        await panelOrchestrator
          ?.unregisterRuntimeClient()
          .catch((e: unknown) => console.error("[App] Failed to unregister runtime client:", e));
        await session.serverClient
          .close()
          .catch((e) => console.error("[App] Server client close error:", e));
      })();
      stopPromises.push(cleanupThenClose);

      if (session.serverProcessManager) {
        stopPromises.push(
          cleanupThenClose.then(() =>
            assertPresent(session.serverProcessManager)
              .shutdown()
              .then(() => console.log("[App] Server process stopped"))
              .catch((e) => console.error("[App] Server process shutdown error:", e))
          )
        );
      }
    }

    if (cdpHostProvider) {
      cdpHostProvider.stop();
      cdpHostProvider = null;
    }

    // Add a timeout to ensure we exit even if cleanup hangs
    const shutdownTimeout = setTimeout(() => {
      console.warn("[App] Shutdown timeout - forcing exit");
      app.exit(1);
    }, APP_SHUTDOWN_TIMEOUT_MS);

    Promise.all(stopPromises).finally(() => {
      shellCore?.shutdown?.();
      shellCore = null;
      clearTimeout(shutdownTimeout);
      cleanupDevWorkspace();
      console.log("[App] Shutdown complete");
      app.exit(0);
    });
  } else {
    cleanupDevWorkspace();
  }
});

app.on("activate", () => {
  if (mainWindow === null && serverSession) {
    void createWindow();
  }
  const focusedPanelId = panelRegistry?.getFocusedPanelId();
  if (focusedPanelId) {
    void shellCore?.panelManager.notifyFocused(asPanelSlotId(focusedPanelId)).catch(() => {});
  }
});

// Listen for system theme changes and notify subscribers
nativeTheme.on("updated", () => {
  eventService.emit("system-theme-changed", nativeTheme.shouldUseDarkColors ? "dark" : "light");
});
