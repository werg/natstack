/**
 * Database injection module.
 *
 * This allows @natstack/agentic-messaging to work without a direct dependency
 * on @natstack/runtime. The runtime configures this during initialization.
 *
 * For agents running in utilityProcess, the agent-runtime will inject
 * its own db opener that uses RPC to communicate with the host.
 */

import type { DatabaseInterface } from "@natstack/core";

// Re-export DatabaseInterface as Database for convenience
export type Database = DatabaseInterface;

// Database opener type
export type DbOpener = (name: string, readOnly?: boolean) => Promise<Database>;

let dbOpener: DbOpener | null = null;

/**
 * Set the database opener function.
 * Called by @natstack/runtime during initialization.
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
      "Call setDbOpen() before using database features. " +
      "In panels/workers, @natstack/runtime does this automatically."
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
