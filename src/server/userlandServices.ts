import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { DORefParam } from "@natstack/shared/userlandServiceRpc";
import type {
  WorkspaceDeclarations,
  SingletonRegistry,
} from "@natstack/shared/workspace/singletonRegistry";
import type { WorkspaceServiceDecl } from "@natstack/shared/workspace/types";

export interface UserlandServicePolicy {
  allowed?: CallerKind[];
}

export interface UserlandServiceResolution {
  name: string;
  title?: string;
  description?: string;
  protocols: string[];
  source: string;
  policy?: UserlandServicePolicy;
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

/**
 * Resolve a userland service by name or protocol against the workspace's
 * parsed declarations.
 *
 * For DO-backed services:
 * - If a matching `singletonObjects` row exists, the service is
 *   singleton-backed: `objectKey` is sourced from that row, and callers MAY
 *   override it for fan-out targets (e.g. forked channels).
 * - Otherwise the service is a factory: callers MUST pass an explicit
 *   `objectKey`. Resolving without one throws.
 */
export function resolveUserlandService(
  decls: WorkspaceDeclarations,
  query: string,
  objectKey?: string | null
): ResolvedUserlandService {
  for (const service of decls.services) {
    const protocols = service.protocols ?? [];
    if (service.name !== query && !protocols.includes(query)) continue;
    return buildResolution(service, decls.singletons, objectKey ?? null, decls.routes);
  }
  throw new Error(`No userland service registered for ${query}`);
}

function buildResolution(
  service: WorkspaceServiceDecl,
  singletons: SingletonRegistry,
  overrideObjectKey: string | null,
  routes: WorkspaceDeclarations["routes"]
): ResolvedUserlandService {
  const protocols = service.protocols ?? [];
  const policy = service.policy as UserlandServicePolicy | undefined;
  const source = service.source;

  if (service.durableObject) {
    const className = service.durableObject.className;
    const singletonKey = singletons.find(source, className)?.key ?? null;
    const resolvedObjectKey = overrideObjectKey ?? singletonKey;
    if (resolvedObjectKey === null) {
      throw new Error(
        `Userland service "${service.name}" is a factory (no singletonObjects row for ` +
          `source=${source} className=${className}); resolveService requires an explicit objectKey.`
      );
    }
    return {
      kind: "durable-object",
      name: service.name,
      title: service.title,
      description: service.description,
      protocols,
      source,
      policy,
      className,
      objectKey: resolvedObjectKey,
      targetId: `do:${source}:${className}:${resolvedObjectKey}`,
    };
  }

  // worker-backed
  const routePath = normalizeRoutePath(service.worker.routePath);
  const hasRoute = routes.some(
    (route) =>
      route.source === source &&
      route.worker === true &&
      normalizeRoutePath(route.path) === routePath
  );
  if (!hasRoute) {
    throw new Error(
      `Userland service ${service.name} references stateless worker route ${routePath}, but that route is not declared`
    );
  }
  return {
    kind: "worker",
    name: service.name,
    title: service.title,
    description: service.description,
    protocols,
    source,
    policy,
    routePath,
    routeBasePath: `/_r/w/${source}${routePath === "/" ? "" : routePath}`,
  };
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/")
    ? trimmed.replace(/\/+$/u, "")
    : `/${trimmed.replace(/\/+$/u, "")}`;
}

export function toDORef(resolution: ResolvedUserlandService): DORefParam {
  if (resolution.kind !== "durable-object") {
    throw new Error(`Userland service ${resolution.name} is not Durable Object-backed`);
  }
  return {
    source: resolution.source,
    className: resolution.className,
    objectKey: resolution.objectKey,
  };
}
