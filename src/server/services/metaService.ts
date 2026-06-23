import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { metaMethods } from "@natstack/shared/serviceSchemas/meta";
import type { MethodSchema } from "@natstack/shared/typedServiceClient";
import type { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { RuntimeSurface } from "@natstack/shared/runtimeSurface";

function serializeMethod(method: MethodSchema) {
  return {
    ...(method.description ? { description: method.description } : {}),
    ...(method.policy ? { policy: method.policy } : {}),
    ...(method.access ? { access: method.access } : {}),
    argsSchema: convertZodToJsonSchema(method.args, { target: "openApi3" }) as Record<
      string,
      unknown
    >,
    ...(method.returns
      ? {
          returnsSchema: convertZodToJsonSchema(method.returns, {
            target: "openApi3",
          }) as Record<string, unknown>,
        }
      : {}),
  };
}

function serializeDef(def: ServiceDefinition) {
  return {
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    policy: def.policy,
    methods: Object.fromEntries(
      Object.entries(def.methods).map(([name, method]) => [name, serializeMethod(method)])
    ),
  };
}

export function createMetaService(deps: {
  dispatcher: ServiceDispatcher;
  runtimeSurfaces: {
    panel: RuntimeSurface;
    workerRuntime: RuntimeSurface;
  };
}): ServiceDefinition {
  return {
    name: "meta",
    description: "Runtime introspection for services and eval runtime surfaces.",
    policy: { allowed: ["panel", "app", "worker", "do", "extension", "server", "shell"] },
    methods: metaMethods,
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "listServices":
          return deps.dispatcher.getServiceDefinitions().map(serializeDef);
        case "describeService": {
          const def = deps.dispatcher.getServiceDefinitions().find((item) => item.name === args[0]);
          if (!def) throw new Error(`Unknown service: ${args[0]}`);
          return serializeDef(def);
        }
        case "getRuntimeSurface":
          return args[0] === "panel"
            ? deps.runtimeSurfaces.panel
            : deps.runtimeSurfaces.workerRuntime;
        default:
          throw new Error(`Unknown meta method: ${method}`);
      }
    },
  };
}
