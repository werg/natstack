import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DatabaseManager } from "@natstack/shared/db/databaseManager";

/**
 * Strict DB-name charset. Mirrors `DatabaseManager.sanitizeDbName`'s
 * regex (`/[^a-zA-Z0-9_-]/g`) and 64-char limit, but applied at the RPC
 * boundary as a *rejection* instead of a silent rewrite. Two distinct
 * caller-supplied names that would collide after sanitisation now both
 * fail the schema, removing the silent-aliasing primitive (#11 in fs
 * report). The full collision-rejection fix in `sanitizeDbName` itself
 * lives in Agent 4's territory — this is the boundary defense.
 */
const dbNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, "Invalid db name (must match /^[a-zA-Z0-9_-]{1,64}$/)");
const handleSchema = z.string().uuid();

export function createDbService(deps: {
  databaseManager: DatabaseManager;
}): ServiceDefinition {
  /**
   * Per-handle owner table. `open` records `(handle → callerId)` so that
   * subsequent `query` / `run` / `get` / `exec` / `close` ops can verify
   * the caller is the original owner. Without this check, any caller who
   * learned a handle string could reach into another caller's connection.
   * (#10 in fs report.)
   *
   * Note: `DatabaseManager` already tracks `handleToOwner` internally for
   * cleanup, but does not expose an owner check. We duplicate the
   * minimal mapping here so the boundary-side check works without
   * modifying the shared package.
   */
  const handleOwners = new Map<string, string>();

  function assertOwner(handle: string, callerId: string): void {
    const owner = handleOwners.get(handle);
    if (!owner) {
      throw new Error(`Invalid db handle: ${handle}`);
    }
    if (owner !== callerId) {
      throw new Error(`db handle ${handle} is not owned by caller`);
    }
  }

  return {
    name: "db",
    description: "Database operations",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      open: { args: z.tuple([dbNameSchema, z.boolean().optional()]) },
      query: { args: z.tuple([handleSchema, z.string(), z.array(z.unknown()).optional()]) },
      run: { args: z.tuple([handleSchema, z.string(), z.array(z.unknown()).optional()]) },
      get: { args: z.tuple([handleSchema, z.string(), z.array(z.unknown()).optional()]) },
      // SECURITY (#8 in audit report): full SQLite `exec` permits
      // ATTACH DATABASE, VACUUM INTO, and other statements that escape
      // the parameterised-query model. Restrict to shell and server
      // callers; panels and workers must use parameterised
      // `query`/`run`/`get`. TODO: re-enable for `worker` only if a
      // specific worker is shown to need multi-statement DDL during
      // build — none today.
      exec: {
        args: z.tuple([handleSchema, z.string()]),
        policy: { allowed: ["shell", "server"] },
      },
      close: { args: z.tuple([handleSchema]) },
    },
    handler: async (ctx, method, args) => {
      const ownerId = ctx.callerId;
      const dbManager = deps.databaseManager;

      switch (method) {
        case "open": {
          const [dbName, readOnly] = args as [string, boolean?];
          const handle = dbManager.open(ownerId, dbName, readOnly ?? false);
          handleOwners.set(handle, ownerId);
          return handle;
        }
        case "query": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          assertOwner(handle, ownerId);
          return dbManager.query(handle, sql, params);
        }
        case "run": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          assertOwner(handle, ownerId);
          return dbManager.run(handle, sql, params);
        }
        case "get": {
          const [handle, sql, params] = args as [string, string, unknown[]?];
          assertOwner(handle, ownerId);
          return dbManager.get(handle, sql, params);
        }
        case "exec": {
          const [handle, sql] = args as [string, string];
          assertOwner(handle, ownerId);
          dbManager.exec(handle, sql);
          return;
        }
        case "close": {
          const [handle] = args as [string];
          assertOwner(handle, ownerId);
          dbManager.close(handle);
          handleOwners.delete(handle);
          return;
        }
        default:
          throw new Error(`Unknown db method: ${method}`);
      }
    },
  };
}
