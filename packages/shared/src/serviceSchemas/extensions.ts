/**
 * Wire schema for the "extensions" management/invocation service
 * (served by packages/extension-host).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the read/write/admin method groups. We leave
// `callers` unset here so the legacy `policy` on each method remains the gate;
// `sensitivity` adds doc/safety metadata.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const INVOKE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const EXTENSION_REPORT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const STREAM_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const ADMIN_RELOAD_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const extensionRegistryEntrySchema = z
  .object({
    unitKind: z.literal("extension"),
    name: z.string(),
    version: z.string(),
    source: z
      .object({
        kind: z.literal("workspace-repo"),
        repo: z.string(),
        ref: z.string(),
      })
      .strict(),
    installedAt: z.number(),
    activeEv: z.string().nullable(),
    activeSourceHash: z.string().nullable(),
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
  invoke: {
    description:
      "Invoke a method on a running installed extension and await its result. Throws if the extension is not installed or not running.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    returns: z.unknown(),
    access: INVOKE_ACCESS,
    examples: [{ args: ["shell", "exec", [{ command: "echo hi" }]] }],
  },
  // invokeStream intentionally declares no return schema: the result is a raw
  // streaming Response, not a wire-serializable value.
  invokeStream: {
    description:
      "Invoke a streaming method on a running extension; the host proxies the extension's byte stream back as the response. Throws if the extension is not installed/running or lacks a streaming transport.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    access: INVOKE_ACCESS,
  },
  // Nullable to match the historical client contract (older hosts may answer
  // null for unknown extensions); the current host always returns an array.
  streamingMethods: {
    description:
      "List the method names an extension's manifest declares as streaming, so callers route them through invokeStream. Unknown extensions return an empty list.",
    args: z.tuple([z.string()]),
    returns: z.array(z.string()).nullable(),
    access: READ_ACCESS,
    examples: [{ args: ["shell"] }],
  },
  list: {
    description: "List all installed extensions with their registry/runtime status.",
    args: z.tuple([]),
    returns: z.array(extensionRegistryEntrySchema),
    access: READ_ACCESS,
  },
  on: {
    description:
      "Subscribe the calling connection to a named event emitted by the given extension; events arrive over the caller's event channel.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
    examples: [{ args: ["shell", "portDetected"] }],
  },
  ready: {
    description:
      "Extension-only: signal that the child process has finished startup and is ready to serve, declaring its callable methods and whether it handles fetch.",
    args: z.tuple([
      z.object({
        methods: z.array(z.string()).describe("Method names the extension exposes for invoke."),
        hasFetch: z
          .boolean()
          .describe("Whether the extension handles HTTP fetch requests routed to it."),
      }),
    ]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
    examples: [{ args: [{ methods: ["exec"], hasFetch: false }] }],
  },
  emit: {
    description:
      "Extension-only: emit a named event (with payload) to subscribers of this extension. Rejected for non-extension callers.",
    args: z.tuple([z.string(), z.unknown()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  fetchRequestBodyChunk: {
    description:
      "Extension-only: pull the next chunk of a proxied HTTP request body stream by stream id (advances the stream cursor).",
    args: z.tuple([z.string()]),
    returns: streamChunkEnvelopeSchema,
    access: STREAM_ACCESS,
  },
  fetchRequestBodyClose: {
    description:
      "Extension-only: close and release a proxied HTTP request body stream by id. No-op if the stream is already gone.",
    args: z.tuple([z.string()]),
    returns: z.null(),
    access: STREAM_ACCESS,
  },
  health: {
    description:
      "Extension-only: report the extension's current health state with optional summary/reasons/retry detail.",
    args: z.tuple([z.enum(["healthy", "degraded", "unhealthy"]), z.unknown().optional()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  log: {
    description: "Extension-only: write a structured log record (level, message, optional fields).",
    args: z.tuple([
      z.enum(["debug", "info", "warn", "error"]),
      z.string(),
      z.record(z.unknown()).optional(),
    ]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  reload: {
    description:
      "Rebuild and restart an extension from its active approved build. Approval-gated for panel/app/worker/do callers; shell callers are pre-authorized.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: ADMIN_RELOAD_ACCESS,
    examples: [{ args: ["shell"] }],
  },
});
