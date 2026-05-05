export type UrlAudienceMatch = "origin" | "path-prefix" | "exact";

export interface UrlAudience {
  url: string;
  match: UrlAudienceMatch;
}

export interface CredentialHeaderInjection {
  type: "header";
  name: string;
  valueTemplate: string;
  stripIncoming?: string[];
}

export interface CredentialQueryParamInjection {
  type: "query-param";
  name: string;
}

export interface CredentialBasicAuthInjection {
  type: "basic-auth";
  usernameTemplate: string;
  passwordTemplate: string;
  stripIncoming?: string[];
}

export interface CredentialOAuth1SignatureInjection {
  type: "oauth1-signature";
}

export interface CredentialCookieInjection {
  type: "cookie";
}

export type CredentialInjection =
  | CredentialHeaderInjection
  | CredentialQueryParamInjection
  | CredentialBasicAuthInjection
  | CredentialOAuth1SignatureInjection
  | CredentialCookieInjection;

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const BLOCKED_INJECTION_HEADERS = new Set([
  "host",
  "content-length",
  "cookie",
]);

const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function normalizeUrlAudience(audience: UrlAudience): UrlAudience {
  const parsed = parseCredentialUrl(audience.url);
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.port === DEFAULT_PORTS[parsed.protocol]) {
    parsed.port = "";
  }

  parsed.pathname = decodeUnreservedPath(parsed.pathname);

  if (audience.match === "origin") {
    parsed.pathname = "/";
    parsed.search = "";
  } else if (audience.match === "path-prefix") {
    parsed.search = "";
    parsed.pathname = normalizePathPrefix(parsed.pathname);
  }

  return {
    match: audience.match,
    url: parsed.toString(),
  };
}

export function normalizeUrlAudiences(audiences: readonly UrlAudience[]): UrlAudience[] {
  if (audiences.length === 0) {
    throw new Error("At least one credential audience is required");
  }
  const normalized = audiences.map(normalizeUrlAudience);
  const unique = new Map<string, UrlAudience>();
  for (const audience of normalized) {
    unique.set(`${audience.match}\0${audience.url}`, audience);
  }
  return Array.from(unique.values());
}

export function urlMatchesAudience(targetUrl: string | URL, audience: UrlAudience): boolean {
  const normalizedAudience = normalizeUrlAudience(audience);
  const target = normalizeUrlForMatch(targetUrl, normalizedAudience.match);
  const expected = new URL(normalizedAudience.url);

  if (target.protocol !== expected.protocol || target.host !== expected.host) {
    return false;
  }

  if (normalizedAudience.match === "origin") {
    return true;
  }

  if (normalizedAudience.match === "exact") {
    return target.toString() === expected.toString();
  }

  const basePath = normalizePathPrefix(expected.pathname);
  const targetPath = normalizePathPrefix(target.pathname);
  if (basePath === "/") {
    return true;
  }
  return targetPath === basePath || targetPath.startsWith(`${basePath}/`);
}

export function findMatchingUrlAudience(targetUrl: string | URL, audiences: readonly UrlAudience[]): UrlAudience | null {
  for (const audience of audiences) {
    if (urlMatchesAudience(targetUrl, audience)) {
      return normalizeUrlAudience(audience);
    }
  }
  return null;
}

export function normalizeCredentialInjection(injection: CredentialInjection): CredentialInjection {
  if (injection.type === "oauth1-signature" || injection.type === "cookie") {
    return { type: injection.type };
  }

  if (injection.type === "query-param") {
    validateQueryParamName(injection.name);
    return { type: "query-param", name: injection.name };
  }

  if (injection.type === "basic-auth") {
    validateCredentialPartTemplate(injection.usernameTemplate, { requireToken: false });
    validateCredentialPartTemplate(injection.passwordTemplate, { requireToken: true });
    return {
      type: "basic-auth",
      usernameTemplate: injection.usernameTemplate,
      passwordTemplate: injection.passwordTemplate,
      stripIncoming: normalizeStripIncoming(injection.stripIncoming ?? []),
    };
  }

  const name = injection.name.toLowerCase();
  validateHeaderName(name);
  validateHeaderTemplate(injection.valueTemplate);
  return {
    type: "header",
    name,
    valueTemplate: injection.valueTemplate,
    stripIncoming: normalizeStripIncoming(injection.stripIncoming ?? []),
  };
}

export function renderCredentialHeaderValue(template: string, token: string): string {
  const rendered = template.replace("{token}", token);
  if (CONTROL_CHAR_RE.test(rendered)) {
    throw new Error("Rendered credential header value contains control characters");
  }
  return rendered;
}

export function renderCredentialBasicAuthValue(injection: CredentialBasicAuthInjection, token: string): string {
  const username = renderCredentialHeaderValue(injection.usernameTemplate, token);
  const password = renderCredentialHeaderValue(injection.passwordTemplate, token);
  return `Basic ${base64EncodeUtf8(`${username}:${password}`)}`;
}

export function credentialCarrierStripHeaders(injection: CredentialInjection): string[] {
  const headers = new Set(["authorization", "proxy-authorization", "x-api-key"]);
  if (injection.type === "header") {
    headers.add(injection.name.toLowerCase());
    for (const name of injection.stripIncoming ?? []) {
      headers.add(name.toLowerCase());
    }
  } else if (injection.type === "basic-auth") {
    for (const name of injection.stripIncoming ?? []) {
      headers.add(name.toLowerCase());
    }
  }
  return Array.from(headers);
}

function parseCredentialUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Credential audience URL must be absolute: ${raw}`);
  }

  if (parsed.origin === "null") {
    throw new Error("Credential audience URL must not have an opaque origin");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credential audience URL must not include username or password");
  }
  if (parsed.hostname.endsWith(".")) {
    throw new Error("Credential audience URL must not use a trailing-dot hostname");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHttpHost(parsed.hostname))) {
    throw new Error("Credential audience URL must use HTTPS unless it targets localhost or loopback HTTP");
  }
  return parsed;
}

function normalizeUrlForMatch(targetUrl: string | URL, match: UrlAudienceMatch): URL {
  const normalized = normalizeUrlAudience({ url: targetUrl.toString(), match }).url;
  return new URL(normalized);
}

function normalizePathPrefix(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "/";
  }
  return pathname.replace(/\/+$/, "");
}

function decodeUnreservedPath(pathname: string): string {
  return pathname.replace(/%[0-9a-fA-F]{2}/g, (encoded) => {
    const char = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : encoded.toUpperCase();
  });
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) {
    return false;
  }
  return Number(ipv4[1]) === 127;
}

function validateHeaderName(name: string): void {
  if (!HTTP_TOKEN_RE.test(name)) {
    throw new Error(`Invalid credential header name: ${name}`);
  }
  if (CONTROL_CHAR_RE.test(name)) {
    throw new Error("Credential header name contains control characters");
  }
  if (HOP_BY_HOP_HEADERS.has(name) || BLOCKED_INJECTION_HEADERS.has(name) || name.startsWith("proxy-")) {
    throw new Error(`Credential header cannot be injected into ${name}`);
  }
}

function validateHeaderTemplate(template: string): void {
  validateCredentialPartTemplate(template, { requireToken: true });
}

function validateCredentialPartTemplate(template: string, opts: { requireToken: boolean }): void {
  if (template.length === 0 || template.length > 256) {
    throw new Error("Credential header template must be between 1 and 256 characters");
  }
  if (CONTROL_CHAR_RE.test(template)) {
    throw new Error("Credential header template contains control characters");
  }
  const placeholders = template.match(/\{token\}/g) ?? [];
  if (opts.requireToken && placeholders.length !== 1) {
    throw new Error("Credential header template must contain exactly one {token} placeholder");
  }
  if (!opts.requireToken && placeholders.length > 1) {
    throw new Error("Credential header template must contain at most one {token} placeholder");
  }
}

function base64EncodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  const maybeBuffer = (globalThis as { Buffer?: { from(input: string, encoding: "binary"): { toString(encoding: "base64"): string } } }).Buffer;
  if (maybeBuffer) {
    return maybeBuffer.from(binary, "binary").toString("base64");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += alphabet[a >> 2];
    output += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? "=" : alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? "=" : alphabet[c & 0x3f];
  }
  return output;
}

function validateQueryParamName(name: string): void {
  if (!name || CONTROL_CHAR_RE.test(name) || /[&=#/\\?]/.test(name)) {
    throw new Error(`Invalid credential query parameter name: ${name}`);
  }
}

function normalizeStripIncoming(names: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const name of names) {
    const lower = name.toLowerCase();
    validateHeaderName(lower);
    normalized.add(lower);
  }
  return Array.from(normalized).sort((left, right) => left.localeCompare(right));
}
