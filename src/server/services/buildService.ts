import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { buildMethods } from "@natstack/shared/serviceSchemas/build";
import type { BuildSystemV2, BuildUnitOptions } from "../buildV2/index.js";
import { computeBuildKey } from "../buildV2/effectiveVersion.js";

export function createBuildService(deps: { buildSystem: BuildSystemV2 }): ServiceDefinition {
  return {
    name: "build",
    description: "Build system (getBuild, getBuildNpm, recompute, gc, getAboutPages)",
    policy: { allowed: ["panel", "app", "shell", "server", "worker", "do", "extension"] },
    methods: buildMethods,
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
        case "inspectBuildProvenance": {
          const source = args[0] as string;
          const graph = bs.getGraph();
          const exactNode =
            graph.tryGet(source) ??
            graph
              .allNodes()
              .find((candidate) => candidate.relativePath === source || candidate.path === source);
          const basenameMatches = exactNode
            ? []
            : graph
                .allNodes()
                .filter((candidate) => candidate.relativePath.split("/").slice(-1)[0] === source);
          const node = exactNode ?? (basenameMatches.length === 1 ? basenameMatches[0] : undefined);
          if (!node && basenameMatches.length > 1) {
            return {
              source,
              found: false,
              ambiguous: true,
              workspaceRoot: bs.getWorkspaceRoot(),
              candidates: basenameMatches.map((candidate) => ({
                name: candidate.name,
                kind: candidate.kind,
                relativePath: candidate.relativePath,
              })),
            };
          }
          if (!node) {
            return {
              source,
              found: false,
              workspaceRoot: bs.getWorkspaceRoot(),
            };
          }
          const effectiveVersion = bs.getEffectiveVersion(node.name);
          const buildKeys = effectiveVersion
            ? {
                sourcemap: computeBuildKey(node.name, effectiveVersion, true),
                production: computeBuildKey(node.name, effectiveVersion, false),
              }
            : { sourcemap: null, production: null };
          const cachedBuilds = Object.fromEntries(
            Object.entries(buildKeys).map(([kind, key]) => {
              const build = key ? bs.getBuildByKey(key) : null;
              return [
                kind,
                {
                  key,
                  cached: !!build,
                  artifactCount: build?.artifacts.length ?? 0,
                  metadata: build?.metadata ?? null,
                },
              ];
            })
          );
          return {
            source,
            found: true,
            workspaceRoot: bs.getWorkspaceRoot(),
            unit: {
              name: node.name,
              kind: node.kind,
              relativePath: node.relativePath,
              path: node.path,
            },
            effectiveVersion,
            buildKeys,
            cachedBuilds,
            recentBuildEvents: bs.listRecentBuildEvents(node.name),
          };
        }
        case "listRecentBuildEvents":
          return bs.listRecentBuildEvents(args[0] as string | undefined);
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
