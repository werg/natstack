/**
 * Startup reconciliation for WorkspaceDO state.
 *
 * Runs once during server bootstrap. The order is load-bearing:
 *   1. Hydrate the in-memory entityCache from the DO's active set.
 *   2. Reconcile rows whose cleanup hooks didn't complete before a crash —
 *      after restart their runtime resources are gone, so mark them complete.
 *   3. Safety GC sweep — hard-delete retired rows older than the grace window
 *      that no slot_history row references. Fires no hooks.
 *   4. Optionally run lifecycle crash/server-restart recovery after WorkspaceDO
 *      is reachable and entity metadata has been reconciled.
 *
 * Extracted from `src/server/index.ts` so both the boot path and tests can
 * call it without standing up the full container.
 */
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";

export type StartupReconciliationDispatcher = <T>(method: string, ...args: unknown[]) => Promise<T>;

export interface StartupReconciliationDeps {
  dispatchWorkspaceDO: StartupReconciliationDispatcher;
  entityCache: EntityCache;
  /** Optional safety-sweep grace window (ms). Default: DO's own DEFAULT_GRACE_MS. */
  gcGraceMs?: number;
  recoverLifecycle?: () => Promise<void>;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface StartupReconciliationResult {
  hydratedCount: number;
  incompleteCleanupIds: string[];
  gcDeletedIds: string[];
  lifecycleRecovered: boolean;
}

export async function runStartupReconciliation(
  deps: StartupReconciliationDeps
): Promise<StartupReconciliationResult> {
  const log = deps.logger ?? { warn: (msg, ...args) => console.warn(msg, ...args) };

  // 1. Hydrate entityCache from the DO's active set.
  let hydratedCount = 0;
  try {
    const active = await deps.dispatchWorkspaceDO<EntityRecord[]>("entityListActive");
    deps.entityCache.hydrate(active);
    hydratedCount = active.length;
  } catch (err) {
    log.warn("[Bootstrap] entityCache hydrate failed:", err);
  }

  // 2. Reconcile partial cleanups from a prior crash.
  const incompleteCleanupIds: string[] = [];
  try {
    const incomplete = await deps.dispatchWorkspaceDO<EntityRecord[]>(
      "entityFindIncompleteCleanups"
    );
    for (const record of incomplete) {
      incompleteCleanupIds.push(record.id);
      try {
        await deps.dispatchWorkspaceDO<undefined>("entityCleanupComplete", record.id);
      } catch (err) {
        log.warn(`[Bootstrap] entityCleanupComplete failed for ${record.id}:`, err);
      }
    }
  } catch (err) {
    log.warn("[Bootstrap] entityFindIncompleteCleanups failed:", err);
  }

  // 3. Safety GC sweep.
  let gcDeletedIds: string[] = [];
  try {
    const gcOpts: { all: true; graceMs?: number } =
      deps.gcGraceMs !== undefined ? { all: true, graceMs: deps.gcGraceMs } : { all: true };
    gcDeletedIds = await deps.dispatchWorkspaceDO<string[]>("entityGc", gcOpts);
  } catch (err) {
    log.warn("[Bootstrap] entityGc safety sweep failed:", err);
  }

  let lifecycleRecovered = false;
  if (deps.recoverLifecycle) {
    try {
      await deps.recoverLifecycle();
      lifecycleRecovered = true;
    } catch (err) {
      log.warn("[Bootstrap] lifecycle startup recovery failed:", err);
    }
  }

  return { hydratedCount, incompleteCleanupIds, gcDeletedIds, lifecycleRecovered };
}
