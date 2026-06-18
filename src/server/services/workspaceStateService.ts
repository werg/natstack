/**
 * workspace-state — read/write surface over slot.* and entity.* on WorkspaceDO.
 *
 * Replaces the old workspace-sync op-log service. Reads (slot.list/get/history,
 * entity.resolveActive) are open to all runtime kinds; writes (slot create /
 * appendHistory / setCurrent / replaceHistory / setParent / close) are gated to
 * the shipped shell, approved shell app, and server. Panels and workers
 * manipulate slots via runtime.*, not directly here.
 */

import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import type { IndexablePanel, PanelSearchResult } from "@natstack/shared/panelSearchTypes";
import {
  WORKSPACE_STATE_READ_POLICY as READ_POLICY,
  workspaceStateMethods,
} from "@natstack/shared/serviceSchemas/workspaceState";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

export const WORKSPACE_DO_CLASS = "WorkspaceDO";

export interface WorkspaceStateServiceDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  /**
   * Optional hook for mirroring authoritative panel titles into the
   * server-side display-title registry. Called whenever `panel.updateTitle`
   * succeeds.
   */
  onPanelTitleChanged?: (panelEntityId: string, title: string) => void;
  /**
   * Notify the server's AlarmDriver that a DO's wake schedule changed, so it
   * can re-arm its timer. Called after `alarmSet`/`alarmClear` persist.
   */
  onAlarmChanged?: () => void;
  /**
   * Notify listeners that the panel slot/history tree changed (create, navigate,
   * move, close, …) so the server's in-memory panel-tree mirror can re-sync and
   * re-broadcast. Fires after any mutating `slot.*` method persists — regardless
   * of which client initiated it — which is what keeps every client's mirror
   * consistent with the authoritative WorkspaceDO.
   */
  onSlotStateChanged?: () => void;
}

export function createWorkspaceStateService(deps: WorkspaceStateServiceDeps): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: WORKSPACE_DO_CLASS,
    objectKey: deps.workspaceId,
  };
  const dispatch = <T>(method: string, args: unknown[]) =>
    deps.doDispatch.dispatch(ref, method, ...args) as Promise<T>;

  return {
    name: "workspace-state",
    description: "Workspace slot/entity state (WorkspaceDO).",
    policy: READ_POLICY,
    methods: workspaceStateMethods,
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "slot.list":
          return await dispatch<unknown>("slotListOpen", []);
        case "slot.get": {
          const [slotId] = args as [string];
          return await dispatch<unknown>("slotGet", [slotId]);
        }
        case "slot.history": {
          const [slotId] = args as [string];
          return await dispatch<unknown>("slotHistory", [slotId]);
        }
        case "entity.resolveActive": {
          const [id] = args as [string];
          return await dispatch<EntityRecord | null>("entityResolveActive", [id]);
        }
        case "slot.create": {
          const [input] = args as [unknown];
          await dispatch<undefined>("slotCreate", [input]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.appendHistory": {
          const [slotId, entry] = args as [string, unknown];
          const result = await dispatch<number>("slotAppendHistory", [slotId, entry]);
          deps.onSlotStateChanged?.();
          return result;
        }
        case "slot.setCurrent": {
          const [slotId, entryKey] = args as [string, string];
          await dispatch<undefined>("slotSetCurrent", [slotId, entryKey]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.updateCurrentStateArgs": {
          const [slotId, stateArgs] = args as [string, unknown];
          await dispatch<undefined>("slotUpdateCurrentStateArgs", [slotId, stateArgs]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.replaceHistory": {
          const [slotId, entries, cursor] = args as [string, unknown[], number];
          await dispatch<undefined>("slotReplaceHistory", [slotId, entries, cursor]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.setParent": {
          const [slotId, parentSlotId] = args as [string, string | null];
          await dispatch<undefined>("slotSetParent", [slotId, parentSlotId]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.setPosition": {
          const [slotId, positionId] = args as [string, string];
          await dispatch<undefined>("slotSetPosition", [slotId, positionId]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.move": {
          const [slotId, parentSlotId, positionId] = args as [string, string | null, string];
          await dispatch<undefined>("slotMove", [slotId, parentSlotId, positionId]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "slot.close": {
          const [slotId] = args as [string];
          await dispatch<undefined>("slotClose", [slotId]);
          deps.onSlotStateChanged?.();
          return;
        }
        case "panel.search": {
          const [query, limit] = args as [string, number | undefined];
          return await dispatch<PanelSearchResult[]>("panelSearch", [query, limit]);
        }
        case "panel.index": {
          const [input] = args as [IndexablePanel];
          // The DO returns the slot's current entity id when it stamped a
          // title onto entities.display_title — we pass that on (rather than
          // the slot id) so cache mirrors stay keyed correctly.
          const entityId = await dispatch<string | null>("panelIndex", [input]);
          if (entityId && input?.title) {
            deps.onPanelTitleChanged?.(entityId, input.title);
          }
          return;
        }
        case "panel.updateTitle": {
          const [slotId, title] = args as [string, string];
          const entityId = await dispatch<string | null>("panelUpdateTitle", [slotId, title]);
          if (entityId) {
            deps.onPanelTitleChanged?.(entityId, title);
          }
          return;
        }
        case "panel.incrementAccess": {
          const [entityId] = args as [string];
          await dispatch<undefined>("panelIncrementAccess", [entityId]);
          return;
        }
        case "panel.rebuildIndex": {
          await dispatch<undefined>("panelRebuildIndex", []);
          return;
        }
        case "lifecycleLeaseUpsert": {
          const [input] = args as [unknown];
          await dispatch<undefined>("lifecycleLeaseUpsert", [input]);
          return;
        }
        case "lifecycleLeaseClear": {
          const [input] = args as [unknown];
          await dispatch<undefined>("lifecycleLeaseClear", [input]);
          return;
        }
        case "alarmSet": {
          const [input] = args as [unknown];
          await dispatch<undefined>("alarmSet", [input]);
          deps.onAlarmChanged?.();
          return;
        }
        case "alarmClear": {
          const [input] = args as [unknown];
          await dispatch<undefined>("alarmClear", [input]);
          deps.onAlarmChanged?.();
          return;
        }
        default:
          throw new Error(`Unknown workspace-state method: ${method}`);
      }
    },
  };
}
