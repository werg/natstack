import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getCentralDataPath } from "@natstack/env-paths";

import type { AuditEntry } from "./types.js";

const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

function formatDateKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesFilter(
  entry: AuditEntry,
  filter?: Partial<Pick<AuditEntry, "workerId" | "providerId" | "connectionId" | "method">>,
): boolean {
  if (!filter) {
    return true;
  }

  if (filter.workerId !== undefined && entry.workerId !== filter.workerId) {
    return false;
  }

  if (filter.providerId !== undefined && entry.providerId !== filter.providerId) {
    return false;
  }

  if (filter.connectionId !== undefined && entry.connectionId !== filter.connectionId) {
    return false;
  }

  if (filter.method !== undefined && entry.method !== filter.method) {
    return false;
  }

  return true;
}

export class AuditLog {
  private readonly logDir: string;
  private readonly maxFileSizeBytes: number;

  constructor(opts?: { logDir?: string; maxFileSizeBytes?: number }) {
    this.logDir = opts?.logDir ?? path.join(getCentralDataPath(), "logs");
    this.maxFileSizeBytes = opts?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  }

  async append(entry: AuditEntry): Promise<void> {
    await mkdir(this.logDir, { recursive: true });

    const filePath = this.getLogPath(entry.ts);
    const serializedEntry = `${JSON.stringify(entry)}\n`;
    const nextEntrySize = Buffer.byteLength(serializedEntry);
    const currentSize = await this.getFileSize(filePath);

    if (currentSize + nextEntrySize > this.maxFileSizeBytes) {
      return;
    }

    await appendFile(filePath, serializedEntry, "utf8");
  }

  async query(opts?: {
    filter?: Partial<Pick<AuditEntry, "workerId" | "providerId" | "connectionId" | "method">>;
    limit?: number;
    after?: number;
  }): Promise<AuditEntry[]> {
    const filePath = this.getLogPath(Date.now());
    let fileContents: string;

    try {
      fileContents = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: AuditEntry[] = [];
    const lines = fileContents.split(/\r?\n/u);

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = JSON.parse(line) as AuditEntry;

      if (opts?.after !== undefined && parsed.ts <= opts.after) {
        continue;
      }

      if (!matchesFilter(parsed, opts?.filter)) {
        continue;
      }

      entries.push(parsed);

      if (opts?.limit !== undefined && entries.length >= opts.limit) {
        break;
      }
    }

    return entries;
  }

  close(): void {}

  private getLogPath(ts: number): string {
    return path.join(this.logDir, `credentials-audit-${formatDateKey(ts)}.jsonl`);
  }

  private async getFileSize(filePath: string): Promise<number> {
    try {
      const fileStats = await stat(filePath);
      return fileStats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }
}
