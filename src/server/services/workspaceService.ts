/**
 * Workspace RPC service — server-side workspace catalog and configuration.
 *
 * Single source of truth for all workspace operations: listing, reading config,
 * creating, deleting, switching, init-panel management. Lives on the server
 * because the server owns the workspace catalog (CentralDataManager) and the
 * filesystem ops; panels and workers reach it directly via WebSocket without
 * going through Electron.
 *
 * Method names match the runtime's `WorkspaceClient` interface (see
 * `workspace/packages/runtime/src/shared/workspace.ts`) so eval'd code can
 * `import { workspace } from "@workspace/runtime"` and call `workspace.list()`,
 * `workspace.create("name")`, etc. without an intermediate proxy.
 *
 * The `select` (workspace switch) method needs Electron's `app.relaunch()`,
 * which lives in the Electron main process. The server signals the relaunch
 * by calling `requestRelaunch(name)` from this service's deps; in IPC mode
 * that callback posts a parent-port message that ServerProcessManager
 * forwards to its `onRelaunch` handler. In standalone (no Electron) mode the
 * callback is a no-op and the caller is expected to reconnect manually.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { Workspace, WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { ApprovalPrincipal } from "@natstack/shared/approvals";
import type { ApprovalQueue } from "./approvalQueue.js";

/**
 * Minimal metadata for a skill directory under `<workspace>/skills/<name>/`.
 * Produced by walking the skills directory and parsing each SKILL.md's
 * YAML-ish frontmatter. Consumers use this to build the agent's skill catalog.
 */
export interface SkillEntry {
  /** Skill identifier (from frontmatter `name:`, falling back to the directory name). */
  name: string;
  /** Short human-readable description from frontmatter `description:` (may be empty). */
  description: string;
  /** Workspace-relative directory path, always `skills/<dirname>`. */
  dirPath: string;
}

/**
 * Parse a very small subset of YAML frontmatter: a leading `---` fence, one
 * `key: value` per line (values are trimmed strings), and a closing `---`.
 * Returns an empty object if no frontmatter is present. This deliberately
 * does not try to be a full YAML parser — SKILL.md files only need flat
 * key/value metadata and pulling in js-yaml just for this would be overkill.
 */
function parseFrontmatter(content: string): Record<string, string> {
  // Allow an optional BOM / leading whitespace before the opening fence.
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const body = match[1] ?? "";
  const result: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

export interface CentralDataLike {
  listWorkspaces(): unknown[];
  hasWorkspace(name: string): boolean;
  addWorkspace(name: string): void;
  removeWorkspace(name: string): void;
  touchWorkspace(name: string): void;
  getWorkspaceEntry(name: string): unknown | null;
}

export interface WorkspaceServiceDeps {
  workspace: Workspace;
  getConfig: () => WorkspaceConfig;
  setConfigField: (key: string, value: unknown) => void;
  /** Central workspace catalog. null only in remote-server mode. */
  centralData: CentralDataLike | null;
  /** Create + register a new workspace on disk. */
  createWorkspace: (name: string, opts?: { forkFrom?: string }) => unknown;
  /** Delete a workspace directory from disk. */
  deleteWorkspaceDir: (name: string) => void;
  /**
   * Signal the host (Electron main) to relaunch into a different workspace.
   * In IPC mode this posts a parent-port message; in standalone mode it's
   * a no-op (the caller is expected to reconnect manually).
   */
  requestRelaunch?: (name: string) => void;
  /**
   * IPC proxy: fetch the workspace catalog from Electron main when
   * centralData is null (IPC mode). This keeps workspace.list() consistent
   * with workspace.getActive() regardless of runtime mode.
   */
  requestWorkspaceList?: () => Promise<unknown[]>;
  /** Workspace-unit operational status rows, including extension health. */
  listUnits?: () => Promise<WorkspaceUnitStatus[]> | WorkspaceUnitStatus[];
  /** Restart a workspace unit through the owning manager. */
  restartUnit?: (ctx: ServiceContext, name: string) => Promise<void>;
  /** Query retained logs for a workspace unit. */
  listUnitLogs?: (
    name: string,
    opts?: { since?: number; level?: WorkspaceUnitLogRecord["level"]; limit?: number }
  ) => Promise<WorkspaceUnitLogRecord[]> | WorkspaceUnitLogRecord[];
  /** Queue used to gate userland workspace mutations. */
  approvalQueue?: Pick<ApprovalQueue, "requestUserland">;
}

export interface WorkspaceUnitStatus {
  name: string;
  kind: "panel" | "worker" | "extension";
  source: string;
  displayName?: string;
  enabled?: boolean;
  status: "running" | "stopped" | "error" | "pending-approval" | "building" | "available";
  version?: string;
  ev?: string | null;
  activeEv?: string | null;
  activeBundleKey?: string | null;
  activeRuntimeDepsKey?: string | null;
  /** Epoch ms when the currently active build was produced (best-effort; null if unknown). */
  lastBuiltAt?: number | null;
  /** Worker bindings (DOs, env). Only populated for kind === "worker". */
  bindings?: Record<string, unknown> | null;
  /**
   * Set when an extension install/update approval is currently in flight,
   * so a "running units" panel can surface a "pending approval" affordance
   * without polling the approval queue separately.
   */
  pendingApproval?: { kind: string; submittedAt: number } | null;
  /**
   * Set when current workspace state would change the unit's runtime inputs
   * (a dependency push, an external-dep bump). Driven by needsBuildRefresh
   * for extensions; absent for workers/panels in v1.
   */
  availableUpdate?: { reason: "dependency"; checkedAt: number } | null;
  lastError?: string | null;
  health?: unknown;
  methods?: string[];
  hasFetch?: boolean;
  respawn?: { attempts: number; nextAttemptAt: number | null } | null;
  inspectorUrl?: string | null;
}

export interface WorkspaceUnitLogRecord {
  workspaceId: string;
  unitName: string;
  kind: "extension" | "worker" | "panel";
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  source?: "stdout" | "stderr" | "ctx.log" | "console";
}

type WorkspaceApprovalOperation =
  | "create"
  | "delete"
  | "select"
  | "setInitPanels"
  | "setConfigField";

function isTrustedWorkspaceCaller(ctx: ServiceContext): boolean {
  return ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server";
}

function truncateApprovalValue(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function safeSubjectSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._:/-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 48) || "unknown";
}

function describeJson(value: unknown): string {
  try {
    return truncateApprovalValue(JSON.stringify(value));
  } catch {
    return "[unserializable value]";
  }
}

function resolveWorkspacePrincipal(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  method: WorkspaceApprovalOperation
): ApprovalPrincipal {
  if (
    ctx.caller.runtime.kind !== "panel" &&
    ctx.caller.runtime.kind !== "worker" &&
    ctx.caller.runtime.kind !== "do"
  ) {
    throw new ServiceError(
      "workspace",
      method,
      "Workspace mutation approvals are only available to panel, worker, and DO callers",
      "EACCES"
    );
  }
  if (!deps.approvalQueue) {
    throw new ServiceError(
      "workspace",
      method,
      "Workspace mutation approval is unavailable",
      "EACCES"
    );
  }
  const identity = ctx.caller.code;
  if (!identity) {
    throw new ServiceError(
      "workspace",
      method,
      `Unknown caller identity: ${ctx.caller.runtime.id}`,
      "ENOENT"
    );
  }
  if (identity.callerKind !== ctx.caller.runtime.kind) {
    throw new ServiceError(
      "workspace",
      method,
      `Caller identity kind mismatch for ${ctx.caller.runtime.id}`,
      "EACCES"
    );
  }
  return {
    callerId: identity.callerId,
    callerKind: identity.callerKind,
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
  };
}

async function requireWorkspaceApproval(
  deps: WorkspaceServiceDeps,
  ctx: ServiceContext,
  operation: WorkspaceApprovalOperation,
  approval: {
    target: string;
    title: string;
    summary: string;
    warning?: string;
    details?: Array<{ label: string; value: string }>;
  }
): Promise<void> {
  if (isTrustedWorkspaceCaller(ctx)) return;
  const principal = resolveWorkspacePrincipal(deps, ctx, operation);
  const approvalQueue = deps.approvalQueue;
  if (!approvalQueue) {
    throw new ServiceError(
      "workspace",
      operation,
      "Workspace mutation approval is unavailable",
      "EACCES"
    );
  }
  const result = await approvalQueue.requestUserland({
    principal,
    subject: {
      id: `workspace:${operation}:${safeSubjectSegment(approval.target)}:${randomUUID()}`,
      label: `workspace ${operation}`,
    },
    title: approval.title,
    summary: approval.summary,
    warning: approval.warning,
    details: [
      { label: "Caller", value: principal.callerId },
      { label: "Workspace", value: deps.getConfig().id },
      { label: "Target", value: truncateApprovalValue(approval.target) },
      ...(approval.details ?? []),
    ].slice(0, 8),
    options: [
      {
        value: "allow",
        label: "Allow",
        description: "Allow this workspace operation once.",
        tone: "primary",
      },
      {
        value: "deny",
        label: "Deny",
        description: "Block this workspace operation.",
        tone: "danger",
      },
    ],
  });
  if (result.kind !== "choice" || result.choice !== "allow") {
    throw new ServiceError("workspace", operation, "Workspace operation was denied", "EACCES");
  }
}

export function createWorkspaceService(deps: WorkspaceServiceDeps): ServiceDefinition {
  const { workspace } = deps;

  // Catalog-dependent methods are conditionally registered based on whether
  // we have a workspace catalog (`centralData`) at all. In remote-server /
  // mobile-client mode there's no catalog here, so creation/deletion can't
  // be fulfilled — and advertising them only to fail with "Workspace creation
  // not available" AFTER schema validation is confusing for callers (they
  // see two completely different errors depending on whether their args
  // happen to be schema-valid). Omit the methods entirely instead: callers
  // get a single, consistent "Unknown workspace method: create" that makes
  // it obvious the API isn't available in this mode.
  const catalogMethods: ServiceDefinition["methods"] = deps.centralData
    ? {
        create: {
          args: z.tuple([z.string(), z.object({ forkFrom: z.string().optional() }).optional()]),
          policy: { allowed: ["shell", "panel", "worker", "do", "server"] },
        },
        delete: {
          args: z.tuple([z.string()]),
          policy: { allowed: ["shell", "panel", "worker", "do", "server"] },
        },
      }
    : {};

  return {
    name: "workspace",
    description: "Workspace catalog, configuration, and lifecycle (list, create, switch, etc.)",
    policy: { allowed: ["shell", "panel", "worker", "do", "extension", "server"] },
    methods: {
      // Read methods
      getInfo: { args: z.tuple([]) },
      list: { args: z.tuple([]) },
      getActive: { args: z.tuple([]) },
      getActiveEntry: { args: z.tuple([]) },
      getConfig: { args: z.tuple([]) },
      // Catalog-dependent write methods (conditionally registered above).
      ...catalogMethods,
      // SECURITY (#33, T2 in audit summary): `select` triggers an
      // app.relaunch() — disruptive and reachable only via shell UI.
      select: {
        args: z.tuple([z.string()]),
        policy: { allowed: ["shell", "panel", "worker", "do", "server"] },
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
        policy: { allowed: ["shell", "panel", "worker", "do", "server"] },
      },
      // SECURITY: arbitrary config-field writes — server-internal use
      // by default, but userland can request a one-shot approval.
      setConfigField: {
        args: z.tuple([z.string(), z.unknown()]),
        policy: { allowed: ["shell", "panel", "worker", "do", "server"] },
      },
      // Agent resource loading — read AGENTS.md and skill definitions directly
      // from the workspace source tree. Kept server-side because they touch
      // the filesystem; panels/workers call these over the RPC transport.
      getAgentsMd: { args: z.tuple([]) },
      listSkills: { args: z.tuple([]) },
      readSkill: { args: z.tuple([z.string()]) },
      "units.list": { args: z.tuple([]) },
      "units.inspector": { args: z.tuple([z.string()]) },
      "units.restart": { args: z.tuple([z.string()]) },
      "units.logs": {
        args: z.tuple([
          z.string(),
          z
            .object({
              since: z.number().optional(),
              level: z.enum(["debug", "info", "warn", "error"]).optional(),
              limit: z.number().int().positive().max(1000).optional(),
            })
            .optional(),
        ]),
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        // -----------------------------------------------------------------
        // Reads
        // -----------------------------------------------------------------

        case "getInfo":
          return {
            path: workspace.path,
            statePath: workspace.statePath,
            contextsPath: workspace.contextsPath,
            config: deps.getConfig(),
          };

        case "list":
          if (deps.centralData) return deps.centralData.listWorkspaces();
          // IPC mode: proxy to Electron main which owns the catalog
          if (deps.requestWorkspaceList) return deps.requestWorkspaceList();
          return [];

        case "getActive":
          return deps.getConfig().id;

        case "getActiveEntry":
          if (!deps.centralData) return null;
          return deps.centralData.getWorkspaceEntry(deps.getConfig().id);

        case "getConfig":
          return deps.getConfig();

        // -----------------------------------------------------------------
        // Writes
        // -----------------------------------------------------------------

        case "create": {
          if (!deps.centralData) throw new Error("Workspace creation not available");
          const [name, opts] = args as [string, { forkFrom?: string } | undefined];
          await requireWorkspaceApproval(deps, ctx, "create", {
            target: name,
            title: "Create workspace?",
            summary: "This panel or worker wants to create a new workspace.",
            details: opts?.forkFrom ? [{ label: "Fork from", value: opts.forkFrom }] : undefined,
          });
          return deps.createWorkspace(name, opts);
        }

        case "delete": {
          if (!deps.centralData) throw new Error("Workspace deletion not available");
          const [name] = args as [string];
          if (name === deps.getConfig().id) {
            throw new Error("Cannot delete the currently running workspace");
          }
          await requireWorkspaceApproval(deps, ctx, "delete", {
            target: name,
            title: "Delete workspace?",
            summary: "This panel or worker wants to permanently delete a workspace.",
            warning: "This removes the workspace directory and cannot be undone.",
          });
          deps.deleteWorkspaceDir(name);
          deps.centralData.removeWorkspace(name);
          return;
        }

        case "select": {
          const [name] = args as [string];
          await requireWorkspaceApproval(deps, ctx, "select", {
            target: name,
            title: "Switch workspace?",
            summary: "This panel or worker wants to switch the active workspace.",
            warning: "Switching workspaces relaunches the app.",
          });
          // Touch the catalog so the workspace is marked as recently opened.
          deps.centralData?.touchWorkspace(name);
          // Signal the host to relaunch with the new workspace. In IPC mode
          // this posts a parent-port message that ServerProcessManager forwards
          // to Electron main, which calls app.relaunch(). In standalone mode
          // requestRelaunch is undefined and the caller must reconnect manually.
          deps.requestRelaunch?.(name);
          return;
        }

        case "setInitPanels": {
          const [initPanels] = args as [
            Array<{ source: string; stateArgs?: Record<string, unknown> }>,
          ];
          await requireWorkspaceApproval(deps, ctx, "setInitPanels", {
            target: deps.getConfig().id,
            title: "Change initial workspace panels?",
            summary: "This panel or worker wants to change the panels opened for this workspace.",
            details: [{ label: "Init panels", value: describeJson(initPanels) }],
          });
          deps.setConfigField("initPanels", initPanels);
          return;
        }

        case "setConfigField": {
          const [key, value] = args as [string, unknown];
          await requireWorkspaceApproval(deps, ctx, "setConfigField", {
            target: key,
            title: "Change workspace config?",
            summary: "This panel or worker wants to write a field in meta/natstack.yml.",
            warning: "Changing workspace config can affect how the workspace starts and runs.",
            details: [
              { label: "Config key", value: key },
              { label: "New value", value: describeJson(value) },
            ],
          });
          deps.setConfigField(key, value);
          return;
        }

        // -----------------------------------------------------------------
        // Agent resource loading (filesystem reads from the workspace tree)
        // -----------------------------------------------------------------

        case "getAgentsMd": {
          // Read the workspace-level AGENTS.md from meta/. Missing file is not
          // an error — an empty string lets the agent resource loader fall back.
          const filePath = path.join(workspace.path, "meta", "AGENTS.md");
          try {
            return await fs.readFile(filePath, "utf-8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw err;
          }
        }

        case "listSkills": {
          // Walk <workspace>/skills/*/SKILL.md and return a catalog of skills
          // with just enough metadata (name + description) for the agent to
          // decide which ones to load. Directories without a valid SKILL.md
          // are silently skipped — they may be in-progress or unrelated.
          const skillsDir = path.join(workspace.path, "skills");
          let entries: string[] = [];
          try {
            entries = await fs.readdir(skillsDir);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw err;
          }
          const skills: SkillEntry[] = [];
          for (const entry of entries) {
            const skillMdPath = path.join(skillsDir, entry, "SKILL.md");
            try {
              const content = await fs.readFile(skillMdPath, "utf-8");
              const fm = parseFrontmatter(content);
              skills.push({
                name: fm["name"] ?? entry,
                description: fm["description"] ?? "",
                dirPath: `skills/${entry}`,
              });
            } catch {
              // No SKILL.md (or unreadable): not a skill, skip.
            }
          }
          return skills;
        }

        case "readSkill": {
          const [name] = args as [string];
          // Strictly validate to block any path-traversal attempt (../, slashes,
          // null bytes, etc). Only simple single-segment names are allowed, and
          // they must match the directory layout produced by listSkills.
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
            throw new Error(`Invalid skill name: ${name}`);
          }
          const skillMdPath = path.join(workspace.path, "skills", name, "SKILL.md");
          return await fs.readFile(skillMdPath, "utf-8");
        }

        case "units.list":
          return deps.listUnits ? await deps.listUnits() : [];

        case "units.inspector": {
          const [name] = args as [string];
          const rows = deps.listUnits ? await deps.listUnits() : [];
          const row = rows.find((unit) => unit.name === name || unit.source === name);
          const url = row?.inspectorUrl ?? null;
          return url ? { url } : null;
        }

        case "units.restart": {
          if (!deps.restartUnit) throw new Error("Workspace unit restart not available");
          const [name] = args as [string];
          await deps.restartUnit(ctx, name);
          return;
        }

        case "units.logs": {
          if (!deps.listUnitLogs) return [];
          const [name, opts] = args as [
            string,
            { since?: number; level?: WorkspaceUnitLogRecord["level"]; limit?: number } | undefined,
          ];
          return await deps.listUnitLogs(name, opts);
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
