export const DEFAULT_POLL_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_BRIEFING_INTERVAL_MS = 24 * 3_600_000;
export const DEFAULT_TOP_K = 12;
/** Prune unbriefed articles older than this during polls. */
export const ARTICLE_RETENTION_MS = 14 * 24 * 3_600_000;
/** A briefing stuck in "summarizing" longer than this is marked errored. */
export const BRIEFING_WATCHDOG_MS = 30 * 60_000;

export interface NewsChannelState {
  channelId: string;
  pollIntervalMs: number;
  briefingIntervalMs: number;
  /** Local-time anchor (minutes after midnight) for daily briefings. */
  briefingAtMinutes?: number;
  topK: number;
  setupStatus: "needs-user-preferences" | "configured";
  setupPromptedAt?: number;
  preferencesText?: string;
  lastBriefingId?: string;
  lastRunAt?: number;
  lastError?: string;
  lastSetupJson?: string;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
}
