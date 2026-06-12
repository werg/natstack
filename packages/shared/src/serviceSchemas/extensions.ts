/**
 * Wire schema for the "extensions" management/invocation service
 * (served by packages/extension-host).
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const extensionRegistryEntrySchema = z
  .object({
    unitKind: z.literal("extension"),
    name: z.string(),
    version: z.string(),
    source: z
      .object({
        kind: z.literal("internal-git"),
        repo: z.string(),
        ref: z.string(),
      })
      .strict(),
    installedAt: z.number(),
    activeEv: z.string().nullable(),
    activeSha: z.string().nullable(),
    activeBundleKey: z.string().nullable(),
    activeDependencyEvs: z.record(z.string()),
    activeExternalDeps: z.record(z.string()),
    activeRuntimeDepsKey: z.string().nullable(),
    status: z.enum(["running", "available", "stopped", "error", "pending-approval", "building"]),
    lastError: z.string().nullable(),
  })
  .strict();

export const binaryEnvelopeSchema = z
  .object({
    __bin: z.literal(true),
    data: z.string(),
  })
  .strict();

export const streamChunkEnvelopeSchema = z
  .object({
    done: z.boolean(),
    chunk: binaryEnvelopeSchema.optional(),
  })
  .strict();

export const extensionsMethods = defineServiceMethods({
  invoke: { args: z.tuple([z.string(), z.string(), z.array(z.unknown())]), returns: z.unknown() },
  invokeStream: { args: z.tuple([z.string(), z.string(), z.array(z.unknown())]) },
  // Nullable to match the historical client contract (older hosts may answer
  // null for unknown extensions); the current host always returns an array.
  streamingMethods: { args: z.tuple([z.string()]), returns: z.array(z.string()).nullable() },
  list: { args: z.tuple([]), returns: z.array(extensionRegistryEntrySchema) },
  on: { args: z.tuple([z.string(), z.string()]), returns: z.null() },
  ready: {
    args: z.tuple([z.object({ methods: z.array(z.string()), hasFetch: z.boolean() })]),
    returns: z.null(),
  },
  emit: { args: z.tuple([z.string(), z.unknown()]), returns: z.null() },
  fetchRequestBodyChunk: { args: z.tuple([z.string()]), returns: streamChunkEnvelopeSchema },
  fetchRequestBodyClose: { args: z.tuple([z.string()]), returns: z.null() },
  health: {
    args: z.tuple([z.enum(["healthy", "degraded", "unhealthy"]), z.unknown().optional()]),
    returns: z.null(),
  },
  log: {
    args: z.tuple([
      z.enum(["debug", "info", "warn", "error"]),
      z.string(),
      z.record(z.unknown()).optional(),
    ]),
    returns: z.null(),
  },
  reload: { args: z.tuple([z.string()]), returns: z.void() },
});
