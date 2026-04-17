// Minimal POSIX-only `path` shim for code from @natstack/shared that assumes
// Node. Only the handful of APIs used by the mobile import graph are provided.
// Keep this file in sync with usages as new shared code is pulled into mobile.

function normalizePosix(p: string): string {
  const isAbsolute = p.startsWith("/");
  const segments = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return isAbsolute ? "/" + joined : joined || ".";
}

export function isAbsolute(p: string): boolean {
  return typeof p === "string" && p.startsWith("/");
}

export function normalize(p: string): string {
  if (typeof p !== "string" || p.length === 0) return ".";
  const trailingSlash = p.endsWith("/") && p.length > 1;
  const result = normalizePosix(p);
  return trailingSlash && !result.endsWith("/") ? result + "/" : result;
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((p) => typeof p === "string" && p.length > 0);
  if (filtered.length === 0) return ".";
  return normalizePosix(filtered.join("/"));
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  let isAbs = false;
  for (let i = parts.length - 1; i >= 0 && !isAbs; i--) {
    const part = parts[i];
    if (typeof part !== "string" || part.length === 0) continue;
    resolved = resolved.length === 0 ? part : part + "/" + resolved;
    isAbs = part.startsWith("/");
  }
  if (!isAbs) resolved = "/" + resolved;
  return normalizePosix(resolved);
}

export function basename(p: string, ext?: string): string {
  if (typeof p !== "string") return "";
  const withoutTrailing = p.replace(/\/+$/, "");
  const idx = withoutTrailing.lastIndexOf("/");
  let base = idx === -1 ? withoutTrailing : withoutTrailing.slice(idx + 1);
  if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}

export function dirname(p: string): string {
  if (typeof p !== "string" || p.length === 0) return ".";
  const withoutTrailing = p.replace(/\/+$/, "");
  const idx = withoutTrailing.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return withoutTrailing.slice(0, idx);
}

export function extname(p: string): string {
  if (typeof p !== "string") return "";
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return "";
  return base.slice(idx);
}

export function relative(from: string, to: string): string {
  const fromAbs = resolve(from);
  const toAbs = resolve(to);
  if (fromAbs === toAbs) return "";
  const fromParts = fromAbs.split("/").filter(Boolean);
  const toParts = toAbs.split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const up = fromParts.length - common;
  const out: string[] = [];
  for (let i = 0; i < up; i++) out.push("..");
  out.push(...toParts.slice(common));
  return out.join("/");
}

export const sep = "/";
export const delimiter = ":";
export const posix = { isAbsolute, normalize, join, resolve, basename, dirname, extname, relative, sep, delimiter };

export default { isAbsolute, normalize, join, resolve, basename, dirname, extname, relative, sep, delimiter, posix };
