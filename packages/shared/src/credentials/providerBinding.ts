import { createHash } from "node:crypto";
import type { AuthInjection, ProviderManifest } from "./types.js";

export interface ProviderBindingInjection {
  type: "header" | "query-param";
  name: string;
  valueTemplate?: string;
  strippedHeaders: string[];
}

export interface ProviderBinding {
  fingerprint: string;
  audience: string[];
  injection: ProviderBindingInjection;
}

export function createProviderBinding(provider: ProviderManifest): ProviderBinding {
  const audience = normalizeApiBase(provider.apiBase);
  const injection = normalizeAuthInjection(provider.authInjection);
  const canonical = {
    audience,
    injection,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url");
  return { fingerprint, audience, injection };
}

export function credentialMatchesProviderBinding(
  credential: { providerFingerprint?: string },
  provider: ProviderManifest,
): boolean {
  return credential.providerFingerprint === createProviderBinding(provider).fingerprint;
}

export function normalizeApiBase(apiBase: readonly string[]): string[] {
  return Array.from(new Set(apiBase.map((raw) => normalizeUrlPrefix(raw)))).sort((a, b) => a.localeCompare(b));
}

export function normalizeUrlPrefix(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const decodedPath = decodeUnreservedPath(url.pathname);
  url.pathname = decodedPath === "/" ? "/" : decodedPath.replace(/\/+$/, "");
  url.search = "";
  return url.toString();
}

function normalizeAuthInjection(injection: AuthInjection | undefined): ProviderBindingInjection {
  if (!injection) {
    return {
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
      strippedHeaders: ["authorization"],
    };
  }
  if (injection.type === "query-param") {
    return {
      type: "query-param",
      name: injection.paramName ?? "",
      strippedHeaders: normalizeHeaderNames(injection.stripHeaders ?? []),
    };
  }
  const headerName = injection.headerName ?? "authorization";
  return {
    type: "header",
    name: headerName.toLowerCase(),
    valueTemplate: injection.valueTemplate ?? "Bearer {token}",
    strippedHeaders: normalizeHeaderNames(injection.stripHeaders ?? ["authorization"]),
  };
}

function normalizeHeaderNames(names: readonly string[]): string[] {
  return Array.from(new Set(names.map((name) => name.toLowerCase()))).sort((a, b) => a.localeCompare(b));
}

function decodeUnreservedPath(pathname: string): string {
  return pathname.replace(/%[0-9a-fA-F]{2}/g, (encoded) => {
    const char = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9\-._~]/.test(char) ? char : encoded.toUpperCase();
  });
}
