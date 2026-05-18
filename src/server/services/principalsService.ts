import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PrincipalKind, PrincipalRegistry } from "@natstack/shared/principalRegistry";

const RegisterOptionsSchema = z
  .object({
    source: z.string().optional(),
    contextId: z.string().optional(),
    parentId: z.string().nullable().optional(),
  })
  .optional();

export function createPrincipalsService(deps: {
  registry: PrincipalRegistry;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
}): ServiceDefinition {
  return {
    name: "principals",
    description: "Runtime principal registration and metadata binding",
    policy: { allowed: ["server", "shell"] },
    methods: {
      register: {
        args: z.tuple([
          z.string(),
          z.enum(["panel", "worker", "do-service", "shell", "server"]),
          RegisterOptionsSchema,
        ]),
      },
      unregister: { args: z.tuple([z.string()]) },
      bindContext: { args: z.tuple([z.string(), z.string()]) },
      clearContext: { args: z.tuple([z.string()]) },
      bindSource: { args: z.tuple([z.string(), z.string()]) },
      setParent: { args: z.tuple([z.string(), z.string().nullable()]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "register": {
          const [id, kind, options] = args as [
            string,
            PrincipalKind,
            { source?: string; contextId?: string; parentId?: string | null } | undefined,
          ];
          assertRpcRegistrationAllowed(ctx.caller.runtime.kind, kind);
          deps.registry.register({
            id,
            kind,
            source: options?.source
              ? {
                  repoPath: options.source,
                  effectiveVersion: await resolveEffectiveVersion(deps, options.source),
                }
              : undefined,
            context: options?.contextId ? { contextId: options.contextId } : undefined,
            parent: { parentId: options?.parentId ?? null },
          });
          return;
        }
        case "unregister":
          deps.registry.unregister(args[0] as string);
          return;
        case "bindContext":
          deps.registry.bindContext(args[0] as string, args[1] as string);
          return;
        case "clearContext":
          deps.registry.clearContext(args[0] as string);
          return;
        case "bindSource": {
          const [id, source] = args as [string, string];
          deps.registry.bindSource(id, {
            repoPath: source,
            effectiveVersion: await resolveEffectiveVersion(deps, source),
          });
          return;
        }
        case "setParent":
          deps.registry.setParent(args[0] as string, args[1] as string | null);
          return;
        default:
          throw new Error(`Unknown principals method: ${method}`);
      }
    },
  };
}

function assertRpcRegistrationAllowed(callerKind: string, kind: PrincipalKind): void {
  if (kind === "shell" || kind === "server") {
    throw new Error(`${kind} principals are bootstrap-only`);
  }
  if ((kind === "worker" || kind === "do-service") && callerKind !== "server") {
    throw new Error(`${kind} principals may only be registered by server`);
  }
}

async function resolveEffectiveVersion(
  deps: { getEffectiveVersion?: (source: string) => Promise<string | undefined> },
  source: string
): Promise<string> {
  if (source.startsWith("browser:")) return "";
  return (await Promise.resolve(deps.getEffectiveVersion?.(source)).catch(() => undefined)) ?? "";
}
