/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - listServices / resolveService: manifest-declared userland services
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { CallerKind } from "@natstack/shared/serviceDispatcher";
import type { WorkspaceDeclarations } from "@natstack/shared/workspace/singletonRegistry";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { resolveUserlandService } from "../userlandServices.js";
import { assertPresent } from "../../lintHelpers";
import { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";

export function createWorkerService(deps: {
  buildSystem: BuildSystemV2;
  workspaceDecls: WorkspaceDeclarations;
  activateDurableObject?: (args: {
    source: string;
    className: string;
    objectKey: string;
  }) => Promise<void>;
}): ServiceDefinition {
  const { buildSystem, workspaceDecls } = deps;

  return {
    name: "workers",
    description: "Worker discovery and userland service resolution",
    policy: { allowed: ["shell", "server", "panel", "app", "worker", "do", "extension"] },
    methods: {
      listSources: {
        description: "List available worker sources with durable object classes",
        args: z.tuple([]),
      },
      listServices: {
        description: "List manifest-declared userland services",
        args: z.tuple([]),
      },
      resolveService: {
        description: "Resolve a userland service by name or protocol",
        args: z.tuple([z.string(), z.string().nullable().optional()]),
      },
      resolveDurableObject: {
        description: "Resolve a Durable Object RPC target by source/class/key",
        args: z.tuple([z.string(), z.string(), z.string()]),
      },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "listSources": {
          const graph = buildSystem.getGraph();
          return graph
            .allNodes()
            .filter(
              (n) =>
                n.kind === "worker" && n.manifest.durable && n.manifest.durable.classes.length > 0
            )
            .map((n) => ({
              name: n.name,
              source: n.relativePath,
              title: n.manifest.title,
              classes: assertPresent(n.manifest.durable).classes,
            }));
        }

        case "listServices": {
          return workspaceDecls.services.map((service) => {
            const base = {
              name: service.name,
              title: service.title,
              description: service.description,
              protocols: service.protocols ?? [],
              source: service.source,
            };
            if (service.durableObject) {
              const singleton = workspaceDecls.singletons.find(
                service.source,
                service.durableObject.className
              );
              return {
                ...base,
                kind: "durable-object" as const,
                className: service.durableObject.className,
                defaultObjectKey: singleton ? singleton.key : null,
              };
            }
            return {
              ...base,
              kind: "worker" as const,
              routePath: service.worker.routePath,
            };
          });
        }

        case "resolveService": {
          const service = resolveUserlandService(
            workspaceDecls,
            args[0] as string,
            (args[1] as string | null | undefined) ?? undefined
          );
          assertUserlandServiceAccess(service.name, service.policy, ctx.caller.runtime.kind);
          if (service.kind === "durable-object") {
            await deps.activateDurableObject?.({
              source: service.source,
              className: service.className,
              objectKey: service.objectKey,
            });
          }
          return service;
        }

        case "resolveDurableObject": {
          const source = args[0] as string;
          const className = args[1] as string;
          const objectKey = args[2] as string;
          assertDurableObjectExists(
            buildSystem,
            workspaceDecls,
            source,
            className,
            ctx.caller.runtime.kind
          );
          const targetId = `do:${source}:${className}:${objectKey}`;
          await deps.activateDurableObject?.({ source, className, objectKey });
          return { kind: "durable-object", source, className, objectKey, targetId };
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
  };
}

function assertDurableObjectExists(
  buildSystem: BuildSystemV2,
  workspaceDecls: WorkspaceDeclarations,
  source: string,
  className: string,
  callerKind: CallerKind
): void {
  if (
    source === INTERNAL_DO_SOURCE &&
    (INTERNAL_DO_CLASSES as readonly string[]).includes(className)
  ) {
    return;
  }

  const worker = buildSystem
    .getGraph()
    .allNodes()
    .find((node) => node.kind === "worker" && node.relativePath === source);
  const classes = worker?.manifest.durable?.classes ?? [];
  if (classes.some((entry) => entry.className === className)) {
    const backingPolicies = workspaceDecls.services
      .filter(
        (service) => service.source === source && service.durableObject?.className === className
      )
      .map((service) => ({
        name: service.name,
        policy: service.policy as { allowed?: CallerKind[] } | undefined,
      }));
    for (const service of backingPolicies) {
      assertUserlandServiceAccess(service.name, service.policy, callerKind);
    }
    return;
  }

  throw new Error(`No Durable Object class registered for ${source}:${className}`);
}

function assertUserlandServiceAccess(
  serviceName: string,
  policy: { allowed?: CallerKind[] } | undefined,
  callerKind: CallerKind
): void {
  const allowed = policy?.allowed;
  if (!allowed || allowed.length === 0) {
    const err = new Error(
      `Userland service '${serviceName}' has no access policy`
    ) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }
  const effectiveKinds: CallerKind[] = callerKind === "do" ? ["do", "worker"] : [callerKind];
  if (!effectiveKinds.some((kind) => allowed.includes(kind))) {
    const err = new Error(
      `Caller kind '${callerKind}' cannot resolve userland service '${serviceName}'`
    ) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }
}
