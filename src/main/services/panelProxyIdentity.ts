import { app, session as electronSession, type Session } from "electron";
import { createDevLogger } from "@natstack/dev-log";
import { mintCallerAssertion } from "@natstack/shared/identity/callerAssertion";
import type { PanelWebContentsRegistry } from "../panelRegistry.js";

const log = createDevLogger("PanelProxyIdentity");

export class PanelProxyIdentity {
  private readonly configuredSessions = new WeakSet<Session>();
  private readonly assertionCache = new Map<string, string>();
  private loginHandlerInstalled = false;

  constructor(private readonly deps: {
    assertionSecret: Buffer;
    proxyPort: number;
    panelRegistry: PanelWebContentsRegistry;
  }) {}

  async ensureSessionConfigured(session: Session): Promise<void> {
    if (session === electronSession.defaultSession) {
      throw new Error("App panel created without dedicated session partition");
    }
    if (this.configuredSessions.has(session)) return;

    await session.setProxy({
      proxyRules: `http=127.0.0.1:${this.deps.proxyPort};https=127.0.0.1:${this.deps.proxyPort}`,
      proxyBypassRules: "",
    });

    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...(details.requestHeaders ?? {}) };
      if (details.url.startsWith("http://")) {
        const callerId = this.callerIdFor(details.webContentsId, details.webContents?.id);
        if (callerId) {
          headers["Proxy-Authorization"] = this.proxyAuthorizationFor(callerId);
        } else {
          log.warn(`Panel request has no registered callerId: ${details.url}`);
        }
      }
      callback({ requestHeaders: headers });
    });

    session.webRequest.onHeadersReceived((details, callback) => {
      const callerId = this.callerIdFor(details.webContentsId, details.webContents?.id);
      callback({
        responseHeaders: callerId
          ? withCorsRelaxedHeaders(details.responseHeaders, this.requestOrigin(details) ?? "*")
          : details.responseHeaders,
      });
    });

    this.installLoginHandler();
    this.configuredSessions.add(session);
  }

  clearAssertionCache(): void {
    this.assertionCache.clear();
  }

  private installLoginHandler(): void {
    if (this.loginHandlerInstalled) return;
    this.loginHandlerInstalled = true;
    app.on("login", (event, webContents, _request, authInfo, callback) => {
      if (
        !authInfo.isProxy ||
        authInfo.host !== "127.0.0.1" ||
        Number(authInfo.port) !== this.deps.proxyPort ||
        authInfo.scheme !== "basic"
      ) {
        return;
      }
      const callerId = webContents ? this.deps.panelRegistry.callerIdFor(webContents.id) : null;
      if (!callerId) return;
      event.preventDefault();
      callback("natstack", this.assertionFor(callerId));
    });
  }

  private callerIdFor(...ids: Array<number | undefined>): string | null {
    for (const id of ids) {
      if (typeof id !== "number") continue;
      const callerId = this.deps.panelRegistry.callerIdFor(id);
      if (callerId) return callerId;
    }
    return null;
  }

  private proxyAuthorizationFor(callerId: string): string {
    return `Basic ${Buffer.from(`natstack:${this.assertionFor(callerId)}`, "utf8").toString("base64")}`;
  }

  private assertionFor(callerId: string): string {
    const cached = this.assertionCache.get(callerId);
    if (cached) return cached;
    const assertion = mintCallerAssertion(this.deps.assertionSecret, {
      callerId,
      callerKind: "panel",
      audience: "egress-proxy",
    });
    this.assertionCache.set(callerId, assertion);
    return assertion;
  }

  private requestOrigin(details: Electron.OnHeadersReceivedListenerDetails): string | null {
    if (details.referrer) return httpOrigin(details.referrer);
    const url =
      details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : "";
    return url ? httpOrigin(url) : null;
  }
}

function httpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function withCorsRelaxedHeaders(
  responseHeaders: Record<string, string[]> | undefined,
  requestOrigin: string,
): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("access-control-")) headers[key] = value;
  }
  headers["access-control-allow-origin"] = [requestOrigin];
  headers["access-control-allow-headers"] = ["*"];
  headers["access-control-allow-methods"] = ["GET, POST, PUT, PATCH, DELETE, OPTIONS"];
  headers["access-control-allow-credentials"] = ["true"];
  headers["access-control-expose-headers"] = ["*"];
  return headers;
}
