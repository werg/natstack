/**
 * Wire schema for external Git interop only.
 *
 * Workspace version control is GAD-native (`vcs.*`). This service exists for
 * deliberate Git boundary operations: configuring external remotes and
 * importing remote projects.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the gitInterop method group. All four
// methods mutate workspace config (`meta/natstack.yml`) and/or reach the
// network/filesystem.
const SHARED_REMOTE_WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const SHARED_REMOTE_REMOVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const IMPORT_PROJECT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const COMPLETE_DEPENDENCIES_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const gitRemoteSchema = z.object({
  name: z.string().describe('Git remote name, e.g. "origin".'),
  url: z.string().describe("Remote fetch/push URL (https or git)."),
  branch: z
    .string()
    .optional()
    .describe("Default branch to track/clone; omit to use the remote's default."),
});
export type GitRemote = z.infer<typeof gitRemoteSchema>;

const gitRemoteDeclarationSchema = z.union([
  z.string(),
  z.object({
    url: z.string(),
    branch: z.string().nullable().optional(),
  }),
]);

export const gitSharedRemotesSchema = z.record(
  z.record(z.record(gitRemoteDeclarationSchema.nullable().optional()).optional()).optional()
);
export type GitSharedRemotes = z.infer<typeof gitSharedRemotesSchema>;

export const gitImportProjectSchema = z.object({
  path: z
    .string()
    .describe(
      'Workspace-relative target path for the imported repo; must sit under a supported import dir (e.g. "projects/<name>").'
    ),
  remote: gitRemoteSchema.describe("Remote to clone from and record as a shared remote."),
  branch: z
    .string()
    .optional()
    .describe("Branch to clone; overrides remote.branch when both are given."),
  credentialId: z
    .string()
    .optional()
    .describe("Credential to authenticate the clone via the egress proxy."),
});
export type GitImportProjectRequest = z.infer<typeof gitImportProjectSchema>;

export const gitCompleteWorkspaceDependenciesSchema = z.object({
  credentialId: z
    .string()
    .optional()
    .describe("Credential used to authenticate clones of the configured remotes."),
});
export type GitCompleteWorkspaceDependenciesOptions = z.infer<
  typeof gitCompleteWorkspaceDependenciesSchema
>;

export const gitImportedWorkspaceRepoSchema = z.object({
  path: z.string(),
  remote: gitRemoteSchema,
});
export type GitImportedWorkspaceRepo = z.infer<typeof gitImportedWorkspaceRepoSchema>;

export const gitCompleteWorkspaceDependenciesResultSchema = z.object({
  imported: z.array(gitImportedWorkspaceRepoSchema),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(["already-present", "unsupported-path"]),
    })
  ),
  failed: z.array(
    z.object({
      path: z.string(),
      error: z.string(),
    })
  ),
});
export type GitCompleteWorkspaceDependenciesResult = z.infer<
  typeof gitCompleteWorkspaceDependenciesResultSchema
>;

export const gitInteropMethods = defineServiceMethods({
  setSharedRemote: {
    description:
      "Declare or update the external Git remote shared across workspace contexts for a unit, persisting it to meta/natstack.yml and syncing it into the repo's git config; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the remote applies to."),
      gitRemoteSchema,
    ]),
    returns: gitSharedRemotesSchema.optional(),
    access: SHARED_REMOTE_WRITE_ACCESS,
    examples: [
      {
        args: [
          "projects/bgkit",
          { name: "origin", url: "https://github.com/werg/bgkit.git", branch: "main" },
        ],
      },
    ],
  },
  removeSharedRemote: {
    description:
      "Remove a named shared Git remote declaration for a workspace unit from meta/natstack.yml and sync the repo's git config; may prompt for capability approval.",
    args: z.tuple([
      z.string().describe("Workspace-relative repo/unit path the remote belongs to."),
      z.string().describe('Name of the remote to remove, e.g. "origin".'),
    ]),
    returns: gitSharedRemotesSchema.optional(),
    access: SHARED_REMOTE_REMOVE_ACCESS,
    examples: [{ args: ["projects/bgkit", "origin"] }],
  },
  importProject: {
    description:
      "Clone an external Git project into the workspace at the requested path and record its remote in meta/natstack.yml; clones over the network and may prompt for config-write approval.",
    args: z.tuple([gitImportProjectSchema]),
    returns: gitImportedWorkspaceRepoSchema,
    access: IMPORT_PROJECT_ACCESS,
    examples: [
      {
        args: [
          {
            path: "projects/bgkit",
            remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
            branch: "natstack-bridge",
          },
        ],
      },
    ],
  },
  completeWorkspaceDependencies: {
    description:
      "Clone every remote declared in meta/natstack.yml whose unit is not yet present in the workspace, skipping already-present or unsupported paths; returns per-unit imported/skipped/failed results.",
    args: z.union([z.tuple([]), z.tuple([gitCompleteWorkspaceDependenciesSchema.optional()])]),
    returns: gitCompleteWorkspaceDependenciesResultSchema,
    access: COMPLETE_DEPENDENCIES_ACCESS,
    examples: [{ args: [] }],
  },
});
export type GitInteropMethods = typeof gitInteropMethods;
