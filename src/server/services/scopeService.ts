import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

const scopeEntrySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  panelId: z.string(),
  data: z.string(),
  serializedKeys: z.array(z.string()),
  droppedPaths: z.array(z.object({ path: z.string(), reason: z.string() })),
  partialKeys: z.array(z.string()),
  createdAt: z.number(),
});

export function createScopeService(deps: { doDispatch: DODispatch }): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: "ScopeStoreDO",
    objectKey: "global",
  };

  return {
    name: "scope",
    description: "REPL scope persistence backed by an internal Durable Object",
    policy: { allowed: ["panel", "worker", "shell", "server"] },
    methods: {
      upsert: { args: z.tuple([scopeEntrySchema]) },
      loadCurrent: { args: z.tuple([z.string(), z.string()]) },
      get: { args: z.tuple([z.string()]) },
      list: { args: z.tuple([z.string()]) },
    },
    handler: (_ctx, method, args) => deps.doDispatch.dispatch(ref, method, ...args),
  };
}

