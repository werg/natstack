/**
 * Database injection module.
 *
 * Allows @natstack/agentic-messaging to use databases without a direct dependency
 * on a specific database implementation. The caller configures this via setDbOpen()
 * before using any database features (e.g., session persistence).
 *
 * - Server-side agents: the agent adapter injects a DatabaseManager-backed opener.
 * - Panels/workers: @workspace/runtime injects its own opener during initialization.
 */

import type { DatabaseInterface } from "@natstack/types";

// Re-export DatabaseInterface as Database for convenience
export type Database = DatabaseInterface;

// Database opener type
export type DbOpener = (name: string, readOnly?: boolean) => Promise<Database>;

let dbOpener: DbOpener | null = null;

/**
 * Set the database opener function.
 * Must be called before connect() or any database features are used.
 *
 * @param opener Function that opens a database by name
 */
export function setDbOpen(opener: DbOpener): void {
  dbOpener = opener;
}

/**
 * Get the current database opener.
 * Throws if not configured.
 */
export function getDbOpen(): DbOpener {
  if (!dbOpener) {
    throw new Error(
      "Database opener not configured. " +
      "Call setDbOpen() before using database features."
    );
  }
  return dbOpener;
}

/**
 * Open a database by name.
 * Convenience wrapper around getDbOpen().
 */
export async function openDb(name: string, readOnly?: boolean): Promise<Database> {
  return getDbOpen()(name, readOnly);
}
