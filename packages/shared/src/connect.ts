export const CONNECT_DEEP_LINK_SCHEME = "natstack:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
export const WORKSPACE_ROUTE_PREFIX = "/_workspace/";
/** Signaling rendezvous room id (UUID or base64url token). */
export const PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** DTLS SHA-256 fingerprint after stripping colons: 32 bytes = 64 hex chars. */
const FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
export const PAIRING_PROTOCOL_VERSION = 1;

export type TurnPolicy = "all" | "relay";

/**
 * The WebRTC pairing payload carried in the QR / deep link. Replaces the old
 * `url`+`code` server-origin link OUTRIGHT (no versioned shim): the shell no
 * longer dials a server URL — it joins a signaling room and pins the server's
 * DTLS fingerprint. `room`/`fp`/`code`/`sig` are required; `v`/`ice`/`srv` are
 * optional with documented defaults.
 */
export interface ConnectPairing {
  /** Unguessable signaling rendezvous room id. */
  room: string;
  /** Pinned server DTLS SHA-256 fingerprint (the QR `fp`). */
  fp: string;
  /** Pairing secret proving QR possession. */
  code: string;
  /** Signaling endpoint (decouples us from a hard-coded host). */
  sig: string;
  /** Protocol version (defaults to PAIRING_PROTOCOL_VERSION). */
  v?: number;
  /** TURN policy — force `relay` to validate TURN-over-TLS:443 (defaults `all`). */
  ice?: TurnPolicy;
  /** Optional server/workspace label to disambiguate servers. */
  srv?: string;
}

export type ConnectLink =
  | ({ kind: "ok" } & ConnectPairing)
  | { kind: "error"; reason: string };
type QueryParseResult =
  | { kind: "ok"; values: Map<string, string> }
  | { kind: "error"; reason: string };
type QueryDecodeResult = { kind: "ok"; value: string } | { kind: "error"; reason: string };

/** Strip colons/whitespace and upper-case a DTLS fingerprint for comparison. */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

export function createConnectDeepLink(pairing: ConnectPairing): string {
  const params: string[] = [
    `room=${encodeURIComponent(pairing.room)}`,
    `fp=${encodeURIComponent(pairing.fp)}`,
    `code=${encodeURIComponent(pairing.code)}`,
    `sig=${encodeURIComponent(pairing.sig)}`,
    `v=${encodeURIComponent(String(pairing.v ?? PAIRING_PROTOCOL_VERSION))}`,
    `ice=${encodeURIComponent(pairing.ice ?? "all")}`,
  ];
  if (pairing.srv) params.push(`srv=${encodeURIComponent(pairing.srv)}`);
  return `natstack://connect?${params.join("&")}`;
}

export function appendServerPath(baseUrl: string | URL, suffix: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = suffix.replace(/^\/+/, "");
  url.pathname = nextPath ? `${basePath}/${nextPath}` : basePath || "/";
  url.search = "";
  url.hash = "";
  return url;
}

// These take a BASE server URL (an origin, or a /_workspace/<name> selected-workspace URL) and
// append the canonical RPC path — the same contract as serverAuthRouteUrl/serverWorkspaceRouteUrl.
// Never pass an already-suffixed URL; there is deliberately no idempotency, so a workspace literally
// named "rpc" (URL .../_workspace/rpc) is handled correctly instead of colliding with the suffix.
export function serverRpcHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc");
}

export function serverRpcStreamHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc/stream");
}

export function serverRpcWsUrl(baseUrl: string | URL): string {
  const url = serverRpcHttpUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function serverCdpHostWsUrl(baseUrl: string | URL, hostConnectionId: string): string {
  const url = appendServerPath(baseUrl, "/api/cdp-host");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostConnectionId", hostConnectionId);
  return url.toString();
}

export function serverAuthRouteUrl(baseUrl: string | URL, route: string): URL {
  return appendServerPath(baseUrl, `/_r/s/auth/${route.replace(/^\/+/, "")}`);
}

export function serverWorkspaceRouteUrl(baseUrl: string | URL, route: string): URL {
  return appendServerPath(baseUrl, `/_r/s/workspaces/${route.replace(/^\/+/, "")}`);
}

export function selectedWorkspacePath(workspaceName: string): string {
  return `${WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(workspaceName)}`;
}

export function selectedWorkspaceUrl(baseUrl: string | URL, workspaceName: string): URL {
  return appendServerPath(baseUrl, selectedWorkspacePath(workspaceName));
}

export function selectedWorkspaceNameFromUrl(rawUrl: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.toString());
  } catch {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const match = pathname.match(/^\/_workspace\/([^/]+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isSelectedWorkspaceUrl(rawUrl: string | URL): boolean {
  return selectedWorkspaceNameFromUrl(rawUrl) !== null;
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
    return { kind: "error", reason: "Deep link is missing pairing parameters" };
  }
  // Manual (non-`new URL()`) query parse — the natstack: custom scheme is not
  // URL-parseable on RN/Hermes (asserted by connect.test.ts).
  const params = parseQuery(raw.slice(queryStart + 1));
  if (params.kind === "error") return params;

  const room = params.values.get("room");
  const fp = params.values.get("fp");
  const code = params.values.get("code");
  const sig = params.values.get("sig");
  if (!room || !fp || !code || !sig) {
    return { kind: "error", reason: "Deep link is missing `room`, `fp`, `code`, or `sig`" };
  }

  if (!PAIRING_ROOM_PATTERN.test(room)) {
    return { kind: "error", reason: "Signaling room id has an unexpected format" };
  }
  if (!FINGERPRINT_HEX_PATTERN.test(normalizeFingerprint(fp).toLowerCase())) {
    return { kind: "error", reason: "DTLS fingerprint must be a SHA-256 (64 hex chars)" };
  }
  if (!PAIRING_CODE_PATTERN.test(code)) {
    return { kind: "error", reason: "Pairing code has an unexpected format" };
  }
  const sigParsed = parseSignalingEndpoint(sig);
  if (sigParsed.kind === "error") return sigParsed;

  const ice = params.values.get("ice");
  if (ice && ice !== "all" && ice !== "relay") {
    return { kind: "error", reason: "TURN policy `ice` must be `all` or `relay`" };
  }
  const versionRaw = params.values.get("v");
  const v = versionRaw ? Number(versionRaw) : PAIRING_PROTOCOL_VERSION;
  if (!Number.isInteger(v) || v < 1) {
    return { kind: "error", reason: "Protocol version `v` must be a positive integer" };
  }

  return {
    kind: "ok",
    room,
    fp,
    code,
    sig: sigParsed.url,
    v,
    ice: (ice as TurnPolicy | undefined) ?? "all",
    srv: params.values.get("srv") || undefined,
  };
}

/** The signaling endpoint is a public wss/https URL (ws/http allowed for loopback dev). */
export function parseSignalingEndpoint(raw: string): { kind: "ok"; url: string } | { kind: "error"; reason: string } {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return { kind: "error", reason: `Signaling endpoint is not parseable: ${raw}` };
  }
  const proto = endpoint.protocol;
  if (proto !== "wss:" && proto !== "https:" && proto !== "ws:" && proto !== "http:") {
    return { kind: "error", reason: `Signaling endpoint must be ws(s)/http(s) (got ${proto || "no scheme"})` };
  }
  if ((proto === "ws:" || proto === "http:") && !isLoopbackHost(endpoint.hostname)) {
    return { kind: "error", reason: `Cleartext signaling is only allowed for loopback. Use wss:// for ${endpoint.hostname}.` };
  }
  return { kind: "ok", url: endpoint.toString() };
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

  if (server.protocol === "http:" && !isLoopbackHost(server.hostname)) {
    return {
      kind: "error",
      reason: `Cleartext HTTP is only allowed for loopback. Use https:// for ${server.hostname}.`,
    };
  }

  return { kind: "ok", url: `${server.protocol}//${server.host}` };
}

/**
 * Loopback-only cleartext gate (replaces the old isTrustedCleartextHost +
 * private-IP/Tailscale/single-label helpers, deleted with remote mode §8b). The
 * data plane no longer rides a cleartext LAN/Tailscale origin — remote is WebRTC
 * (DTLS-encrypted), local co-located mode is loopback. `10.0.2.2` is kept for
 * the Android emulator's host loopback alias.
 */
export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}
