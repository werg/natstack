import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

// Standalone, dependency-free mirror of the WebRTC pairing grammar in
// packages/shared/src/connect.ts. This file must run under raw `node` with no
// workspace deps, so the logic is vendored here. connect.ts and this file are
// held in lockstep by the parity test in packages/shared/src/connect.test.ts —
// keep the create/parse/validate behavior byte-identical (any divergence is a
// pairing-security bug, e.g. an over-permissive loopback or fingerprint match).

const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;
const PAIRING_ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const FINGERPRINT_HEX_PATTERN = /^[0-9A-Fa-f]{64}$/;
const PAIRING_PROTOCOL_VERSION = 1;

/** Strip colons/whitespace and upper-case a DTLS fingerprint for comparison. */
export function normalizeFingerprint(fp) {
  return fp.replace(/[:\s]/g, "").toUpperCase();
}

export function createConnectDeepLink(pairing) {
  const params = [
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

export function parseConnectLink(rawUrl) {
  if (typeof rawUrl !== "string") return { kind: "error", reason: "Deep link must be a string" };
  if (!rawUrl.startsWith("natstack://connect")) {
    return { kind: "error", reason: "Not a natstack://connect link" };
  }
  const queryStart = rawUrl.indexOf("?");
  if (queryStart < 0) {
    return { kind: "error", reason: "Deep link is missing pairing parameters" };
  }
  const params = parseQuery(rawUrl.slice(queryStart + 1));
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
    ice: ice ?? "all",
    srv: params.values.get("srv") || undefined,
  };
}

/** The signaling endpoint is a public wss/https URL (ws/http allowed for loopback dev). */
export function parseSignalingEndpoint(raw) {
  let endpoint;
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

function parseQuery(raw) {
  const values = new Map();
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

function decodeQueryComponent(raw) {
  try {
    return { kind: "ok", value: decodeURIComponent(raw.replace(/\+/g, " ")) };
  } catch {
    return { kind: "error", reason: "Deep link is not a valid URL" };
  }
}

export function parseConnectServerUrl(rawUrl) {
  let server;
  try {
    server = new URL(rawUrl);
  } catch {
    return { kind: "error", reason: `Server URL is not parseable: ${rawUrl}` };
  }
  if (server.protocol !== "http:" && server.protocol !== "https:") {
    return {
      kind: "error",
      reason: `Server URL must use http:// or https:// (got ${server.protocol || "no scheme"})`,
    };
  }
  if (!server.hostname) return { kind: "error", reason: "Server URL is missing a hostname" };
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
 * Loopback-only cleartext gate (mirror of connect.ts isLoopbackHost). The data
 * plane no longer rides a cleartext LAN/Tailscale origin — remote is WebRTC
 * (DTLS-encrypted), local co-located mode is loopback. `10.0.2.2` is kept for
 * the Android emulator's host loopback alias.
 */
export function isLoopbackHost(host) {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}

export function printConnectBanner({
  title,
  pairing,
  qrPairingCode = null,
  deepLinkLabel = "Deep link",
  instructions = "Open the QR code with the Android camera. NatStack will confirm and save the connection.",
}) {
  const deepLink = createConnectDeepLink(pairing);
  const effectiveQrCode = qrPairingCode || pairing.code;
  const qrDeepLink = createConnectDeepLink({ ...pairing, code: effectiveQrCode });
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Room:        ${pairing.room}`);
  console.log(`  Fingerprint: ${pairing.fp}`);
  console.log(`  Signaling:   ${pairing.sig}`);
  console.log(`  Pair code:   ${pairing.code}`);
  if (effectiveQrCode !== pairing.code) {
    console.log(`  QR code:     ${effectiveQrCode}`);
  }
  console.log(`  ${deepLinkLabel}:  ${deepLink}`);
  if (effectiveQrCode !== pairing.code) {
    console.log(`  QR ${deepLinkLabel}:  ${qrDeepLink}`);
  }
  console.log();
  qrcode.generate(qrDeepLink, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}
