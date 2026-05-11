/**
 * recoverPersistedDOTokens — re-seed TokenManager from workerd DO state.
 *
 * Durable Object SQLite storage survives server restarts; the in-memory
 * TokenManager does not. Each DO stores its own `__instanceToken` (issued
 * by `postToDOWithToken` on first dispatch) in its state KV. After a
 * server restart, alarm-driven or hibernation-wake code paths inside a DO
 * call back to `/rpc` using that persisted token — which the fresh
 * TokenManager has never seen, producing 401 "RPC authentication failed"
 * errors before the next dispatch refreshes identity.
 *
 * This module runs once during bootstrap, before workerd starts. It scans
 * the DO storage directory, reads `__instanceToken` / `__instanceId` from
 * each instance's `state` table, and re-registers them in TokenManager so
 * inbound RPC sees them as valid until the next dispatch overwrites the
 * binding.
 *
 * Failure is non-fatal: any file we can't read is skipped with a warning;
 * the server keeps starting. Worst case is the pre-fix behavior.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TokenManager } from "@natstack/shared/tokenManager";

/** Path workerdManager uses for DO disk storage (kept in sync with workerdManager.ts). */
export const DO_STORAGE_SUBPATH = path.join(".databases", "workerd-do");

export interface RecoveryResult {
  recovered: number;
  /** Files we found but couldn't pull a valid token/id pair from. */
  skipped: number;
  /** Files that errored during read (corrupt, locked, etc.) — counted separately so an operator can tell signal from noise. */
  errors: number;
}

/**
 * Scan workerd's DO disk storage and re-register every persisted
 * `(__instanceId, __instanceToken)` pair into `tokenManager`.
 *
 * Safe to call before workerd starts: the underlying SQLite files are
 * not held open by anyone else at that point.
 *
 * Uses `node:sqlite` (synchronous, built-in to Node 22+). The
 * "SQLite is an experimental feature" warning emitted on first import
 * is harmless; suppressing it process-wide would also hide unrelated
 * experimental-feature warnings, which we don't want.
 */
export function recoverPersistedDOTokens(
  tokenManager: TokenManager,
  statePath: string,
): RecoveryResult {
  const root = path.join(statePath, DO_STORAGE_SUBPATH);
  const result: RecoveryResult = { recovered: 0, skipped: 0, errors: 0 };

  if (!fs.existsSync(root)) return result;

  let classDirs: fs.Dirent[];
  try {
    classDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    console.warn(`[Server] DO token recovery: failed to list ${root}:`, err);
    return result;
  }

  for (const classDir of classDirs) {
    if (!classDir.isDirectory()) continue;
    const dirPath = path.join(root, classDir.name);

    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      result.errors++;
      continue;
    }

    for (const file of files) {
      // The instance SQLite is a hash-named file. metadata.sqlite is workerd's
      // own bookkeeping (no `state` table). WAL / SHM are sidecars.
      if (!file.endsWith(".sqlite")) continue;
      if (file === "metadata.sqlite") continue;

      const filePath = path.join(dirPath, file);
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(filePath, { readOnly: true });
        const rows = db
          .prepare(
            "SELECT key, value FROM state WHERE key IN ('__instanceToken', '__instanceId')",
          )
          .all() as Array<{ key: string; value: string }>;

        let token: string | null = null;
        let instanceId: string | null = null;
        for (const row of rows) {
          if (row.key === "__instanceToken") token = row.value;
          else if (row.key === "__instanceId") instanceId = row.value;
        }
        if (!token || !instanceId) {
          result.skipped++;
          continue;
        }
        const ok = tokenManager.registerExistingToken(token, instanceId, "worker");
        if (ok) result.recovered++;
        else result.skipped++;
      } catch (err) {
        // Missing `state` table (uninitialized DO), corrupt file, etc.
        const msg = err instanceof Error ? err.message : String(err);
        // `no such table: state` is the expected case for a freshly-created
        // instance dir that never ran ensureSchema — quiet skip.
        if (msg.includes("no such table")) {
          result.skipped++;
        } else {
          result.errors++;
          console.warn(
            `[Server] DO token recovery: failed to read ${path.join(classDir.name, file)}: ${msg}`,
          );
        }
      } finally {
        try { db?.close(); } catch { /* ignore close errors */ }
      }
    }
  }

  return result;
}
