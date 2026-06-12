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
import { defineServiceMethods } from "../typedServiceClient.js";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "../hostTargets.js";
import type { WorkspaceConfig } from "../workspace/types.js";

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
  mode: z.enum(["follow-ref", "pinned-build", "pinned-commit"]).optional(),
  ref: z.string().min(1).optional(),
  buildKey: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
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

export const HostTargetLaunchResultSchema = z.object({
  launched: z.boolean(),
});
export type HostTargetLaunchResult = z.infer<typeof HostTargetLaunchResultSchema>;

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
  activeSha: z.string().nullable(),
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
  source: z.enum(["stdout", "stderr", "ctx.log", "console", "lifecycle", "system"]).optional(),
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
  /** Recent push-triggered build lifecycle events for the unit. */
  builds: z.array(WorkspaceUnitBuildEventSchema),
  dropped: z.object({ entries: z.number(), errors: z.number() }),
  capacity: z.object({ entries: z.number(), errors: z.number() }),
});
export type WorkspaceUnitDiagnostics = z.infer<typeof WorkspaceUnitDiagnosticsSchema>;

export const SkillEntrySchema = z.object({
  /** Skill identifier (from frontmatter `name:`, falling back to the directory name). */
  name: z.string(),
  /** Short human-readable description from frontmatter `description:` (may be empty). */
  description: z.string(),
  /** Workspace-relative directory path, always `skills/<dirname>`. */
  dirPath: z.string(),
});

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
    args: z.tuple([]),
    returns: z.object({
      path: z.string(),
      statePath: z.string(),
      contextsPath: z.string(),
      config: WorkspaceConfigSchema,
    }),
  },
  list: { args: z.tuple([]), returns: z.array(WorkspaceEntrySchema) },
  getActive: { args: z.tuple([]), returns: z.string() },
  getActiveEntry: { args: z.tuple([]), returns: WorkspaceEntrySchema },
  getConfig: { args: z.tuple([]), returns: WorkspaceConfigSchema },
  // Catalog-dependent write methods — the server omits these at registration
  // time when no workspace catalog is available (see module docs above).
  create: {
    args: z.tuple([z.string(), z.object({ forkFrom: z.string().optional() }).optional()]),
    returns: WorkspaceEntrySchema,
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
  },
  delete: {
    args: z.tuple([z.string()]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
  },
  // SECURITY (#33, T2 in audit summary): `select` triggers an
  // app.relaunch() — disruptive and reachable only via shell UI.
  select: {
    args: z.tuple([z.string()]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
  },
  setInitPanels: {
    args: z.tuple([
      z.array(
        z.object({
          source: z.string(),
          stateArgs: z.record(z.unknown()).optional(),
        })
      ),
    ]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
  },
  // SECURITY: arbitrary config-field writes — server-internal use
  // by default, but userland can request a one-shot approval.
  setConfigField: {
    args: z.tuple([z.string(), z.unknown()]),
    returns: z.void(),
    policy: { allowed: ["shell", "app", "panel", "worker", "do", "server"] },
  },
  // Agent resource loading — read AGENTS.md and skill definitions directly
  // from the workspace source tree. Kept server-side because they touch
  // the filesystem; panels/workers call these over the RPC transport.
  getAgentsMd: { args: z.tuple([]), returns: z.string() },
  listSkills: { args: z.tuple([]), returns: z.array(SkillEntrySchema) },
  readSkill: { args: z.tuple([z.string()]), returns: z.string() },
  "units.list": { args: z.tuple([]), returns: z.array(WorkspaceUnitStatusSchema) },
  "units.inspector": {
    args: z.tuple([z.string()]),
    returns: z.object({ url: z.string() }).nullable(),
  },
  "units.restart": { args: z.tuple([z.string()]), returns: z.void() },
  "units.logs": {
    args: z.tuple([z.string(), UnitLogsOptionsSchema.optional()]),
    returns: z.array(WorkspaceUnitLogRecordSchema),
  },
  "units.diagnostics": {
    args: z.tuple([
      z.string(),
      UnitLogsOptionsSchema.extend({
        errorLimit: z.number().int().positive().max(500).optional(),
      }).optional(),
    ]),
    returns: WorkspaceUnitDiagnosticsSchema,
  },
  "units.versions": {
    args: z.tuple([z.string()]),
    returns: WorkspaceAppVersionsSchema,
  },
  "units.rollback": {
    args: z.tuple([z.string(), z.object({ buildKey: z.string().optional() }).optional()]),
    returns: z.unknown(),
  },
  "units.bakeAppDist": {
    args: z.tuple([z.string(), z.object({ outDir: z.string().optional() }).optional()]),
    returns: z.unknown(),
    policy: { allowed: ["shell", "server"] },
  },
  "hostTargets.list": {
    args: z.tuple([HostTargetSchema]),
    returns: z.array(HostTargetCandidateSchema),
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.getSelection": {
    args: z.tuple([HostTargetSchema]),
    returns: HostTargetSelectionStatusSchema,
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.setSelection": {
    args: z.tuple([HostTargetSchema, HostTargetSelectionInputSchema]),
    returns: HostTargetSelectionSchema,
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.clearSelection": {
    args: z.tuple([HostTargetSchema]),
    returns: z.void(),
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.versions": {
    args: z.tuple([HostTargetSchema, z.string()]),
    returns: WorkspaceAppVersionsSchema,
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.preparePinnedCommit": {
    args: z.tuple([HostTargetSchema, z.string(), z.string()]),
    returns: z.unknown(),
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
  "hostTargets.launch": {
    args: z.tuple([HostTargetSchema]),
    returns: HostTargetLaunchResultSchema,
    policy: { allowed: ["shell", "shell-remote", "server"] },
  },
});
