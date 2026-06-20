/**
 * Wire schema for the server "runtime" entity lifecycle service.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const RuntimeEntityHandleSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["panel", "app", "worker", "do", "session"]),
    source: z
      .object({
        repoPath: z.string(),
        effectiveVersion: z.string(),
      })
      .strict(),
    contextId: z.string(),
    targetId: z.string(),
  })
  .strict();

export const CreateEntitySpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("panel"),
    source: z.string(),
    ref: z.string().optional(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    stateArgs: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("app"),
    source: z.string(),
    ref: z.string().optional(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    stateArgs: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("worker"),
    source: z.string(),
    ref: z.string().optional(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    stateArgs: z.unknown().optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("do"),
    source: z.string(),
    ref: z.string().optional(),
    className: z.string(),
    key: z.string().optional(),
    contextId: z.string().nullable().optional(),
    stateArgs: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("session"),
    source: z.string(),
    contextId: z.string().nullable().optional(),
    key: z.string().optional(),
    title: z.string().optional(),
  }),
]);

export const runtimeMethods = defineServiceMethods({
  createEntity: {
    args: z.tuple([CreateEntitySpecSchema]),
    returns: RuntimeEntityHandleSchema,
    description: "Create a runtime entity (panel, worker, or DO).",
  },
  retireEntity: {
    args: z.tuple([z.object({ id: z.string(), removeContext: z.boolean().optional() })]),
    returns: z.void(),
    description:
      "Retire a single entity, firing cleanup hooks. With removeContext, also delete the context folder when no other live entity shares the context.",
  },
  listEntities: {
    args: z.tuple([
      z.object({ kind: z.enum(["panel", "app", "worker", "do", "session"]).optional() }),
    ]),
    description: "List live entities (id, kind, source, contextId, title, createdAt).",
    returns: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        source: z.string(),
        contextId: z.string(),
        title: z.string().optional(),
        createdAt: z.number(),
      })
    ),
  },
  resolveContext: {
    args: z.tuple([z.string()]),
    description:
      "Return the contextId for an entity (or null if unknown). Cached read; falls back to DO.",
    returns: z.string().nullable(),
  },
  setTitle: {
    args: z.tuple([
      z.string().nullable(),
      z.object({ explicit: z.boolean().optional() }).optional(),
    ]),
    returns: z.void(),
    description:
      "Set a server-controlled display title for the calling entity. Surfaced by approval UIs in place of the opaque id. Pass null/empty to clear.",
  },
});
