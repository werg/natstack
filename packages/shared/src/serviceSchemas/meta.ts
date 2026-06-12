/**
 * Wire schema for the server "meta" introspection service.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

const callerKindSchema = z.string();

const serializedPolicySchema = z.object({
  allowed: z.array(callerKindSchema),
  description: z.string().optional(),
});

/** Wire shape of one serialized method in meta.listServices/describeService. */
export const serializedServiceMethodSchema = z.object({
  description: z.string().optional(),
  policy: serializedPolicySchema.optional(),
  argsSchema: z.record(z.unknown()),
  returnsSchema: z.record(z.unknown()).optional(),
});

/** Wire shape of one serialized service definition. */
export const serializedServiceSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  policy: serializedPolicySchema,
  methods: z.record(serializedServiceMethodSchema),
});

export const runtimeSurfaceEntrySchema = z.object({
  kind: z.enum(["value", "namespace"]),
  description: z.string().optional(),
  members: z.array(z.string()).optional(),
});

export const runtimeSurfaceSchema = z.object({
  target: z.enum(["panel", "workerRuntime"]),
  description: z.string(),
  exports: z.record(runtimeSurfaceEntrySchema),
});

export const metaMethods = defineServiceMethods({
  listServices: {
    description: "List all registered RPC services and their method metadata.",
    args: z.tuple([]),
    returns: z.array(serializedServiceSchema),
  },
  describeService: {
    description: "Describe one registered RPC service by name.",
    args: z.tuple([z.string()]),
    returns: serializedServiceSchema,
  },
  getRuntimeSurface: {
    description: "Return the live eval runtime surface manifest for the requested target.",
    args: z.tuple([z.enum(["panel", "workerRuntime"])]),
    returns: runtimeSurfaceSchema,
  },
});
