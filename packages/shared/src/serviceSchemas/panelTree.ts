/**
 * panelTree service method schemas.
 *
 * The panelTree service is the single server-owned authority for panel slot
 * creation, navigation, lifecycle commands, and tree metadata.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import type { PanelRuntimeLease } from "../panel/panelLease.js";
import type {
  MovePanelRequest,
  Panel,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelTreeSnapshot,
} from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the panelTree method groups. `callers` is
// intentionally omitted: the service-level `policy` (see panelTreeService.ts)
// remains the enforced caller gate; these descriptors only add doc/safety
// metadata (sensitivity) that drives the capability catalog.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const CLOSE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};
const ARCHIVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

const PanelIdSchema = z.string();
const StateArgsSchema = z.record(z.unknown());
const CreateResultSchema = z.object({
  id: z.string().describe("Stable panel/slot id of the created panel."),
  title: z.string().describe("Display title resolved for the panel."),
  kind: z
    .enum(["browser", "workspace"])
    .optional()
    .describe("Panel surface kind: an external browser view or a workspace runtime."),
  contextId: z.string().optional().describe("Resolved storage-isolation context id."),
  source: z.string().optional().describe("Workspace-relative source path that backs the panel."),
  runtimeEntityId: z
    .string()
    .optional()
    .describe("Identifier of the runtime entity bound to the panel, when loaded."),
  effectiveVersion: z
    .string()
    .nullable()
    .optional()
    .describe("Resolved code version serving the panel, or null when unversioned."),
});

export const PanelTreeCreateOptionsSchema = z
  .object({
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe("Parent panel id to nest under; null/omitted creates a root-level panel."),
    name: z.string().optional().describe("Optional display name override for the new panel."),
    focus: z.boolean().optional().describe("Focus the new panel immediately after creation."),
    ref: z.string().optional().describe("Optional git-style ref / version pin for the source."),
    stateArgs: StateArgsSchema.optional().describe(
      "Initial validated state-args passed to the panel runtime."
    ),
  })
  .optional();

export const PanelTreeNavigateOptionsSchema = z
  .object({
    ref: z.string().optional().describe("Optional ref / version pin to navigate the panel to."),
    contextId: z
      .string()
      .optional()
      .describe("Storage-isolation context id to navigate into (changes data scope)."),
    env: z.record(z.string()).optional().describe("Environment variables to pass to the runtime."),
    stateArgs: StateArgsSchema.optional().describe(
      "Validated state-args supplied to the navigated panel."
    ),
  })
  .optional();

export const panelTreeMethods = defineServiceMethods({
  list: {
    description:
      "List the children of a panel (or the root panels when the parent id is null/omitted).",
    args: z.tuple([z.string().nullable().optional()]),
    returns: z.array(z.unknown()),
    access: READ_ACCESS,
  },
  roots: {
    description: "List all root-level panels in the tree.",
    args: z.tuple([]),
    returns: z.array(z.unknown()),
    access: READ_ACCESS,
  },
  getTreeSnapshot: {
    description: "Return a full snapshot of the panel tree (revision plus root panels).",
    args: z.tuple([]),
    returns: z.custom<PanelTreeSnapshot>(),
    access: READ_ACCESS,
  },
  getFocusedPanelId: {
    description: "Return the id of the currently focused panel, or null if none is focused.",
    args: z.tuple([]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  create: {
    description:
      "Create a new panel from a workspace source path, optionally nested under a parent and focused.",
    args: z.tuple([z.string(), PanelTreeCreateOptionsSchema]),
    returns: CreateResultSchema,
    access: WRITE_ACCESS,
    examples: [{ args: ["panels/chat", { focus: true }] }],
  },
  ensureLoaded: {
    description:
      "Ensure the panel's runtime is loaded (building/restoring it if needed) without changing focus.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelFocusResult>(),
    access: WRITE_ACCESS,
  },
  focus: {
    description: "Focus a panel, loading its runtime first if it is not already loaded.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelFocusResult>(),
    access: WRITE_ACCESS,
  },
  getRuntimeLease: {
    description:
      "Return the current runtime lease held on a panel (which host/connection owns it), or null if unleased.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelRuntimeLease>().nullable(),
    access: READ_ACCESS,
  },
  getStateArgs: {
    description: "Return the validated state-args currently bound to a panel.",
    args: z.tuple([PanelIdSchema]),
    returns: StateArgsSchema,
    access: READ_ACCESS,
  },
  setStateArgs: {
    description: "Replace a panel's state-args; returns the resulting validated state-args.",
    args: z.tuple([PanelIdSchema, StateArgsSchema]),
    returns: StateArgsSchema,
    access: WRITE_ACCESS,
  },
  reload: {
    description: "Reload a panel's view in place, keeping its current snapshot.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: WRITE_ACCESS,
  },
  close: {
    description: "Close a panel, removing it (and its subtree) from the tree.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: CLOSE_ACCESS,
  },
  archive: {
    description: "Archive a panel, removing it from the active tree while preserving its history.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: ARCHIVE_ACCESS,
  },
  unload: {
    description:
      "Unload a panel's runtime/view to free resources while keeping the panel in the tree.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: WRITE_ACCESS,
  },
  movePanel: {
    description: "Reparent and/or reposition a panel among its siblings (drag-and-drop move).",
    args: z.tuple([z.custom<MovePanelRequest>()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: [{ panelId: "panel-1", newParentId: null, targetPosition: 0 }] }],
  },
  navigate: {
    description:
      "Navigate an existing panel to a new source path (optionally changing ref/context), returning the new panel descriptor or null.",
    args: z.tuple([PanelIdSchema, z.string(), PanelTreeNavigateOptionsSchema]),
    returns: CreateResultSchema.nullable(),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", "panels/chat"] }],
  },
  navigateHistory: {
    description:
      "Move a panel backward (-1) or forward (1) through its navigation history, returning the resulting panel descriptor or null.",
    args: z.tuple([PanelIdSchema, z.union([z.literal(-1), z.literal(1)])]),
    returns: CreateResultSchema.nullable(),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", -1] }],
  },
  takeOver: {
    description:
      "Take over a panel's runtime lease for the calling client, focusing it on this host.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelFocusResult>(),
    access: WRITE_ACCESS,
  },
  openDevTools: {
    description: "Open developer tools for a panel, optionally docked to a side or detached.",
    args: z.tuple([PanelIdSchema, z.enum(["detach", "right", "bottom"]).optional()]),
    returns: z.unknown(),
    access: WRITE_ACCESS,
  },
  rebuildPanel: {
    description: "Rebuild a panel's runtime artifacts from source without reloading its view.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: WRITE_ACCESS,
  },
  rebuildAndReload: {
    description: "Rebuild a panel's runtime artifacts from source and then reload its view.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<PanelLifecycleResult>(),
    access: WRITE_ACCESS,
  },
  updatePanelState: {
    description:
      "Update a panel's live navigation state (url, page title, loading/back/forward flags) from the rendering surface.",
    args: z.tuple([PanelIdSchema, z.custom<PanelNavigationState>()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  snapshot: {
    description: "Return the current snapshot/configuration of a single panel.",
    args: z.tuple([PanelIdSchema]),
    returns: z.unknown(),
    access: READ_ACCESS,
  },
  callAgent: {
    description:
      "Invoke a panel's in-process agent method (e.g. _agent.snapshot/_agent.tree/_agent.setMode) with optional arguments.",
    args: z.tuple([PanelIdSchema, z.string(), z.array(z.unknown()).optional()]),
    returns: z.unknown(),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", "_agent.snapshot"] }],
  },
  metadata: {
    description: "Return the full Panel metadata for a panel id, or null if it does not exist.",
    args: z.tuple([PanelIdSchema]),
    returns: z.custom<Panel>().nullable(),
    access: READ_ACCESS,
  },
  getCollapsedIds: {
    description: "Return the ids of panels that are currently collapsed in the tree UI.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  setCollapsed: {
    description: "Set whether a panel is collapsed in the tree UI.",
    args: z.tuple([PanelIdSchema, z.boolean()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["panel-1", true] }],
  },
  expandIds: {
    description: "Expand (un-collapse) a set of panels in the tree UI.",
    args: z.tuple([z.array(PanelIdSchema)]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: [["panel-1", "panel-2"]] }],
  },
});
