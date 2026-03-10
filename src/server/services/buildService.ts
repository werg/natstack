import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { BuildSystemV2, BuildUnitOptions } from "../buildV2/index.js";

export function createBuildService(deps: {
  buildSystem: BuildSystemV2;
}): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, recompute, gc, getAboutPages)",
    policy: { allowed: ["panel", "shell", "server", "worker"] },
    methods: {
      getBuild: {
        args: z.tuple([
          z.string(),
          z.string().optional(),
          z.object({
            library: z.boolean().optional(),
            externals: z.array(z.string()).optional(),
          }).optional(),
        ]),
      },
      getEffectiveVersion: { args: z.tuple([z.string()]) },
      recompute: { args: z.tuple([]) },
      gc: { args: z.tuple([z.array(z.string())]) },
      getAboutPages: { args: z.tuple([]) },
      hasUnit: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      const bs = deps.buildSystem;
      switch (method) {
        case "getBuild": return bs.getBuild(
          args[0] as string,
          args[1] as string | undefined,
          args[2] as BuildUnitOptions | undefined,
        );
        case "getEffectiveVersion": return bs.getEffectiveVersion(args[0] as string);
        case "recompute": return bs.recompute();
        case "gc": return bs.gc(args[0] as string[]);
        case "getAboutPages": return bs.getAboutPages();
        case "hasUnit": return bs.hasUnit(args[0] as string);
        default: throw new Error(`Unknown build method: ${method}`);
      }
    },
  };
}
