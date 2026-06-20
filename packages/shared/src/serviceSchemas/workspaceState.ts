/**
 * workspace-state service method schemas — read/write surface over slot.* and
 * entity.* on WorkspaceDO. Pure-data wire contract shared by the server
 * registration and typed clients.
 *
 * Reads (slot.list/get/history, entity.resolveActive) are open to all runtime
 * kinds; writes (slot create / appendHistory / setCurrent / replaceHistory /
 * setParent / close) are gated to the shipped shell, approved shell app, and
 * server. Panels and workers manipulate slots via runtime.*, not directly
 * here.
 */

import { z } from "zod";
import type { ServicePolicy } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const SlotHistoryEntryInputSchema = z.object({
  entryKey: z.string(),
  entityId: z.string(),
  source: z.string(),
  contextId: z.string(),
  stateArgs: z.unknown().optional(),
});

export const SlotCreateInputSchema = z.object({
  slotId: z.string(),
  parentSlotId: z.string().nullable(),
  positionId: z.string(),
  initialEntry: SlotHistoryEntryInputSchema.optional(),
});

export const WORKSPACE_STATE_READ_POLICY: ServicePolicy = {
  allowed: ["shell", "app", "server", "panel", "worker", "do"],
};
export const WORKSPACE_STATE_WRITE_POLICY: ServicePolicy = {
  allowed: ["shell", "app", "server"],
};
export const WORKSPACE_STATE_LIFECYCLE_POLICY: ServicePolicy = {
  allowed: ["server", "do"],
};

export const LifecycleKeySchema = z.object({
  source: z.string().min(1),
  className: z.string().min(1),
  objectKey: z.string().min(1),
});

export const LifecycleLeaseSchema = LifecycleKeySchema.extend({
  detail: z.unknown().optional(),
});

export const AlarmSetSchema = LifecycleKeySchema.extend({
  wakeAt: z.number(),
  /**
   * Best-effort alarms (e.g. EvalDO idle eviction) fire once and are NOT re-armed on
   * dispatch failure: the handler aborts its own DO, so a failed dispatch is the expected
   * outcome, not a lost wake. Omitted/false = the default at-least-once alarm. See
   * AlarmDriver.fire().
   */
  bestEffort: z.boolean().optional(),
});

export const HeartbeatRegistryRowSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  className: z.string().min(1),
  objectKey: z.string().min(1),
  channelId: z.string().nullable().optional(),
  participantHandle: z.string().nullable().optional(),
  kind: z.enum(["declarative", "code-owned"]),
  status: z.enum(["running", "paused", "stopped"]),
  nextRunAt: z.number().nullable().optional(),
  lastWakeAt: z.number().nullable().optional(),
  lastActionSummary: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  specHash: z.string().nullable().optional(),
  updatedAt: z.number(),
});

export const PanelSearchResultSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    relevance: z.number(),
    accessCount: z.number(),
    matchContext: z.string().optional(),
  })
  .strict();

export const workspaceStateMethods = defineServiceMethods({
  "slot.list": {
    args: z.tuple([]),
    description: "List open slots.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.array(z.unknown()),
  },
  "slot.get": {
    args: z.tuple([z.string()]),
    description: "Get a single slot row by id.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.unknown(),
  },
  "slot.history": {
    args: z.tuple([z.string()]),
    description: "Get the history for a slot.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.array(z.unknown()),
  },
  "entity.resolveActive": {
    args: z.tuple([z.string()]),
    description: "Resolve a single active entity record by id.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.unknown(),
  },
  "slot.resolveByEntity": {
    args: z.tuple([z.string()]),
    description:
      "Resolve the OPEN slot id whose current entity is the given runtime-entity (nav) id, or null. " +
      "Durable nav→slot mapping used to nest launches under the owning panel's tree slot.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.string().nullable(),
  },
  "slot.create": {
    args: z.tuple([SlotCreateInputSchema]),
    description: "Create a new slot row.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.appendHistory": {
    args: z.tuple([z.string(), SlotHistoryEntryInputSchema]),
    description: "Append a history entry to a slot.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.number(),
  },
  "slot.setCurrent": {
    args: z.tuple([z.string(), z.string()]),
    description: "Move a slot's current pointer to an existing history entry.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.updateCurrentStateArgs": {
    args: z.tuple([z.string(), z.unknown()]),
    description: "Mutate the stateArgs for a slot's current history entry.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.replaceHistory": {
    args: z.tuple([z.string(), z.array(SlotHistoryEntryInputSchema), z.number()]),
    description: "Replace a slot's history with the given entries and cursor.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.setParent": {
    args: z.tuple([z.string(), z.string().nullable()]),
    description: "Reparent a slot.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.setPosition": {
    args: z.tuple([z.string(), z.string()]),
    description: "Update a slot's position rank.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.move": {
    args: z.tuple([z.string(), z.string().nullable(), z.string()]),
    description: "Atomically update a slot's parent and position.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "slot.close": {
    args: z.tuple([z.string()]),
    description: "Mark a slot closed.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "panel.search": {
    args: z.tuple([z.string(), z.number().optional()]),
    description: "FTS5 search over panel entities.",
    policy: WORKSPACE_STATE_READ_POLICY,
    returns: z.array(PanelSearchResultSchema),
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
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "panel.updateTitle": {
    args: z.tuple([z.string(), z.string()]),
    description: "Update the searchable title for a panel entity.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "panel.incrementAccess": {
    args: z.tuple([z.string()]),
    description: "Bump the access counter for a panel entity.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  "panel.rebuildIndex": {
    args: z.tuple([]),
    description: "Rebuild the panel-search index from active panel entities.",
    policy: WORKSPACE_STATE_WRITE_POLICY,
    returns: z.void(),
  },
  lifecycleLeaseUpsert: {
    args: z.tuple([LifecycleLeaseSchema]),
    description: "Mark a Durable Object as having active checkpointable work.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
  lifecycleLeaseClear: {
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object active-work lease.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
  alarmSet: {
    args: z.tuple([AlarmSetSchema]),
    description: "Register/replace a Durable Object's server-driven wake time.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
  alarmClear: {
    args: z.tuple([LifecycleKeySchema]),
    description: "Clear a Durable Object's pending server-driven alarm.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
  heartbeatRegister: {
    args: z.tuple([HeartbeatRegistryRowSchema]),
    description: "Register or update an agent heartbeat registry row.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
  heartbeatRemove: {
    args: z.tuple([z.object({ name: z.string().min(1) })]),
    description: "Remove an agent heartbeat registry row.",
    policy: WORKSPACE_STATE_LIFECYCLE_POLICY,
    returns: z.void(),
  },
});
