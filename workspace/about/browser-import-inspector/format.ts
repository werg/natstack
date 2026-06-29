/**
 * Pure formatting + error helpers for the Browser Migration & State panel.
 * Kept free of `@workspace/runtime` imports so they are unit-testable in a plain
 * Node/vitest environment (no panel runtime required).
 */

export type AsyncStatus = "idle" | "loading" | "ready" | "denied" | "error";

export interface AsyncState<T> {
  status: AsyncStatus;
  data?: T;
  error?: string;
}

interface ErrnoLike {
  code?: string;
  message?: string;
}

export function classifyError(err: unknown): { status: "denied" | "error"; message: string } {
  const e = err as ErrnoLike;
  const message = e?.message ?? String(err);
  const denied =
    e?.code === "EACCES" || /denied by user/i.test(message) || /\bEACCES\b/.test(message);
  return { status: denied ? "denied" : "error", message };
}

export function relativeTime(ms: number | null | undefined, now: number): string {
  if (!ms) return "never";
  const delta = now - ms;
  if (delta < 0) return "just now";
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function mask(value: string, revealed: boolean): string {
  if (revealed) return value;
  if (!value) return "";
  return "•".repeat(Math.min(12, Math.max(4, value.length)));
}

export const DATA_TYPES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "bookmarks", label: "Bookmarks" },
  { key: "history", label: "History" },
  { key: "cookies", label: "Cookies" },
  { key: "passwords", label: "Passwords" },
  { key: "autofill", label: "Autofill" },
  { key: "searchEngines", label: "Search engines" },
  { key: "permissions", label: "Permissions" },
  { key: "favicons", label: "Favicons" },
];
