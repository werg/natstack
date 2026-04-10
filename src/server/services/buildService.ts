import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { BuildSystemV2, BuildUnitOptions } from "../buildV2/index.js";

export function createBuildService(deps: {
  buildSystem: BuildSystemV2;
}): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)",
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
      getBuildNpm: {
        args: z.tuple([
          z.string(),
          z.string(),
          z.array(z.string()).optional(),
        ]),
      },
      getEffectiveVersion: { args: z.tuple([z.string()]) },
      recompute: { args: z.tuple([]) },
      gc: { args: z.tuple([z.array(z.string())]) },
      getAboutPages: { args: z.tuple([]) },
      hasUnit: { args: z.tuple([z.string()]) },
      listSkills: {
        description: "List available workspace skill packages that can be loaded via the eval imports parameter.",
        args: z.tuple([]),
      },
    },
    handler: async (_ctx, method, args) => {
      const bs = deps.buildSystem;
      switch (method) {
        case "getBuild": return bs.getBuild(
          args[0] as string,
          args[1] as string | undefined,
          args[2] as BuildUnitOptions | undefined,
        );
        case "getBuildNpm": return bs.getBuildNpm(
          args[0] as string,
          args[1] as string,
          args[2] as string[] | undefined,
        );
        case "getEffectiveVersion": return bs.getEffectiveVersion(args[0] as string);
        case "recompute": return bs.recompute();
        case "gc": return bs.gc(args[0] as string[]);
        case "getAboutPages": return bs.getAboutPages();
        case "hasUnit": return bs.hasUnit(args[0] as string);
        case "listSkills": return bs.getGraph().allNodes()
          .filter(n => n.name.startsWith("@workspace-skills/"))
          .map(n => ({ name: n.name, path: n.relativePath, description: n.manifest.description }));
        default: throw new Error(`Unknown build method: ${method}`);
      }
    },
  };
}
