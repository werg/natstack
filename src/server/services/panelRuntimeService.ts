import type { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import {
  panelRuntimeMethods,
  registerClientSchema,
  leaseRequestSchema,
} from "@natstack/shared/serviceSchemas/panelRuntime";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";

export function createPanelRuntimeService(deps: {
  coordinator: PanelRuntimeCoordinator;
}): ServiceDefinition {
  return {
    name: "panelRuntime",
    description: "Panel runtime lease coordination",
    policy: { allowed: ["shell", "app", "server"], description: "Shell/runtime coordination only" },
    methods: panelRuntimeMethods,
    handler: async (ctx, method, args) => {
      const assertOwnsClientSession = (clientSessionId: string) => {
        if (deps.coordinator.ownsClientSession(clientSessionId, ctx.caller.runtime.id)) return;
        const error = new Error(
          `Panel runtime client session ${clientSessionId} is not owned by ${ctx.caller.runtime.id}`
        ) as Error & { code?: string };
        error.code = "PANEL_RUNTIME_CLIENT_FORBIDDEN";
        throw error;
      };
      switch (method) {
        case "registerClient":
          deps.coordinator.registerClient({
            ...(args[0] as z.infer<typeof registerClientSchema>),
            ownerCallerId: ctx.caller.runtime.id,
          });
          return undefined;
        case "unregisterClient":
          assertOwnsClientSession(args[0] as string);
          deps.coordinator.unregisterClient(args[0] as string);
          return undefined;
        case "getSnapshot":
          return deps.coordinator.getSnapshot();
        case "acquire":
          assertOwnsClientSession((args[1] as z.infer<typeof leaseRequestSchema>).clientSessionId);
          return deps.coordinator.acquire(
            args[0] as string,
            args[1] as z.infer<typeof leaseRequestSchema>
          );
        case "takeOver":
          assertOwnsClientSession((args[1] as z.infer<typeof leaseRequestSchema>).clientSessionId);
          return deps.coordinator.takeOver(
            args[0] as string,
            args[1] as z.infer<typeof leaseRequestSchema>
          );
        case "release":
          {
            const lease = deps.coordinator.getLease(args[0] as string);
            if (lease && lease.connectionId === (args[1] as string)) {
              assertOwnsClientSession(lease.clientSessionId);
            }
          }
          deps.coordinator.release(args[0] as string, args[1] as string);
          return undefined;
        default:
          throw new Error(`Unknown panelRuntime method: ${method}`);
      }
    },
  };
}
