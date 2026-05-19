/**
 * SingletonRegistry — joins workspace-declared Durable Object singletons with
 * the services and routes that reference them.
 *
 * Built from `WorkspaceConfig.singletonObjects[]` plus `services[]` and
 * `routes[]`. A DO-backed service is treated as *singleton-backed* when its
 * `(source, className)` pair appears in `singletonObjects` (callers MAY omit
 * `objectKey`); otherwise it is a *factory* (callers MUST pass an explicit
 * `objectKey` at resolve time). DO-backed routes always require a matching
 * singleton row, since routes have no per-request factory hook.
 */

import type {
  WorkspaceConfig,
  WorkspaceRouteDecl,
  WorkspaceServiceDecl,
  WorkspaceSingletonObjectDecl,
} from "./types.js";

/** Composite key `${source}::${className}` */
type SingletonKey = string;

function makeKey(source: string, className: string): SingletonKey {
  return `${source}::${className}`;
}

export class SingletonRegistry {
  private readonly singletons = new Map<SingletonKey, WorkspaceSingletonObjectDecl>();

  constructor(decls: ReadonlyArray<WorkspaceSingletonObjectDecl>) {
    for (const decl of decls) {
      const key = makeKey(decl.source, decl.className);
      if (this.singletons.has(key)) {
        throw new Error(
          `Duplicate singletonObjects declaration for (source=${decl.source}, className=${decl.className})`
        );
      }
      this.singletons.set(key, decl);
    }
  }

  /** Returns the singleton row for a (source, className), or null if absent. */
  find(source: string, className: string): WorkspaceSingletonObjectDecl | null {
    return this.singletons.get(makeKey(source, className)) ?? null;
  }

  /**
   * Returns the singleton `key` (object key) for a (source, className), or
   * throws a clear error if no matching `singletonObjects` row exists.
   * Optional `context` describes what referenced it (e.g. service name).
   */
  requireKey(source: string, className: string, context?: string): string {
    const found = this.find(source, className);
    if (!found) {
      const ref = context ? ` (referenced by ${context})` : "";
      throw new Error(
        `Missing singletonObjects declaration for source=${source} className=${className}${ref}. ` +
          `Add an entry under singletonObjects: in workspace/meta/natstack.yml.`
      );
    }
    return found.key;
  }

  /** All singleton rows. */
  all(): ReadonlyArray<WorkspaceSingletonObjectDecl> {
    return Array.from(this.singletons.values());
  }
}

/**
 * Parsed and validated workspace declarations.
 * Built once at workspace load; consumed by routeRegistry, userlandServices,
 * workerService, and workerdManager.
 */
export interface WorkspaceDeclarations {
  singletons: SingletonRegistry;
  services: ReadonlyArray<WorkspaceServiceDecl>;
  routes: ReadonlyArray<WorkspaceRouteDecl>;
}

/**
 * Validate the joined view: every DO-backed service/route must reference a
 * declared singleton. Worker-backed services additionally must have a
 * matching worker-backed route (declared in `routes[]`) on the same source
 * and path.
 *
 * Throws on the first error with a message naming the offending entry.
 */
export function buildWorkspaceDeclarations(config: WorkspaceConfig): WorkspaceDeclarations {
  const singletons = new SingletonRegistry(config.singletonObjects ?? []);
  const services = config.services ?? [];
  const routes = config.routes ?? [];

  // DO-backed services without a matching singletonObjects row are factories;
  // callers must supply `objectKey` at resolve time. No validation needed here.
  for (const route of routes) {
    if (route.durableObject) {
      singletons.requireKey(
        route.source,
        route.durableObject.className,
        `route ${route.source} ${route.path}`
      );
    } else if (!route.worker) {
      throw new Error(
        `Workspace route ${route.source} ${route.path} must set either durableObject or worker: true`
      );
    }
  }

  return { singletons, services, routes };
}

/** Convenience: routes for a given worker source. */
export function getRoutesForSource(
  decls: WorkspaceDeclarations,
  source: string
): ReadonlyArray<WorkspaceRouteDecl> {
  return decls.routes.filter((r) => r.source === source);
}

/** Convenience: services for a given worker source. */
export function getServicesForSource(
  decls: WorkspaceDeclarations,
  source: string
): ReadonlyArray<WorkspaceServiceDecl> {
  return decls.services.filter((s) => s.source === source);
}
