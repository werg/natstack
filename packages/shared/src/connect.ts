export const CONNECT_DEEP_LINK_SCHEME = "natstack:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

export type ConnectLink =
  | { kind: "ok"; url: string; code: string }
  | { kind: "error"; reason: string };
type QueryParseResult =
  | { kind: "ok"; values: Map<string, string> }
  | { kind: "error"; reason: string };
type QueryDecodeResult = { kind: "ok"; value: string } | { kind: "error"; reason: string };

export function createConnectDeepLink(url: string, code: string): string {
  return `natstack://connect?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`;
}

export function parseConnectLink(raw: string): ConnectLink {
  if (typeof raw !== "string") {
    return { kind: "error", reason: "Deep link must be a string" };
  }

  const prefix = `${CONNECT_DEEP_LINK_SCHEME}//${CONNECT_DEEP_LINK_HOST}`;
  if (!raw.startsWith(prefix)) {
    return { kind: "error", reason: "Not a natstack://connect link" };
  }

  const queryStart = raw.indexOf("?");
  if (queryStart < 0) {
    return { kind: "error", reason: "Deep link is missing `url` or `code`" };
  }
  const params = parseQuery(raw.slice(queryStart + 1));
  if (params.kind === "error") return params;

  const serverUrl = params.values.get("url");
  const code = params.values.get("code");
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

function parseQuery(raw: string): QueryParseResult {
  const values = new Map<string, string>();
  for (const part of raw.split("&")) {
    if (!part) continue;
    const separator = part.indexOf("=");
    const key = separator >= 0 ? part.slice(0, separator) : part;
    const value = separator >= 0 ? part.slice(separator + 1) : "";
    const decodedKey = decodeQueryComponent(key);
    const decodedValue = decodeQueryComponent(value);
    if (decodedKey.kind === "error") return decodedKey;
    if (decodedValue.kind === "error") return decodedValue;
    values.set(decodedKey.value, decodedValue.value);
  }
  return { kind: "ok", values };
}

function decodeQueryComponent(raw: string): QueryDecodeResult {
  try {
    return { kind: "ok", value: decodeURIComponent(raw.replace(/\+/g, " ")) };
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
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

  if (
    server.username ||
    server.password ||
    (server.pathname !== "" && server.pathname !== "/") ||
    server.search ||
    server.hash
  ) {
    return {
      kind: "error",
      reason: "Server URL must be an origin without a path, query, or fragment",
    };
  }

  if (server.protocol === "http:" && !isTrustedCleartextHost(server.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for ${server.hostname}.`,
    };
  }

  return { kind: "ok", url: `${server.protocol}//${server.host}` };
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
