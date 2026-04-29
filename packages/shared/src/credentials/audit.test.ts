import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLog } from "./audit.js";
import type { AuditEntry, ConnectionCredentialAuditEvent } from "./types.js";

function atLocalNoon(dayOffset = 0, hour = 12): number {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

function formatDateKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: atLocalNoon(),
    workerId: "worker-1",
    callerId: "caller-1",
    providerId: "provider-1",
    connectionId: "connection-1",
    method: "GET",
    url: "https://example.com/me",
    status: 200,
    durationMs: 42,
    bytesIn: 128,
    bytesOut: 256,
    scopesUsed: ["profile:read"],
    retries: 0,
    breakerState: "closed",
    ...overrides,
  };
}

describe("AuditLog", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = mkdtempSync(path.join(tmpdir(), "natstack-audit-"));
  });

  afterEach(() => {
    rmSync(logDir, { force: true, recursive: true });
  });

  it("appends JSONL entries and filters query results", async () => {
    const auditLog = new AuditLog({ logDir });
    const firstEntry = createEntry();
    const secondEntry = createEntry({
      ts: atLocalNoon(0, 13),
      workerId: "worker-2",
      connectionId: "connection-2",
      method: "POST",
    });

    await auditLog.append(firstEntry);
    await auditLog.append(secondEntry);

    const logPath = path.join(logDir, `credentials-audit-${formatDateKey(firstEntry.ts)}.jsonl`);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual(firstEntry);
    expect(JSON.parse(lines[1] as string)).toEqual(secondEntry);

    await expect(
      auditLog.query({
        filter: { workerId: "worker-2", method: "POST" },
        after: firstEntry.ts,
      }),
    ).resolves.toEqual([secondEntry]);

    await expect(auditLog.query({ limit: 1 })).resolves.toEqual([firstEntry]);
  });

  it("rotates logs by entry day and only queries the current day file", async () => {
    const auditLog = new AuditLog({ logDir });
    const yesterdayEntry = createEntry({
      ts: atLocalNoon(-1),
      workerId: "worker-yesterday",
    });
    const todayEntry = createEntry({
      ts: atLocalNoon(),
      workerId: "worker-today",
    });

    await auditLog.append(yesterdayEntry);
    await auditLog.append(todayEntry);

    const yesterdayPath = path.join(logDir, `credentials-audit-${formatDateKey(yesterdayEntry.ts)}.jsonl`);
    const todayPath = path.join(logDir, `credentials-audit-${formatDateKey(todayEntry.ts)}.jsonl`);

    expect(readFileSync(yesterdayPath, "utf8").trim()).toBe(JSON.stringify(yesterdayEntry));
    expect(readFileSync(todayPath, "utf8").trim()).toBe(JSON.stringify(todayEntry));
    await expect(auditLog.query()).resolves.toEqual([todayEntry]);
  });

  it("skips appends that would exceed the file size cap", async () => {
    const entry = createEntry();
    const maxFileSizeBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
    const auditLog = new AuditLog({ logDir, maxFileSizeBytes });
    const secondEntry = createEntry({
      ts: atLocalNoon(0, 13),
      workerId: "worker-2",
    });

    await auditLog.append(entry);
    await auditLog.append(secondEntry);

    const logPath = path.join(logDir, `credentials-audit-${formatDateKey(entry.ts)}.jsonl`);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual(entry);
  });

  it("returns credential write audit events without egress-only fields", async () => {
    const auditLog = new AuditLog({ logDir });
    const setupEntry: ConnectionCredentialAuditEvent = {
      type: "connection_credential.created",
      ts: atLocalNoon(),
      callerId: "panel:test",
      providerId: "url-bound",
      connectionId: "cred-1",
      storageKind: "connection-credential",
      fieldNames: ["credential"],
    };

    await auditLog.append(setupEntry);

    await expect(auditLog.query({
      filter: { providerId: "url-bound" },
    })).resolves.toEqual([setupEntry]);
  });
});
