import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { FsService } from "../../shared/fsService.js";
import { handleFsCall } from "../../shared/fsService.js";

export function createFsServiceDefinition(deps: {
  fsService: FsService;
}): ServiceDefinition {
  return {
    name: "fs",
    description: "Per-context filesystem operations (sandboxed to context folder)",
    policy: { allowed: ["panel", "server", "worker"] },
    methods: {
      readFile: { args: z.tuple([z.string()]).rest(z.unknown()) },
      writeFile: { args: z.tuple([z.string()]).rest(z.unknown()) },
      readdir: { args: z.tuple([z.string()]).rest(z.unknown()) },
      mkdir: { args: z.tuple([z.string()]).rest(z.unknown()) },
      stat: { args: z.tuple([z.string()]).rest(z.unknown()) },
      open: { args: z.tuple([z.string()]).rest(z.unknown()) },
      close: { args: z.tuple([z.string()]).rest(z.unknown()) },
      read: { args: z.tuple([z.string()]).rest(z.unknown()) },
      write: { args: z.tuple([z.string()]).rest(z.unknown()) },
    },
    handler: async (ctx, method, args) => {
      return handleFsCall(deps.fsService, ctx, method, args as unknown[]);
    },
  };
}
