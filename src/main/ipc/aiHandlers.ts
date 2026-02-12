/**
 * Shared AI service handler logic for both panels and workers.
 */

import type { AIHandler } from "../ai/aiHandler.js";
import type { StreamTextOptions } from "../../shared/types.js";
import type { CallerKind } from "../serviceDispatcher.js";

export async function handleAiServiceCall(
  aiHandler: AIHandler | null,
  method: string,
  args: unknown[],
  startStream: (aiHandler: AIHandler, options: StreamTextOptions, streamId: string) => void | Promise<void>,
  callerKind?: CallerKind
): Promise<unknown> {
  if (!aiHandler) {
    throw new Error("AI handler not initialized");
  }

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
      void startStream(aiHandler, options, streamId);
      return;
    }

    case "reinitialize":
      // Only admin/server callers may reinitialize providers.
      if (callerKind !== "server") {
        throw new Error("ai.reinitialize is restricted to server callers");
      }
      await aiHandler.initialize();
      return;

    default:
      throw new Error(`Unknown AI method: ${method}`);
  }
}
