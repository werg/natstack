import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { AIHandler } from "../../shared/ai/aiHandler.js";
import type { StreamTextOptions } from "../../shared/types.js";
import type { RpcServer } from "../rpcServer.js";

export function createAiService(deps: {
  aiHandler: AIHandler;
  rpcServer: RpcServer;
}): ServiceDefinition {
  return {
    name: "ai",
    description: "AI/LLM operations",
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {
      listRoles: { args: z.tuple([]) },
      streamCancel: { args: z.tuple([z.string()]) },
      streamTextStart: { args: z.tuple([z.record(z.unknown()), z.string()]) },
      reinitialize: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      const aiHandler = deps.aiHandler;

      switch (method) {
        case "listRoles":
          return aiHandler.getAvailableRoles();

        case "streamCancel": {
          const [streamId] = args as [string];
          aiHandler.cancelStream(streamId);
          return;
        }

        case "streamTextStart": {
          const [options, streamId] = args as [StreamTextOptions, string];
          if (!ctx.wsClient) {
            throw new Error("AI streaming requires a WS connection");
          }
          const target = deps.rpcServer.createWsStreamTarget(ctx.wsClient, streamId);
          aiHandler.startTargetStream(target, options, streamId);
          return;
        }

        case "reinitialize":
          if (ctx.callerKind !== "server") {
            throw new Error("ai.reinitialize is restricted to server callers");
          }
          await aiHandler.initialize();
          return;

        default:
          throw new Error(`Unknown AI method: ${method}`);
      }
    },
  };
}
