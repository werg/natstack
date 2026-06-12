/**
 * Per-panel console + lifecycle history with bounded ring buffers, matching
 * the Electron CdpHostProvider semantics (src/main/cdpHostProvider.ts): 1000
 * entries / 500 errors, dropped counters, level filtering, and host-recorded
 * lifecycle records (crashes, failed loads) marked source:"lifecycle".
 */

export type ConsoleLevel = "debug" | "info" | "warning" | "error" | "unknown";

export interface ConsoleHistoryEntry {
  timestamp: number;
  level: ConsoleLevel;
  message: string;
  line: number;
  sourceId: string;
  url: string;
  source?: "console" | "lifecycle";
  fields?: Record<string, unknown>;
}

export interface ConsoleHistoryResult {
  entries: ConsoleHistoryEntry[];
  errors: ConsoleHistoryEntry[];
  dropped: { entries: number; errors: number };
  capacity: { entries: number; errors: number };
}

export interface ConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: ConsoleLevel[];
}

const ENTRY_CAPACITY = 1_000;
const ERROR_CAPACITY = 500;

class PanelHistory {
  entries: ConsoleHistoryEntry[] = [];
  errors: ConsoleHistoryEntry[] = [];
  droppedEntries = 0;
  droppedErrors = 0;
}

export class ConsoleHistoryStore {
  private readonly panels = new Map<string, PanelHistory>();

  record(slotId: string, entry: ConsoleHistoryEntry): void {
    const history = this.panels.get(slotId) ?? new PanelHistory();
    this.panels.set(slotId, history);
    history.entries.push(entry);
    while (history.entries.length > ENTRY_CAPACITY) {
      history.entries.shift();
      history.droppedEntries += 1;
    }
    if (entry.level === "error") {
      history.errors.push(entry);
      while (history.errors.length > ERROR_CAPACITY) {
        history.errors.shift();
        history.droppedErrors += 1;
      }
    }
  }

  recordLifecycle(slotId: string, message: string, fields?: Record<string, unknown>): void {
    this.record(slotId, {
      timestamp: Date.now(),
      level: "error",
      message,
      line: 0,
      sourceId: "lifecycle",
      url: "",
      source: "lifecycle",
      fields,
    });
  }

  query(slotId: string, options: ConsoleHistoryOptions = {}): ConsoleHistoryResult {
    const history = this.panels.get(slotId) ?? new PanelHistory();
    const levels = options.levels ? new Set(options.levels) : null;
    const entries = levels
      ? history.entries.filter((entry) => levels.has(entry.level))
      : history.entries;
    const limit = clampLimit(options.limit, entries.length, ENTRY_CAPACITY);
    const errorLimit = clampLimit(options.errorLimit, history.errors.length, ERROR_CAPACITY);
    return {
      entries: limit > 0 ? entries.slice(-limit) : [],
      errors: errorLimit > 0 ? history.errors.slice(-errorLimit) : [],
      dropped: { entries: history.droppedEntries, errors: history.droppedErrors },
      capacity: { entries: ENTRY_CAPACITY, errors: ERROR_CAPACITY },
    };
  }

  clear(slotId: string): void {
    this.panels.delete(slotId);
  }
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Math.min(fallback, max);
  return Math.max(0, Math.min(Math.floor(value), max));
}

/** Map a CDP Runtime.consoleAPICalled type to our level vocabulary. */
export function levelFromConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case "debug":
      return "debug";
    case "warning":
      return "warning";
    case "error":
    case "assert":
      return "error";
    case "log":
    case "info":
      return "info";
    default:
      return "unknown";
  }
}
