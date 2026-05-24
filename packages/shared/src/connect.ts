export const CONNECT_DEEP_LINK_SCHEME = "natstack:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

export type ConnectLink =
  | { kind: "ok"; url: string; code: string }
  | { kind: "error"; reason: string };

export function createConnectDeepLink(url: string, code: string): string {
  return `natstack://connect?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`;
}

export function parseConnectLink(raw: string): ConnectLink {
  if (typeof raw !== "string") {
    return { kind: "error", reason: "Deep link must be a string" };
  }

  let deepLink: URL;
  try {
    deepLink = new URL(raw);
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }

  if (
    deepLink.protocol !== CONNECT_DEEP_LINK_SCHEME ||
    deepLink.hostname !== CONNECT_DEEP_LINK_HOST
  ) {
    return { kind: "error", reason: "Not a natstack://connect link" };
  }

  const serverUrl = deepLink.searchParams.get("url");
  const code = deepLink.searchParams.get("code");
  if (!serverUrl || !code) {
    return { kind: "error", reason: "Deep link is missing `url` or `code`" };
  }

  const parsedUrl = parseConnectServerUrl(serverUrl);
  if (parsedUrl.kind === "error") return parsedUrl;

  if (!PAIRING_CODE_PATTERN.test(code)) {
    return { kind: "error", reason: "Pairing code has an unexpected format" };
  }

  return { kind: "ok", url: parsedUrl.url, code };
}

export function parseConnectServerUrl(raw: string): { kind: "ok"; url: string } | ConnectLink {
  let server: URL;
  try {
    server = new URL(raw);
  } catch {
    return { kind: "error", reason: `Server URL is not parseable: ${raw}` };
  }

  if (server.protocol !== "http:" && server.protocol !== "https:") {
    return {
      kind: "error",
      reason: `Server URL must use http:// or https:// (got ${server.protocol || "no scheme"})`,
    };
  }

  if (!server.hostname) {
    return { kind: "error", reason: "Server URL is missing a hostname" };
  }

  if (server.protocol === "http:" && !isTrustedCleartextHost(server.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for ${server.hostname}.`,
    };
  }

  return { kind: "ok", url: canonicalServerBaseUrl(server) };
}

export function resolveServerRouteUrl(baseUrl: string | URL, route: string): URL {
  const base = typeof baseUrl === "string" ? new URL(baseUrl) : new URL(baseUrl.href);
  const routeUrl = new URL(route.startsWith("/") ? route : `/${route}`, "http://natstack.route");
  const basePath = normalizeBasePath(base.pathname);
  base.pathname = `${basePath}${routeUrl.pathname}`;
  base.search = routeUrl.search;
  base.hash = "";
  return base;
}

export function resolveServerWsUrl(baseUrl: string | URL, route = "/rpc"): string {
  const url = resolveServerRouteUrl(baseUrl, route);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else {
    throw new Error(`Server URL must use http:// or https:// (got ${url.protocol || "no scheme"})`);
  }
  return url.toString();
}

export function isTrustedCleartextHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (/^127\.(\d{1,3}\.){2}\d{1,3}$/.test(lower)) return true;
  if (isPrivateIPv4(lower)) return true;
  if (isTailscaleIPv4(lower)) return true;
  if (lower === "ts.net" || lower.endsWith(".ts.net")) return true;
  if (isSingleLabelHostname(lower)) return true;
  if (lower.endsWith(".local")) return true;
  return false;
}

function canonicalServerBaseUrl(server: URL): string {
  return `${server.protocol}//${server.host}${normalizeBasePath(server.pathname)}`;
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  return `/${pathname.replace(/^\/+|\/+$/g, "")}`;
}

function isSingleLabelHostname(host: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  if (/^10\./.test(host)) return true;
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  return /^192\.168\./.test(host);
}

function isTailscaleIPv4(host: string): boolean {
  const m = host.match(/^100\.(\d+)\./);
  if (!m) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}
