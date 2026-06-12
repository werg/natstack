/**
 * Wire schema for the server "build" service. Single source of truth for the
 * service's method table — the server attaches handlers to these schemas and
 * clients derive their call types from them.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

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
        repo: z.string(),
        branch: z.string(),
        commit: z.string(),
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

export const buildMethods = defineServiceMethods({
  getBuild: {
    args: z.tuple([
      z.string(),
      z.string().optional(),
      z
        .object({
          library: z.boolean().optional(),
          externals: z.array(z.string()).optional(),
        })
        .optional(),
    ]),
    returns: z.union([buildResultSchema, buildBundleResultSchema]),
  },
  getBuildNpm: {
    args: z.tuple([z.string(), z.string(), z.array(z.string()).optional()]),
    returns: buildBundleResultSchema,
  },
  getBuildMetadata: { args: z.tuple([z.string()]), returns: buildMetadataSchema.nullable() },
  getEffectiveVersion: {
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
  },
  inspectBuildProvenance: {
    description:
      "Resolve a workspace build unit and report its effective version, immutable build keys, and cached artifact metadata.",
    args: z.tuple([z.string()]),
    returns: buildProvenanceSchema,
  },
  listRecentBuildEvents: {
    description:
      "List recent push-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path.",
    args: z.tuple([z.string().optional()]),
    returns: z.array(recentBuildEventSchema),
  },
  doctorExtension: {
    description:
      "Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status.",
    args: z.tuple([z.string()]),
    returns: extensionDoctorReportSchema,
  },
  recompute: { args: z.tuple([]), returns: buildChangeSetSchema },
  gc: { args: z.tuple([z.array(z.string())]), returns: z.object({ freed: z.number() }).strict() },
  getAboutPages: { args: z.tuple([]), returns: z.array(aboutPageMetaSchema) },
  hasUnit: { args: z.tuple([z.string()]), returns: z.boolean() },
  getPanelMetadata: { args: z.tuple([z.string()]), returns: panelMetadataSchema.nullable() },
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
  },
});
