// Parsing + validation for `natstack://connect?url=…&token=…` deep links.
//
// The deep-link flow is user-triggered onboarding (scan QR, tap link), which
// means any installed Android app can fire one. Without validation, an
// attacker could redirect the client to a server they control with a token
// they chose. The checks below constrain what can be auto-applied:
//
//   - Only http:// or https:// server URLs.
//   - http:// is accepted only for hosts where cleartext is either local to
//     the device, on a private LAN segment, or inside a Tailscale tailnet
//     (which already encrypts end-to-end). Everything else requires https.
//   - Token must match a plausible character set/length so obvious junk is
//     rejected before we try to authenticate with it.
//
// The UI layer is still responsible for asking the user to confirm before
// overwriting credentials — this module only decides whether the link is
// structurally safe to propose.

export type ConnectDeepLinkResult =
  | { kind: "ok"; serverUrl: string; shellToken: string }
  | { kind: "error"; reason: string };

const CONNECT_PREFIX = "natstack://connect";
// Shell tokens are base64url-ish (A-Z, a-z, 0-9, -, _). Keep a generous range
// to avoid false negatives while still rejecting whitespace / odd punctuation.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const TS_NET_SUFFIX = ".ts.net";

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2";
}

function isPrivateIPv4(host: string): boolean {
  if (/^10\./.test(host)) return true;
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (/^192\.168\./.test(host)) return true;
  return false;
}

function isTailscaleIPv4(host: string): boolean {
  // CGNAT 100.64.0.0/10 — used for Tailscale MagicDNS / raw tailnet IPs.
  const m = host.match(/^100\.(\d+)\./);
  if (!m) return false;
  const octet = Number(m[1]);
  return octet >= 64 && octet <= 127;
}

/** Exposed for tests. Returns true when cleartext HTTP to `host` is acceptable. */
export function isTrustedCleartextHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (isLoopbackHost(lower)) return true;
  if (isPrivateIPv4(lower)) return true;
  if (isTailscaleIPv4(lower)) return true;
  if (lower === "ts.net" || lower.endsWith(TS_NET_SUFFIX)) return true;
  return false;
}

export function parseConnectDeepLink(rawUrl: string): ConnectDeepLinkResult {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(CONNECT_PREFIX)) {
    return { kind: "error", reason: "Not a natstack://connect link" };
  }

  let deepLink: URL;
  try {
    deepLink = new URL(rawUrl);
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }

  const serverUrlRaw = deepLink.searchParams.get("url");
  const shellToken = deepLink.searchParams.get("token");
  if (!serverUrlRaw || !shellToken) {
    return { kind: "error", reason: "Deep link is missing `url` or `token`" };
  }

  let server: URL;
  try {
    server = new URL(serverUrlRaw);
  } catch {
    return { kind: "error", reason: `Server URL is not parseable: ${serverUrlRaw}` };
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
      reason: `Cleartext HTTP is only allowed for loopback, private LAN, or Tailscale hosts. Use https:// for ${server.hostname}.`,
    };
  }

  if (!TOKEN_PATTERN.test(shellToken)) {
    return { kind: "error", reason: "Shell token has an unexpected format" };
  }

  // Normalize: drop path/query/hash from the advertised server URL so we
  // store a canonical origin. Matches the format buildWsUrl expects.
  const canonical = `${server.protocol}//${server.host}`;
  return { kind: "ok", serverUrl: canonical, shellToken };
}
