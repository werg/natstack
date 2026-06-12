/**
 * scope service method schemas — REPL scope persistence backed by an internal
 * Durable Object. Pure-data wire contract shared by the server registration
 * and typed clients.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const scopeEntrySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  panelId: z.string(),
  data: z.string(),
  serializedKeys: z.array(z.string()),
  droppedPaths: z.array(z.object({ path: z.string(), reason: z.string() })),
  partialKeys: z.array(z.string()),
  createdAt: z.number(),
});

/** List projection of a scope entry (ScopeStoreDO.list / ScopeListEntry). */
export const scopeListEntrySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  keys: z.array(z.string()),
  partial: z.array(z.string()),
});

export const scopeMethods = defineServiceMethods({
  upsert: { args: z.tuple([scopeEntrySchema]), returns: z.void() },
  loadCurrent: { args: z.tuple([z.string(), z.string()]), returns: scopeEntrySchema.nullable() },
  get: { args: z.tuple([z.string()]), returns: scopeEntrySchema.nullable() },
  list: { args: z.tuple([z.string()]), returns: z.array(scopeListEntrySchema) },
});
