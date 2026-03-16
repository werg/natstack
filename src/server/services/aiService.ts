import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { AIHandler } from "../../shared/ai/aiHandler.js";
import type { StreamTextOptions } from "../../shared/types.js";
import type { RpcServer } from "../rpcServer.js";
import type { ContextFolderManager } from "../../shared/contextFolderManager.js";

export function createAiService(deps: {
  aiHandler: AIHandler;
  rpcServer: RpcServer;
  contextFolderManager: ContextFolderManager;
}): ServiceDefinition {
  return {
    name: "ai",
    description: "AI/LLM operations",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
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

          // Resolve context folder — every panel has a contextId
          if (!options.contextId) {
            throw new Error("AI streaming requires a contextId");
          }
          const contextFolderPath = await deps.contextFolderManager.ensureContextFolder(options.contextId);

          const target = deps.rpcServer.createWsStreamTarget(ctx.wsClient, streamId);
          aiHandler.startTargetStream(target, options, streamId, contextFolderPath);
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
