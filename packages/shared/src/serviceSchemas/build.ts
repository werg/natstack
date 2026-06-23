/**
 * Wire schema for the server "build" service. Single source of truth for the
 * service's method table — the server attaches handlers to these schemas and
 * clients derive their call types from them.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the build method groups. `callers` is left
// unset so the service-level `policy` remains the enforced gate.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const BUILD_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const RECOMPUTE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const GC_ACCESS: MethodAccessDescriptor = {
  sensitivity: "destructive",
};

export const buildBundleResultSchema = z
  .object({
    bundle: z.string(),
  })
  .strict();
export type BuildBundleResult = z.infer<typeof buildBundleResultSchema>;

export const buildArtifactSchema = z
  .object({
    path: z.string(),
    role: z.enum(["primary", "asset", "html", "css", "map", "wasm"]),
    contentType: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    platform: z.string().optional(),
    integrity: z.string().optional(),
    content: z.string(),
  })
  .strict();

export const buildMetadataSchema = z
  .object({
    kind: z.enum(["panel", "package", "worker", "extension", "app", "template"]),
    name: z.string(),
    ev: z.string(),
    sourceStateHash: z.string().nullable(),
    sourcemap: z.boolean(),
    framework: z.string().optional(),
    details: z.object({ kind: z.string() }).passthrough(),
    builtAt: z.string(),
  })
  .strict();
export type BuildMetadataWire = z.infer<typeof buildMetadataSchema>;

export const buildResultSchema = z
  .object({
    dir: z.string(),
    sourceStateHash: z.string().nullable(),
    metadata: buildMetadataSchema,
    artifacts: z.array(buildArtifactSchema),
  })
  .strict();
export type BuildResultWire = z.infer<typeof buildResultSchema>;

export const buildChangeSetSchema = z
  .object({
    changed: z.array(z.string()),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strict();

export const aboutPageMetaSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string().optional(),
    hiddenInLauncher: z.boolean(),
  })
  .strict();

export const panelMetadataSchema = z
  .object({
    source: z.string(),
    title: z.string(),
    description: z.string().optional(),
    hiddenInLauncher: z.boolean(),
  })
  .strict();

const buildGraphUnitSchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    relativePath: z.string(),
    path: z.string().optional(),
  })
  .passthrough();

const cachedBuildSummarySchema = z
  .object({
    key: z.string().nullable(),
    cached: z.boolean(),
    artifactCount: z.number().int().nonnegative(),
    metadata: buildMetadataSchema.nullable(),
  })
  .strict();

export const buildProvenanceSchema = z
  .object({
    source: z.string(),
    found: z.boolean(),
    ambiguous: z.boolean().optional(),
    workspaceRoot: z.string(),
    candidates: z.array(buildGraphUnitSchema).optional(),
    unit: buildGraphUnitSchema.optional(),
    effectiveVersion: z.string().nullable().optional(),
    buildKeys: z
      .object({
        sourcemap: z.string().nullable(),
        production: z.string().nullable(),
      })
      .optional(),
    cachedBuilds: z.record(cachedBuildSummarySchema).optional(),
    recentBuildEvents: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const extensionDoctorReportSchema = z
  .object({
    name: z.string(),
    kind: z.literal("extension"),
    path: z.string(),
    dependencyDiagnostics: z.unknown(),
    buildMetadata: buildMetadataSchema.nullable(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["pass", "warn", "fail"]),
          message: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export const recentBuildEventSchema = z
  .object({
    type: z.enum(["build-started", "build-complete", "build-error"]),
    name: z.string(),
    relativePath: z.string().optional(),
    buildKey: z.string().optional(),
    error: z.string().optional(),
    trigger: z
      .object({
        head: z.string(),
        stateHash: z.string(),
        sinceStateHash: z.string().nullable(),
        eventId: z.string().nullable(),
        headHash: z.string().nullable(),
        actor: z.object({ id: z.string(), kind: z.string() }).nullable(),
        transitionKind: z.enum(["snapshot", "edit", "merge", "merge-resolution"]),
        changedPaths: z.array(z.string()),
        fileChanges: z.array(
          z.object({
            kind: z.enum(["added", "removed", "changed"]),
            path: z.string(),
            oldContentHash: z.string().nullable(),
            newContentHash: z.string().nullable(),
            oldMode: z.number().int().nullable(),
            newMode: z.number().int().nullable(),
          })
        ),
        editOps: z.array(
          z.object({
            kind: z.enum(["replace", "write", "create", "delete", "chmod"]),
            path: z.string(),
            oldContentHash: z.string().nullable(),
            newContentHash: z.string().nullable(),
            hunks: z.unknown().optional(),
            mode: z.number().int().nullable().optional(),
          })
        ),
        origin: z
          .object({
            callerId: z.string(),
            callerKind: z.string(),
            code: z.unknown().optional(),
          })
          .optional(),
      })
      .optional(),
    timestamp: z.string(),
  })
  .strict();

/**
 * Which execution environment will run a library bundle — selects the module
 * resolution conditions. `worker` covers any workerd isolate, including the eval
 * sandbox (a DO): it must NOT resolve a package's panel entry, whose top-level
 * `initRuntime()` crashes outside a panel. There is intentionally NO default —
 * every library build must state where its bundle will run, so a wrong host can't
 * be chosen silently.
 */
export const libraryBuildTargetSchema = z.enum(["panel", "worker"]);
export type LibraryBuildTarget = z.infer<typeof libraryBuildTargetSchema>;

export const buildMethods = defineServiceMethods({
  getBuild: {
    description:
      "Build a panel/worker/extension unit (or a library bundle) and return its artifacts. The optional ref selects the workspace state to build from: omitted = main HEAD, a head name (e.g. 'ctx:abc'), or an immutable 'state:…' hash. Results are cached by content-derived build key, so rebuilding an unchanged unit reuses the cache.",
    args: z.tuple([
      z.string().describe("Unit path or name to build (e.g. a panel source path)."),
      z
        .string()
        .optional()
        .describe(
          "Workspace state to build from: omitted = main HEAD, a head name, or a 'state:…' hash."
        ),
      z
        .object({
          library: z
            .boolean()
            .optional()
            .describe("Build a standalone library bundle instead of a panel/worker artifact set."),
          externals: z
            .array(z.string())
            .optional()
            .describe("Module specifiers to leave external (not bundled)."),
          libraryTarget: libraryBuildTargetSchema
            .optional()
            .describe(
              "Execution host for a library bundle ('panel' or 'worker'); required when library is true."
            ),
        })
        .refine((o) => !o.library || o.libraryTarget !== undefined, {
          message:
            "getBuild: a library build requires an explicit libraryTarget ('panel' or 'worker')",
        })
        .optional(),
    ]),
    returns: z.union([buildResultSchema, buildBundleResultSchema]),
    access: BUILD_ACCESS,
  },
  getBuildNpm: {
    description:
      "Build an npm package as a CJS library bundle for sandbox use, leaving the given externals unbundled.",
    args: z.tuple([
      z.string().describe("npm package specifier to bundle."),
      z.string().describe("Exact package version to resolve and build."),
      z.array(z.string()).optional().describe("Module specifiers to leave external (not bundled)."),
    ]),
    returns: buildBundleResultSchema,
    access: BUILD_ACCESS,
  },
  getBuildMetadata: {
    description: "Cached build metadata for an immutable build key, or null if it is not cached.",
    args: z.tuple([z.string()]),
    returns: buildMetadataSchema.nullable(),
    access: READ_ACCESS,
  },
  getEffectiveVersion: {
    description:
      "Effective version (content-derived identity) of a workspace unit, or null if unknown.",
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  inspectBuildProvenance: {
    description:
      "Resolve a workspace build unit (by name, relative path, or basename) and report its effective version, immutable build keys, and cached artifact metadata. Reports ambiguity when a basename matches multiple units.",
    args: z.tuple([z.string()]),
    returns: buildProvenanceSchema,
    access: READ_ACCESS,
  },
  listRecentBuildEvents: {
    description:
      "List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path.",
    args: z.tuple([z.string().optional()]),
    returns: z.array(recentBuildEventSchema),
    access: READ_ACCESS,
  },
  doctorExtension: {
    description:
      "Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status.",
    args: z.tuple([z.string()]),
    returns: extensionDoctorReportSchema,
    access: { sensitivity: "read" },
  },
  recompute: {
    description:
      "Rediscover the package graph, recompute every unit's effective version, rebuild any changed buildable units, and return the set of changed/added/removed units.",
    args: z.tuple([]),
    returns: buildChangeSetSchema,
    access: RECOMPUTE_ACCESS,
  },
  gc: {
    description:
      "Garbage-collect cached build artifacts not referenced by the given active units; returns the number of artifacts freed.",
    args: z.tuple([z.array(z.string())]),
    returns: z.object({ freed: z.number() }).strict(),
    access: GC_ACCESS,
    examples: [{ args: [[]], returns: { freed: 0 } }],
  },
  getAboutPages: {
    description: "List available about pages for the launcher UI.",
    args: z.tuple([]),
    returns: z.array(aboutPageMetaSchema),
    access: READ_ACCESS,
  },
  hasUnit: {
    description: "Whether a build unit with this name exists in the workspace graph.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    access: READ_ACCESS,
  },
  getPanelMetadata: {
    description:
      "Launcher metadata (source path, title, description, launcher visibility) for a panel unit, or null if the name is absent or not a panel.",
    args: z.tuple([z.string()]),
    returns: panelMetadataSchema.nullable(),
    access: READ_ACCESS,
  },
  listSkills: {
    description:
      "List available workspace skill packages that can be loaded via the eval imports parameter.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        description: z.string().optional(),
      })
    ),
    access: READ_ACCESS,
  },
});
