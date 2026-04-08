import { z } from "zod";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import type { ServiceDefinition, MethodDef } from "@natstack/shared/serviceDefinition";
import type { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { RuntimeSurface } from "../../../workspace/packages/runtime/src/shared/runtimeSurface.js";

function serializeMethod(method: MethodDef) {
  return {
    ...(method.description ? { description: method.description } : {}),
    ...(method.policy ? { policy: method.policy } : {}),
    argsSchema: convertZodToJsonSchema(method.args, { target: "openApi3" }) as Record<string, unknown>,
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
      Object.entries(def.methods).map(([name, method]) => [name, serializeMethod(method)]),
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
    policy: { allowed: ["panel", "worker", "server", "shell"] },
    methods: {
      listServices: {
        description: "List all registered RPC services and their method metadata.",
        args: z.tuple([]),
      },
      describeService: {
        description: "Describe one registered RPC service by name.",
        args: z.tuple([z.string()]),
      },
      getRuntimeSurface: {
        description: "Return the live eval runtime surface manifest for the requested target.",
        args: z.tuple([z.enum(["panel", "workerRuntime"])]),
      },
    },
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
