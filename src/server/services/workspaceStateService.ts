/**
 * workspace-state — read/write surface over slot.* and entity.* on WorkspaceDO.
 *
 * Replaces the old workspace-sync op-log service. Reads (slot.list/get/history,
 * entity.resolveActive) are open to all runtime kinds; writes (slot create /
 * appendHistory / setCurrent / replaceHistory / setParent / close) are gated to
 * shell + server only. Panels and workers manipulate slots via runtime.*, not
 * directly here.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ServicePolicy } from "@natstack/shared/servicePolicy";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import type { IndexablePanel, PanelSearchResult } from "@natstack/shared/panelSearchTypes";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

export const WORKSPACE_DO_CLASS = "WorkspaceDO";

const SlotHistoryEntryInputSchema = z.object({
  entryKey: z.string(),
  entityId: z.string(),
  source: z.string(),
  contextId: z.string(),
  stateArgs: z.unknown().optional(),
});

const SlotCreateInputSchema = z.object({
  slotId: z.string(),
  parentSlotId: z.string().nullable(),
  positionId: z.string(),
  initialEntry: SlotHistoryEntryInputSchema.optional(),
});

const READ_POLICY: ServicePolicy = {
  allowed: ["shell", "server", "panel", "worker"],
};
const WRITE_POLICY: ServicePolicy = {
  allowed: ["shell", "server"],
};

export interface WorkspaceStateServiceDeps {
  doDispatch: DODispatch;
  workspaceId: string;
  /**
   * Optional hook for mirroring authoritative panel titles into the
   * server-side display-title registry. Called whenever `panel.updateTitle`
   * succeeds.
   */
  onPanelTitleChanged?: (panelEntityId: string, title: string) => void;
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
    methods: {
      "slot.list": {
        args: z.tuple([]),
        description: "List open slots.",
        policy: READ_POLICY,
      },
      "slot.get": {
        args: z.tuple([z.string()]),
        description: "Get a single slot row by id.",
        policy: READ_POLICY,
      },
      "slot.history": {
        args: z.tuple([z.string()]),
        description: "Get the history for a slot.",
        policy: READ_POLICY,
      },
      "entity.resolveActive": {
        args: z.tuple([z.string()]),
        description: "Resolve a single active entity record by id.",
        policy: READ_POLICY,
      },
      "slot.create": {
        args: z.tuple([SlotCreateInputSchema]),
        description: "Create a new slot row.",
        policy: WRITE_POLICY,
      },
      "slot.appendHistory": {
        args: z.tuple([z.string(), SlotHistoryEntryInputSchema]),
        description: "Append a history entry to a slot.",
        policy: WRITE_POLICY,
      },
      "slot.setCurrent": {
        args: z.tuple([z.string(), z.string()]),
        description: "Move a slot's current pointer to an existing history entry.",
        policy: WRITE_POLICY,
      },
      "slot.updateCurrentStateArgs": {
        args: z.tuple([z.string(), z.unknown()]),
        description: "Mutate the stateArgs for a slot's current history entry.",
        policy: WRITE_POLICY,
      },
      "slot.replaceHistory": {
        args: z.tuple([z.string(), z.array(SlotHistoryEntryInputSchema), z.number()]),
        description: "Replace a slot's history with the given entries and cursor.",
        policy: WRITE_POLICY,
      },
      "slot.setParent": {
        args: z.tuple([z.string(), z.string().nullable()]),
        description: "Reparent a slot.",
        policy: WRITE_POLICY,
      },
      "slot.setPosition": {
        args: z.tuple([z.string(), z.string()]),
        description: "Update a slot's position rank.",
        policy: WRITE_POLICY,
      },
      "slot.move": {
        args: z.tuple([z.string(), z.string().nullable(), z.string()]),
        description: "Atomically update a slot's parent and position.",
        policy: WRITE_POLICY,
      },
      "slot.close": {
        args: z.tuple([z.string()]),
        description: "Mark a slot closed.",
        policy: WRITE_POLICY,
      },
      "panel.search": {
        args: z.tuple([z.string(), z.number().optional()]),
        description: "FTS5 search over panel entities.",
        policy: READ_POLICY,
      },
      "panel.index": {
        args: z.tuple([
          z.object({
            id: z.string(),
            title: z.string(),
            path: z.string().optional(),
            manifestDescription: z.string().optional(),
            manifestDependencies: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
            keywords: z.array(z.string()).optional(),
          }),
        ]),
        description: "Upsert a panel's search-metadata row.",
        policy: WRITE_POLICY,
      },
      "panel.updateTitle": {
        args: z.tuple([z.string(), z.string()]),
        description: "Update the searchable title for a panel entity.",
        policy: WRITE_POLICY,
      },
      "panel.incrementAccess": {
        args: z.tuple([z.string()]),
        description: "Bump the access counter for a panel entity.",
        policy: WRITE_POLICY,
      },
      "panel.rebuildIndex": {
        args: z.tuple([]),
        description: "Rebuild the panel-search index from active panel entities.",
        policy: WRITE_POLICY,
      },
    },
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
          return;
        }
        case "slot.appendHistory": {
          const [slotId, entry] = args as [string, unknown];
          return await dispatch<number>("slotAppendHistory", [slotId, entry]);
        }
        case "slot.setCurrent": {
          const [slotId, entryKey] = args as [string, string];
          await dispatch<undefined>("slotSetCurrent", [slotId, entryKey]);
          return;
        }
        case "slot.updateCurrentStateArgs": {
          const [slotId, stateArgs] = args as [string, unknown];
          await dispatch<undefined>("slotUpdateCurrentStateArgs", [slotId, stateArgs]);
          return;
        }
        case "slot.replaceHistory": {
          const [slotId, entries, cursor] = args as [string, unknown[], number];
          await dispatch<undefined>("slotReplaceHistory", [slotId, entries, cursor]);
          return;
        }
        case "slot.setParent": {
          const [slotId, parentSlotId] = args as [string, string | null];
          await dispatch<undefined>("slotSetParent", [slotId, parentSlotId]);
          return;
        }
        case "slot.setPosition": {
          const [slotId, positionId] = args as [string, string];
          await dispatch<undefined>("slotSetPosition", [slotId, positionId]);
          return;
        }
        case "slot.move": {
          const [slotId, parentSlotId, positionId] = args as [string, string | null, string];
          await dispatch<undefined>("slotMove", [slotId, parentSlotId, positionId]);
          return;
        }
        case "slot.close": {
          const [slotId] = args as [string];
          await dispatch<undefined>("slotClose", [slotId]);
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
        default:
          throw new Error(`Unknown workspace-state method: ${method}`);
      }
    },
  };
}
