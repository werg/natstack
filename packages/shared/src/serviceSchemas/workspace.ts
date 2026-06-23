/**
 * workspace service method schemas — workspace catalog, configuration, and
 * lifecycle (list, create, switch, units, host targets). Pure-data wire
 * contract shared by the server registration (`src/server/services/
 * workspaceService.ts`) and the typed client (`../workspace/client.ts`).
 *
 * Note: `create` / `delete` are catalog-dependent — the server omits them at
 * registration time when no workspace catalog is available (remote-server /
 * mobile-client mode). They are part of the full wire contract here so typed
 * clients still expose them; callers in catalog-less mode get a consistent
 * "Unknown workspace method" error from the dispatcher.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetLaunchResult as SharedHostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "../hostTargets.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import type { WorkspaceNode } from "../types.js";

// ─── Access descriptors ───────────────────────────────────────────────────────
// Mirrors the blobstore idiom of a shared `*_ACCESS` constant for the pure-read
// methods (which all share identical access metadata). `callers` are
// deliberately omitted (the legacy per-method `policy` remains the enforced gate
// during migration); this carries the sensitivity doc metadata only. Mutators
// declare a method-specific `access.sensitivity` inline rather than sharing a
// generic constant.

/** Pure read: no writes, safe to retry. */
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

// ─── Host target schemas ──────────────────────────────────────────────────────
// Structural shapes live in `../hostTargets.js`; these zod wrappers bind the
// wire schemas to those types without redefining them field-for-field.

export const HostTargetSchema = z.enum([
  "electron",
  "react-native",
  "terminal",
]) satisfies z.ZodType<HostTarget>;

export const HostTargetSelectionInputSchema = z.object({
  source: z.string().min(1),
  mode: z.enum(["follow-ref", "pinned-build", "pinned-ref"]).optional(),
  ref: z.string().min(1).optional(),
  buildKey: z.string().min(1).optional(),
  autoSelected: z.boolean().optional(),
}) satisfies z.ZodType<HostTargetSelectionInput>;

/** Full selection rows are produced server-side; type-bind without revalidating. */
export const HostTargetSelectionSchema = z.custom<HostTargetSelection>();
export const HostTargetCandidateSchema = z.custom<HostTargetCandidate>();

/** Result shape of `hostTargets.getSelection`. */
export const HostTargetSelectionStatusSchema = z.object({
  selection: HostTargetSelectionSchema.nullable(),
  valid: z.boolean(),
  reason: z.string().optional(),
});
export type HostTargetSelectionStatus = z.infer<typeof HostTargetSelectionStatusSchema>;

export const HostTargetLaunchResultSchema = z.custom<SharedHostTargetLaunchResult>((value) => {
  if (!value || typeof value !== "object") return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === "ready" ||
    status === "approval-required" ||
    status === "preparing" ||
    status === "unavailable"
  );
});
export type HostTargetLaunchResult = z.infer<typeof HostTargetLaunchResultSchema>;
export const HostTargetLaunchSessionSnapshotSchema = z.custom<HostTargetLaunchSessionSnapshot>(
  (value) => {
    if (!value || typeof value !== "object") return false;
    return typeof (value as { sessionId?: unknown }).sessionId === "string";
  }
);
export type HostTargetLaunchSession = z.infer<typeof HostTargetLaunchSessionSnapshotSchema>;

// ─── Workspace data schemas ───────────────────────────────────────────────────

export const WorkspaceEntrySchema = z.object({
  name: z.string(),
  lastOpened: z.number(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

/** WorkspaceConfig is a large hand-maintained interface; type-bind only. */
export const WorkspaceConfigSchema = z.custom<WorkspaceConfig>();

export const WorkspaceAppVersionRecordSchema = z.object({
  version: z.string(),
  target: z.string(),
  capabilities: z.array(z.string()),
  activeEv: z.string().nullable(),
  activeSourceHash: z.string().nullable(),
  activeBundleKey: z.string(),
  activeDependencyEvs: z.record(z.string()),
  activeExternalDeps: z.record(z.string()),
  activeRuntimeDepsKey: z.string().nullable(),
  activatedAt: z.number(),
});
export type WorkspaceAppVersionRecord = z.infer<typeof WorkspaceAppVersionRecordSchema>;

export const WorkspaceAppVersionsSchema = z.object({
  current: WorkspaceAppVersionRecordSchema.nullable(),
  previous: z.array(WorkspaceAppVersionRecordSchema),
  retentionLimit: z.number(),
});
export type WorkspaceAppVersions = z.infer<typeof WorkspaceAppVersionsSchema>;

export const WorkspaceUnitStatusSchema = z.object({
  name: z.string(),
  kind: z.enum(["panel", "worker", "extension", "app"]),
  source: z.string(),
  displayName: z.string().optional(),
  status: z.enum(["running", "stopped", "error", "pending-approval", "building", "available"]),
  version: z.string().optional(),
  ev: z.string().nullable().optional(),
  activeEv: z.string().nullable().optional(),
  activeBundleKey: z.string().nullable().optional(),
  activeRuntimeDepsKey: z.string().nullable().optional(),
  /** Epoch ms when the currently active build was produced (best-effort; null if unknown). */
  lastBuiltAt: z.number().nullable().optional(),
  /** Worker bindings (DOs, env). Only populated for kind === "worker". */
  bindings: z.record(z.unknown()).nullable().optional(),
  /**
   * Set when an extension install/update approval is currently in flight,
   * so a "running units" panel can surface a "pending approval" affordance
   * without polling the approval queue separately.
   */
  pendingApproval: z.object({ kind: z.string(), submittedAt: z.number() }).nullable().optional(),
  /**
   * Set when current workspace state would change the unit's runtime inputs
   * (a dependency push, an external-dep bump). Driven by needsBuildRefresh
   * for extensions; absent for workers/panels in v1.
   */
  availableUpdate: z
    .object({ reason: z.literal("dependency"), checkedAt: z.number() })
    .nullable()
    .optional(),
  lastError: z.string().nullable().optional(),
  lastErrorDetails: z.unknown().optional(),
  target: z.string().optional(),
  canRollback: z.boolean().optional(),
  rollbackRetentionLimit: z.number().optional(),
  previousVersions: z.array(WorkspaceAppVersionRecordSchema).optional(),
  health: z.unknown().optional(),
  methods: z.array(z.string()).optional(),
  hasFetch: z.boolean().optional(),
  respawn: z
    .object({ attempts: z.number(), nextAttemptAt: z.number().nullable() })
    .nullable()
    .optional(),
  inspectorUrl: z.string().nullable().optional(),
});
export type WorkspaceUnitStatus = z.infer<typeof WorkspaceUnitStatusSchema>;

export const WorkspaceUnitLogRecordSchema = z.object({
  workspaceId: z.string(),
  unitName: z.string(),
  kind: z.enum(["extension", "worker", "panel", "app"]),
  timestamp: z.number(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  fields: z.record(z.unknown()).optional(),
  source: z
    .enum(["stdout", "stderr", "ctx.log", "console", "lifecycle", "system", "runner"])
    .optional(),
  /** Monotonic per-unit sequence — exact resume cursor for `sinceSeq` polling. */
  seq: z.number().optional(),
});
export type WorkspaceUnitLogRecord = z.infer<typeof WorkspaceUnitLogRecordSchema>;

export const WorkspaceUnitBuildEventSchema = z.object({
  type: z.enum(["build-started", "build-complete", "build-error"]),
  name: z.string(),
  relativePath: z.string().optional(),
  buildKey: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
});
export type WorkspaceUnitBuildEvent = z.infer<typeof WorkspaceUnitBuildEventSchema>;

export const WorkspaceUnitDiagnosticsSchema = z.object({
  unit: WorkspaceUnitStatusSchema.nullable(),
  logs: z.array(WorkspaceUnitLogRecordSchema),
  errors: z.array(WorkspaceUnitLogRecordSchema),
  /** Recent state-triggered build lifecycle events for the unit. */
  builds: z.array(WorkspaceUnitBuildEventSchema),
  dropped: z.object({ entries: z.number(), errors: z.number() }),
  capacity: z.object({ entries: z.number(), errors: z.number() }),
});
export type WorkspaceUnitDiagnostics = z.infer<typeof WorkspaceUnitDiagnosticsSchema>;

export const WorkspaceRecurringJobStatusSchema = z.object({
  name: z.string(),
  target: z.object({
    source: z.string(),
    className: z.string(),
    objectKey: z.string(),
    method: z.string(),
  }),
  args: z.array(z.unknown()),
  schedule: z.object({
    intervalMs: z.number(),
    atMinutes: z.number().nullable(),
  }),
  specHash: z.string(),
  status: z.enum(["scheduled", "backing-off", "failing"]),
  nextRunAt: z.number(),
  lastRunAt: z.number().nullable(),
  lastStartedAt: z.number().nullable(),
  lastSucceededAt: z.number().nullable(),
  lastFailedAt: z.number().nullable(),
  lastError: z.string().nullable(),
  lastDurationMs: z.number().nullable(),
  failCount: z.number(),
  backoffUntil: z.number().nullable(),
});
export type WorkspaceRecurringJobStatus = z.infer<typeof WorkspaceRecurringJobStatusSchema>;

export const WorkspaceHeartbeatStatusSchema = z.object({
  name: z.string(),
  target: z.object({
    source: z.string(),
    className: z.string(),
    objectKey: z.string(),
  }),
  channelId: z.string().nullable(),
  participantHandle: z.string().nullable(),
  kind: z.enum(["declarative", "code-owned"]),
  status: z.enum(["running", "paused", "stopped"]),
  nextRunAt: z.number().nullable(),
  lastWakeAt: z.number().nullable(),
  lastActionSummary: z.string().nullable(),
  lastError: z.string().nullable(),
  specHash: z.string().nullable(),
  updatedAt: z.number(),
});
export type WorkspaceHeartbeatStatus = z.infer<typeof WorkspaceHeartbeatStatusSchema>;

export const WorkspaceHeartbeatSelectorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    target: z
      .object({
        source: z.string().optional(),
        className: z.string().optional(),
        objectKey: z.string().optional(),
      })
      .optional(),
    channelId: z.string().optional(),
    participantHandle: z.string().optional(),
  }),
]);
export type WorkspaceHeartbeatSelector = z.infer<typeof WorkspaceHeartbeatSelectorSchema>;

export const HeartbeatTickResultSchema = z.object({
  action: z.enum(["skip", "prompt", "continue", "none"]),
  enqueued: z.boolean(),
  skippedReason: z.string().optional(),
  nextRunAt: z.number().nullable().optional(),
  decision: z.unknown().optional(),
  error: z.string().optional(),
});
export type WorkspaceHeartbeatTickResult = z.infer<typeof HeartbeatTickResultSchema>;

export const SkillEntrySchema = z.object({
  /** Skill identifier (from frontmatter `name:`, falling back to the directory name). */
  name: z.string(),
  /** Short human-readable description from frontmatter `description:` (may be empty). */
  description: z.string(),
  /** Workspace-relative directory path, always `skills/<dirname>`. */
  dirPath: z.string(),
});

export type WorkspaceTreeNode = WorkspaceNode;
export const WorkspaceTreeNodeSchema: z.ZodType<WorkspaceTreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    isUnit: z.boolean(),
    launchable: z
      .object({ type: z.literal("app"), title: z.string(), hidden: z.boolean().optional() })
      .optional(),
    packageInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
    skillInfo: z.object({ name: z.string(), description: z.string() }).optional(),
    children: z.array(WorkspaceTreeNodeSchema),
  })
);

export const WorkspaceTreeSchema = z.object({
  children: z.array(WorkspaceTreeNodeSchema),
});
export type WorkspaceTree = z.infer<typeof WorkspaceTreeSchema>;

export const WorkspaceFindUnitForPathResultSchema = z
  .object({
    unitPath: z.string(),
    relativePath: z.string(),
  })
  .nullable();
export type WorkspaceFindUnitForPathResult = z.infer<typeof WorkspaceFindUnitForPathResultSchema>;

/** Options accepted by `units.logs`. */
const UnitLogsOptionsSchema = z.object({
  since: z.number().optional(),
  sinceSeq: z.number().optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ─── Method table ─────────────────────────────────────────────────────────────

export const workspaceMethods = defineServiceMethods({
  // Read methods
  getInfo: {
    description:
      "Filesystem paths (source, state, contexts) and resolved config for the active workspace.",
    args: z.tuple([]),
    returns: z.object({
      path: z.string().describe("Absolute path to the workspace source tree."),
      statePath: z.string().describe("Absolute path to the workspace's persisted state directory."),
      contextsPath: z.string().describe("Absolute path to the workspace's `.contexts` directory."),
      config: WorkspaceConfigSchema.describe("The resolved workspace config (meta/natstack.yml)."),
    }),
    access: READ_ACCESS,
  },
  list: {
    description: "List all known workspaces in the catalog with their last-opened timestamps.",
    args: z.tuple([]),
    returns: z.array(WorkspaceEntrySchema),
    access: READ_ACCESS,
  },
  getActive: {
    description: "Name (id) of the currently active workspace.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  getActiveEntry: {
    description: "Catalog entry (name + last-opened) for the currently active workspace.",
    args: z.tuple([]),
    returns: WorkspaceEntrySchema,
    access: READ_ACCESS,
  },
  getConfig: {
    description: "The active workspace's resolved config (meta/natstack.yml).",
    args: z.tuple([]),
    returns: WorkspaceConfigSchema,
    access: READ_ACCESS,
  },
  // Catalog-dependent write methods — the server omits these at registration
  // time when no workspace catalog is available (see module docs above).
  create: {
    description:
      "Create and register a new workspace on disk, optionally forking from an existing one; userland callers are approval-gated.",
    args: z.tuple([
      z.string().describe("Name (id) of the new workspace."),
      z
        .object({
          forkFrom: z
            .string()
            .optional()
            .describe("Name of an existing workspace to fork the new one from."),
        })
        .optional()
        .describe("Optional creation options."),
    ]),
    returns: WorkspaceEntrySchema,
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["my-new-ws"] }, { args: ["fork-ws", { forkFrom: "main" }] }],
  },
  delete: {
    description:
      "Permanently delete a workspace directory and remove it from the catalog; refuses to delete the active workspace and is approval-gated for userland.",
    args: z.tuple([z.string().describe("Name (id) of the workspace to delete.")]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "destructive" },
    examples: [{ args: ["old-ws"] }],
  },
  // SECURITY (#33, T2 in audit summary): `select` triggers an
  // app.relaunch() — disruptive and reachable only via shell UI.
  select: {
    description:
      "Switch the active workspace, touching the catalog and signalling the host to relaunch into it; disruptive and approval-gated for userland.",
    args: z.tuple([z.string().describe("Name (id) of the workspace to switch to.")]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "admin" },
    examples: [{ args: ["other-ws"] }],
  },
  setInitPanels: {
    description:
      "Replace the set of panels opened when this workspace starts; approval-gated for userland.",
    args: z.tuple([
      z
        .array(
          z.object({
            source: z.string().describe("Panel source path (e.g. `panels/chat`)."),
            stateArgs: z
              .record(z.unknown())
              .optional()
              .describe("Optional initial state args passed to the panel on launch."),
          })
        )
        .describe("Ordered list of init-panel descriptors."),
    ]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: [[{ source: "panels/chat" }]] }],
  },
  // SECURITY: arbitrary config-field writes — server-internal use
  // by default, but userland can request a one-shot approval.
  setConfigField: {
    description:
      "Write an arbitrary field into the workspace config (meta/natstack.yml); approval-gated for userland.",
    args: z.tuple([
      z.string().describe("Config field key to write."),
      z.unknown().describe("New value for the field."),
    ]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["title", "My Workspace"] }],
  },
  // Agent resource loading — read AGENTS.md and skill definitions directly
  // from the workspace source tree. Kept server-side because they touch
  // the filesystem; panels/workers call these over the RPC transport.
  getAgentsMd: {
    description:
      "Read the workspace-level meta/AGENTS.md, returning an empty string if it is absent.",
    args: z.tuple([]),
    returns: z.string(),
    access: READ_ACCESS,
  },
  listSkills: {
    description:
      "List skills under <workspace>/skills/* with name + description parsed from each SKILL.md frontmatter.",
    args: z.tuple([]),
    returns: z.array(SkillEntrySchema),
    access: READ_ACCESS,
  },
  readSkill: {
    description:
      "Return the raw SKILL.md contents for a single skill by name (single-segment names only; path traversal is rejected).",
    args: z.tuple([
      z.string().describe("Skill directory name under skills/ (e.g. `code-review`)."),
    ]),
    returns: z.string(),
    access: READ_ACCESS,
    examples: [{ args: ["code-review"] }],
  },
  sourceTree: {
    description: "Return the workspace source tree, annotating units, launchables, and skills.",
    args: z.tuple([]),
    returns: WorkspaceTreeSchema,
    access: READ_ACCESS,
  },
  findUnitForPath: {
    description:
      "Resolve a workspace-relative path to its owning unit and the path relative to that unit, or null if no unit owns it.",
    args: z.tuple([z.string().describe("Workspace-relative path to locate within the unit tree.")]),
    returns: WorkspaceFindUnitForPathResultSchema,
    access: READ_ACCESS,
    examples: [{ args: ["panels/chat/index.tsx"] }],
  },
  "units.list": {
    description:
      "List operational status rows for all workspace units (panels, workers, extensions, apps), including build/health state.",
    args: z.tuple([]),
    returns: z.array(WorkspaceUnitStatusSchema),
    access: READ_ACCESS,
  },
  "units.inspector": {
    description:
      "Return the devtools inspector URL for a unit by name or source, or null if it has none.",
    args: z.tuple([z.string().describe("Unit name or source path.")]),
    returns: z.object({ url: z.string().describe("Inspector websocket URL.") }).nullable(),
    access: READ_ACCESS,
    examples: [{ args: ["extensions/git-tools"] }],
  },
  "units.restart": {
    description: "Restart a workspace unit through its owning manager.",
    args: z.tuple([z.string().describe("Unit name or source path to restart.")]),
    returns: z.void(),
    access: { sensitivity: "write" },
    examples: [{ args: ["extensions/git-tools"] }],
  },
  "units.logs": {
    description:
      "Query retained log records for a unit, optionally filtered by time/sequence cursor, level, and limit.",
    args: z.tuple([
      z.string().describe("Unit name or source path."),
      UnitLogsOptionsSchema.optional(),
    ]),
    returns: z.array(WorkspaceUnitLogRecordSchema),
    access: READ_ACCESS,
    examples: [{ args: ["extensions/git-tools", { level: "error", limit: 50 }] }],
  },
  "units.diagnostics": {
    description:
      "Return combined diagnostics for a unit: current status, recent logs, errors, build events, and buffer capacity.",
    args: z.tuple([
      z.string().describe("Unit name or source path."),
      UnitLogsOptionsSchema.extend({
        errorLimit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Max number of error records to include."),
      }).optional(),
    ]),
    returns: WorkspaceUnitDiagnosticsSchema,
    access: READ_ACCESS,
  },
  "units.versions": {
    description:
      "List the active build and rollback-capable previous versions for an app unit; userland is restricted to managing its own app.",
    args: z.tuple([z.string().describe("App unit name or source path.")]),
    returns: WorkspaceAppVersionsSchema,
    access: READ_ACCESS,
    examples: [{ args: ["apps/shell"] }],
  },
  "units.rollback": {
    description:
      "Roll an app unit back to a previous active build (or a specific build key); userland is restricted to managing its own app.",
    args: z.tuple([
      z.string().describe("App unit name or source path."),
      z
        .object({
          buildKey: z
            .string()
            .optional()
            .describe("Specific build to roll back to; omit for the previous active build."),
        })
        .optional(),
    ]),
    returns: z.unknown(),
    access: { sensitivity: "write" },
    examples: [{ args: ["apps/shell"] }],
  },
  "units.bakeAppDist": {
    description:
      "Bake an app unit's active approved build into a packaging payload directory; trusted-chrome callers only.",
    args: z.tuple([
      z.string().describe("App unit name or source path."),
      z
        .object({
          outDir: z.string().optional().describe("Output directory for the baked dist payload."),
        })
        .optional(),
    ]),
    returns: z.unknown(),
    policy: { allowed: ["shell", "server"] },
    access: { sensitivity: "write" },
  },
  "recurring.list": {
    description:
      "List declarative scheduled jobs from meta/natstack.yml with their durable run state (next/last run, failures, backoff).",
    args: z.tuple([]),
    returns: z.array(WorkspaceRecurringJobStatusSchema),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: READ_ACCESS,
  },
  "heartbeats.list": {
    description: "List registered heartbeats with their schedule, channel binding, and run state.",
    args: z.tuple([]),
    returns: z.array(WorkspaceHeartbeatStatusSchema),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: READ_ACCESS,
  },
  "heartbeats.runNow": {
    description: "Trigger a heartbeat tick immediately for the selected heartbeat.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: HeartbeatTickResultSchema,
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "heartbeats.pause": {
    description: "Pause the selected heartbeat so it stops ticking until resumed.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: z.object({ ok: z.literal(true) }),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "heartbeats.resume": {
    description: "Resume a paused heartbeat so it resumes its schedule.",
    args: z.tuple([
      WorkspaceHeartbeatSelectorSchema.describe("Heartbeat name or a selector object."),
    ]),
    returns: z.object({ ok: z.literal(true) }),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["news-briefing"] }],
  },
  "hostTargets.list": {
    description: "List app candidates selectable as the active app for a host target.",
    args: z.tuple([HostTargetSchema.describe("Host target to list candidates for.")]),
    returns: z.array(HostTargetCandidateSchema),
    policy: { allowed: ["shell", "server"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.getSelection": {
    description:
      "Read the active per-workspace selection for a host target along with whether it is still valid.",
    args: z.tuple([HostTargetSchema.describe("Host target to read the selection for.")]),
    returns: HostTargetSelectionStatusSchema,
    policy: { allowed: ["shell", "server"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.setSelection": {
    description: "Persist the per-workspace app selection for a host target.",
    args: z.tuple([
      HostTargetSchema.describe("Host target to set the selection for."),
      HostTargetSelectionInputSchema.describe("Selection input (source, mode, ref/buildKey)."),
    ]),
    returns: HostTargetSelectionSchema,
    policy: { allowed: ["shell", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron", { source: "apps/shell" }] }],
  },
  "hostTargets.clearSelection": {
    description: "Clear the persisted per-workspace app selection for a host target.",
    args: z.tuple([HostTargetSchema.describe("Host target to clear the selection for.")]),
    returns: z.void(),
    policy: { allowed: ["shell", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.versions": {
    description: "List retained versions for a specific host-target candidate.",
    args: z.tuple([
      HostTargetSchema.describe("Host target the candidate belongs to."),
      z.string().describe("Candidate app source or name."),
    ]),
    returns: WorkspaceAppVersionsSchema,
    policy: { allowed: ["shell", "server"] },
    access: READ_ACCESS,
    examples: [{ args: ["electron", "apps/shell"] }],
  },
  "hostTargets.preparePinnedRef": {
    description:
      "Materialize a retained build for a specific ref of a host-target candidate through the build system.",
    args: z.tuple([
      HostTargetSchema.describe("Host target the candidate belongs to."),
      z.string().describe("Candidate app source or name."),
      z.string().describe("Git ref (branch/tag/sha) to materialize a build for."),
    ]),
    returns: z.unknown(),
    policy: { allowed: ["shell", "server"] },
    access: { sensitivity: "write" },
  },
  "hostTargets.launch": {
    description:
      "Launch or reload the selected target app in this host, returning a ready/preparing/approval-required/unavailable status.",
    args: z.tuple([HostTargetSchema.describe("Host target to launch.")]),
    returns: HostTargetLaunchResultSchema,
    policy: { allowed: ["shell", "app", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.beginLaunch": {
    description:
      "Begin an asynchronous launch session for a host target, returning the initial session snapshot.",
    args: z.tuple([HostTargetSchema.describe("Host target to begin launching.")]),
    returns: HostTargetLaunchSessionSnapshotSchema,
    policy: { allowed: ["shell", "app", "server"] },
    access: { sensitivity: "write" },
    examples: [{ args: ["electron"] }],
  },
  "hostTargets.getLaunchSession": {
    description: "Fetch the current snapshot of a launch session by id, or null if it is unknown.",
    args: z.tuple([z.string().describe("Launch session id.")]),
    returns: HostTargetLaunchSessionSnapshotSchema.nullable(),
    policy: { allowed: ["shell", "app", "server"] },
    access: READ_ACCESS,
  },
  "hostTargets.resolveLaunchSessionApproval": {
    description:
      "Resolve a pending approval on a launch session by allowing it once or denying it, returning the updated snapshot.",
    args: z.tuple([
      z.string().describe("Launch session id."),
      z.enum(["once", "deny"]).describe("Approval decision for the pending launch."),
    ]),
    returns: HostTargetLaunchSessionSnapshotSchema,
    policy: { allowed: ["shell", "app", "server"] },
    access: {
      sensitivity: "write",
    },
    examples: [{ args: ["session-123", "once"] }],
  },
  "hostTargets.cancelLaunchSession": {
    description: "Cancel an in-flight launch session by id.",
    args: z.tuple([z.string().describe("Launch session id to cancel.")]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "server"] },
    access: { sensitivity: "write" },
  },
});
