import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { BuildSystemV2, BuildUnitOptions } from "../buildV2/index.js";

export function createBuildService(deps: { buildSystem: BuildSystemV2 }): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)",
    policy: { allowed: ["panel", "app", "shell", "server", "worker", "do", "extension"] },
    methods: {
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
      },
      getBuildNpm: {
        args: z.tuple([z.string(), z.string(), z.array(z.string()).optional()]),
      },
      getBuildMetadata: { args: z.tuple([z.string()]) },
      getEffectiveVersion: { args: z.tuple([z.string()]) },
      doctorExtension: {
        description:
          "Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status.",
        args: z.tuple([z.string()]),
      },
      recompute: { args: z.tuple([]) },
      gc: { args: z.tuple([z.array(z.string())]) },
      getAboutPages: { args: z.tuple([]) },
      hasUnit: { args: z.tuple([z.string()]) },
      getPanelMetadata: { args: z.tuple([z.string()]) },
      listSkills: {
        description:
          "List available workspace skill packages that can be loaded via the eval imports parameter.",
        args: z.tuple([]),
      },
    },
    handler: async (_ctx, method, args) => {
      const bs = deps.buildSystem;
      switch (method) {
        case "getBuild": {
          const options = args[2] as BuildUnitOptions | undefined;
          return options?.library
            ? bs.getBuild(args[0] as string, args[1] as string | undefined, {
                ...options,
                library: true,
              })
            : bs.getBuild(args[0] as string, args[1] as string | undefined, {
                ...options,
                library: false,
              });
        }
        case "getBuildNpm":
          return bs.getBuildNpm(
            args[0] as string,
            args[1] as string,
            args[2] as string[] | undefined
          );
        case "getBuildMetadata":
          return bs.getBuildByKey(args[0] as string)?.metadata ?? null;
        case "getEffectiveVersion":
          return bs.getEffectiveVersion(args[0] as string);
        case "doctorExtension":
          return bs.doctorExtension(args[0] as string);
        case "recompute":
          return bs.recompute();
        case "gc":
          return bs.gc(args[0] as string[]);
        case "getAboutPages":
          return bs.getAboutPages();
        case "hasUnit":
          return bs.hasUnit(args[0] as string);
        case "getPanelMetadata": {
          const node = bs.getGraph().tryGet(args[0] as string);
          if (!node || node.kind !== "panel") return null;
          return {
            source: node.relativePath,
            title: node.manifest.title ?? node.name,
            description: node.manifest.description,
            hiddenInLauncher: node.manifest.hiddenInLauncher ?? false,
          };
        }
        case "listSkills":
          return bs
            .getGraph()
            .allNodes()
            .filter((n) => n.name.startsWith("@workspace-skills/"))
            .map((n) => ({
              name: n.name,
              path: n.relativePath,
              description: n.manifest.description,
            }));
        default:
          throw new Error(`Unknown build method: ${method}`);
      }
    },
  };
}
