import type { PackageManifest } from "@natstack/shared/types";
import type { BuildSystemV2 } from "./buildV2/index.js";
import type { DORef } from "./doDispatch.js";

export interface UserlandServiceResolution {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
}

export interface DurableObjectServiceResolution extends UserlandServiceResolution {
  kind: "durable-object";
  className: string;
  objectKey: string;
  targetId: string;
}

export interface WorkerServiceResolution extends UserlandServiceResolution {
  kind: "worker";
  routePath: string;
  routeBasePath: string;
}

export type ResolvedUserlandService = DurableObjectServiceResolution | WorkerServiceResolution;

export function resolveUserlandService(
  buildSystem: Pick<BuildSystemV2, "getGraph">,
  query: string,
  objectKey?: string | null,
): ResolvedUserlandService {
  for (const node of buildSystem.getGraph().allNodes()) {
    if (node.kind !== "worker") continue;
    const manifest = node.manifest as PackageManifest;
    for (const service of manifest.services ?? []) {
      const protocols = service.protocols ?? [];
      if (service.name !== query && !protocols.includes(query)) continue;
      const source = node.relativePath;
      if ("durableObject" in service && service.durableObject) {
        const resolvedObjectKey = objectKey ?? service.durableObject.objectKey ?? service.name;
        const className = service.durableObject.className;
        return {
          kind: "durable-object",
          name: service.name,
          title: service.title,
          description: service.description,
          protocols,
          source,
          className,
          objectKey: resolvedObjectKey,
          targetId: `do:${source}:${className}:${resolvedObjectKey}`,
        };
      }
      if ("worker" in service && service.worker) {
        const routePath = normalizeRoutePath(service.worker.routePath);
        const hasRoute = (manifest.routes ?? []).some((route) =>
          !route.durableObject && normalizeRoutePath(route.path) === routePath
        );
        if (!hasRoute) {
          throw new Error(
            `Userland service ${service.name} references stateless worker route ${routePath}, but that route is not declared`,
          );
        }
        return {
          kind: "worker",
          name: service.name,
          title: service.title,
          description: service.description,
          protocols,
          source,
          routePath,
          routeBasePath: `/_r/w/${source}${routePath === "/" ? "" : routePath}`,
        };
      }
    }
  }
  throw new Error(`No userland service registered for ${query}`);
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed.replace(/\/+$/u, "") : `/${trimmed.replace(/\/+$/u, "")}`;
}

export function toDORef(resolution: ResolvedUserlandService): DORef {
  if (resolution.kind !== "durable-object") {
    throw new Error(`Userland service ${resolution.name} is not Durable Object-backed`);
  }
  return {
    source: resolution.source,
    className: resolution.className,
    objectKey: resolution.objectKey,
  };
}
