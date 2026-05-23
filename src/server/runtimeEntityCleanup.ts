import type { FsService } from "@natstack/shared/fsService";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WorkerdManager } from "./workerdManager.js";
import type { EgressProxy } from "./services/egressProxy.js";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import type { CredentialSessionGrantStore } from "./services/credentialSessionGrants.js";
import type { EntityTitleService } from "./services/entityTitleService.js";

export interface RuntimeEntityCleanupDeps {
  panelRuntimeCoordinator?: PanelRuntimeCoordinator | null;
  egressProxy: Pick<EgressProxy, "dropCaller">;
  approvalQueue: Pick<ApprovalQueue, "cancelForCaller">;
  credentialSessionGrantStore: Pick<CredentialSessionGrantStore, "dropForCaller">;
  tokenManager: Pick<TokenManager, "revokeToken">;
  connectionGrants?: Pick<ConnectionGrantService, "revokeForPrincipal">;
  entityTitleService?: Pick<EntityTitleService, "clear">;
  getWorkerdManager(): Pick<WorkerdManager, "stopWorker" | "destroyDOEntity"> | null;
  getFsService(): FsService | null;
  getWebhookIngress(): {
    internal?: { revokeForCaller?: (callerId: string) => Promise<number> };
  } | null;
}

/**
 * Single server-side owner for retiring runtime entity resources.
 *
 * RuntimeService commits the entity row to retired first, then calls this. The
 * cleanup reaper calls the same function for incomplete retirements, so every
 * lifecycle transition uses the same cleanup ordering.
 */
export async function cleanupRuntimeEntity(
  record: EntityRecord,
  deps: RuntimeEntityCleanupDeps
): Promise<void> {
  if (record.kind === "panel") {
    deps.panelRuntimeCoordinator?.retireRuntimeEntity(record.id);
  }
  await deps.egressProxy.dropCaller(record.id).catch(() => {});
  await bestEffort(() => deps.approvalQueue.cancelForCaller(record.id));
  await bestEffort(() => deps.credentialSessionGrantStore.dropForCaller(record.id));
  await bestEffort(() => deps.connectionGrants?.revokeForPrincipal(record.id));
  await bestEffort(() => deps.getFsService()?.closeHandlesForCaller(record.id));
  await bestEffort(() => deps.getWebhookIngress()?.internal?.revokeForCaller?.(record.id));
  await bestEffort(() => deps.tokenManager.revokeToken(record.id));
  await bestEffort(() => deps.entityTitleService?.clear(record.id));
  const workerdManager = deps.getWorkerdManager();
  if (record.kind === "worker") {
    await workerdManager?.stopWorker(record.id).catch(() => {});
  }
  if (record.kind === "do") {
    await workerdManager?.destroyDOEntity(record.id).catch(() => {});
  }
}

async function bestEffort(fn: () => unknown | Promise<unknown>): Promise<void> {
  await Promise.resolve()
    .then(fn)
    .catch(() => {});
}
