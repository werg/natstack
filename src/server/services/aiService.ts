import { z } from "zod";
import type { ServiceDefinition } from "../../main/serviceDefinition.js";
import type { AIHandler } from "../../main/ai/aiHandler.js";
import type { RpcServer } from "../rpcServer.js";
import type { StreamTextOptions } from "../../shared/types.js";

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
      const { handleAiServiceCall } = await import("../../main/ipc/aiHandlers.js");
      return handleAiServiceCall(
        deps.aiHandler,
        method,
        args as unknown[],
        (handler, options, streamId) => {
          if (!ctx.wsClient) {
            throw new Error("AI streaming requires a WS connection");
          }
          const target = deps.rpcServer.createWsStreamTarget(ctx.wsClient, streamId);
          handler.startTargetStream(target, options, streamId);
        },
        ctx.callerKind,
      );
    },
  };
}
