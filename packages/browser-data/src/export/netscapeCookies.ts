import type { ImportedCookie } from "../types.js";

export function exportNetscapeCookies(cookies: ImportedCookie[]): string {
  const lines: string[] = ["# Netscape HTTP Cookie File"];

  for (const cookie of cookies) {
    const domain = cookie.domain;
    const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = cookie.path;
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expiry =
      cookie.expirationDate != null
        ? String(Math.floor(cookie.expirationDate / 1000))
        : "0";
    const name = cookie.name;
    const value = cookie.value;

    lines.push(
      [domain, flag, path, secure, expiry, name, value].join("\t"),
    );
  }

  return lines.join("\n") + "\n";
}
