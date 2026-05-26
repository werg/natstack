import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";

const clientPlatformSchema = z.enum(["desktop", "mobile"]);

const registerClientSchema = z.object({
  clientSessionId: z.string().min(1),
  label: z.string().min(1),
  platform: clientPlatformSchema,
});

const leaseRequestSchema = z.object({
  slotId: z.string().min(1),
  clientSessionId: z.string().min(1),
  connectionId: z.string().min(1),
});

export function createPanelRuntimeService(deps: {
  coordinator: PanelRuntimeCoordinator;
}): ServiceDefinition {
  return {
    name: "panelRuntime",
    description: "Panel runtime lease coordination",
    policy: { allowed: ["shell", "app", "server"], description: "Shell/runtime coordination only" },
    methods: {
      registerClient: { args: z.tuple([registerClientSchema]) },
      getSnapshot: { args: z.tuple([]) },
      acquire: { args: z.tuple([z.string(), leaseRequestSchema]) },
      takeOver: { args: z.tuple([z.string(), leaseRequestSchema]) },
      release: { args: z.tuple([z.string(), z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "registerClient":
          deps.coordinator.registerClient(args[0] as z.infer<typeof registerClientSchema>);
          return undefined;
        case "getSnapshot":
          return deps.coordinator.getSnapshot();
        case "acquire":
          return deps.coordinator.acquire(
            args[0] as string,
            args[1] as z.infer<typeof leaseRequestSchema>
          );
        case "takeOver":
          return deps.coordinator.takeOver(
            args[0] as string,
            args[1] as z.infer<typeof leaseRequestSchema>
          );
        case "release":
          deps.coordinator.release(args[0] as string, args[1] as string);
          return undefined;
        default:
          throw new Error(`Unknown panelRuntime method: ${method}`);
      }
    },
  };
}
