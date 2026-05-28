import * as fs from "node:fs";
import * as path from "node:path";

export type RuntimeDiagnosticKind = "panel" | "worker" | "do" | "extension" | "app";
export type RuntimeDiagnosticLevel = "debug" | "info" | "warn" | "error";
export type RuntimeDiagnosticSource =
  | "console"
  | "ctx.log"
  | "stdout"
  | "stderr"
  | "lifecycle"
  | "system";

export interface RuntimeDiagnosticRecord {
  workspaceId?: string;
  entityId: string;
  kind: RuntimeDiagnosticKind;
  timestamp: number;
  level: RuntimeDiagnosticLevel;
  message: string;
  source: RuntimeDiagnosticSource;
  fields?: Record<string, unknown>;
  url?: string;
  line?: number;
  sourceId?: string;
}

export interface RuntimeDiagnosticHistory {
  entries: RuntimeDiagnosticRecord[];
  errors: RuntimeDiagnosticRecord[];
  dropped: {
    entries: number;
    errors: number;
  };
  capacity: {
    entries: number;
    errors: number;
  };
}

export interface RuntimeDiagnosticOptions {
  limit?: number;
  errorLimit?: number;
  level?: RuntimeDiagnosticLevel;
  since?: number;
}

interface PersistedRuntimeDiagnostics {
  entries: RuntimeDiagnosticRecord[];
  errors: RuntimeDiagnosticRecord[];
  droppedEntries: number;
  droppedErrors: number;
}

const DEFAULT_ENTRY_CAPACITY = 1_000;
const DEFAULT_ERROR_CAPACITY = 500;
const LEVEL_RANK: Record<RuntimeDiagnosticLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class RuntimeDiagnosticsStore {
  private readonly rootDir: string;
  private readonly entryCapacity: number;
  private readonly errorCapacity: number;
  private readonly cache = new Map<string, PersistedRuntimeDiagnostics>();

  constructor(options: { statePath: string; entryCapacity?: number; errorCapacity?: number }) {
    this.rootDir = path.join(options.statePath, "runtime-diagnostics");
    this.entryCapacity = options.entryCapacity ?? DEFAULT_ENTRY_CAPACITY;
    this.errorCapacity = options.errorCapacity ?? DEFAULT_ERROR_CAPACITY;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  record(input: Omit<RuntimeDiagnosticRecord, "timestamp"> & { timestamp?: number }): void {
    const record: RuntimeDiagnosticRecord = {
      ...input,
      timestamp: input.timestamp ?? Date.now(),
    };
    const history = this.historyFor(record.entityId);
    history.entries.push(record);
    while (history.entries.length > this.entryCapacity) {
      history.entries.shift();
      history.droppedEntries += 1;
    }
    if (record.level === "error") {
      history.errors.push(record);
      while (history.errors.length > this.errorCapacity) {
        history.errors.shift();
        history.droppedErrors += 1;
      }
    }
    this.write(record.entityId, history);
  }

  history(entityId: string, options: RuntimeDiagnosticOptions = {}): RuntimeDiagnosticHistory {
    const history = this.historyFor(entityId);
    const minRank = options.level ? LEVEL_RANK[options.level] : null;
    const entries = history.entries.filter(
      (record) =>
        (options.since === undefined || record.timestamp >= options.since) &&
        (minRank === null || LEVEL_RANK[record.level] >= minRank)
    );
    const errors = history.errors.filter(
      (record) => options.since === undefined || record.timestamp >= options.since
    );
    const limit = normalizeLimit(options.limit, entries.length, this.entryCapacity);
    const errorLimit = normalizeLimit(options.errorLimit, errors.length, this.errorCapacity);
    return {
      entries: limit > 0 ? entries.slice(-limit) : [],
      errors: errorLimit > 0 ? errors.slice(-errorLimit) : [],
      dropped: {
        entries: history.droppedEntries,
        errors: history.droppedErrors,
      },
      capacity: {
        entries: this.entryCapacity,
        errors: this.errorCapacity,
      },
    };
  }

  private historyFor(entityId: string): PersistedRuntimeDiagnostics {
    const existing = this.cache.get(entityId);
    if (existing) return existing;
    const loaded = this.read(entityId);
    this.cache.set(entityId, loaded);
    return loaded;
  }

  private read(entityId: string): PersistedRuntimeDiagnostics {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath(entityId), "utf8")
      ) as Partial<PersistedRuntimeDiagnostics>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        droppedEntries: typeof parsed.droppedEntries === "number" ? parsed.droppedEntries : 0,
        droppedErrors: typeof parsed.droppedErrors === "number" ? parsed.droppedErrors : 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { entries: [], errors: [], droppedEntries: 0, droppedErrors: 0 };
    }
  }

  private write(entityId: string, history: PersistedRuntimeDiagnostics): void {
    const filePath = this.filePath(entityId);
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(history), "utf8");
    fs.renameSync(tmpPath, filePath);
  }

  private filePath(entityId: string): string {
    const encoded = Buffer.from(entityId).toString("base64url");
    return path.join(this.rootDir, `${encoded}.json`);
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), max));
}
