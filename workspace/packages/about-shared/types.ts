/**
 * Shared types for about pages.
 * These mirror the types from src/shared/types.ts that about pages need.
 */

/** Shape returned by the shell `app.getInfo` RPC. */
export interface AppInfo {
  version: string;
  connectionMode?: "local" | "remote";
  remoteHost?: string;
  connectionStatus?: string;
}
