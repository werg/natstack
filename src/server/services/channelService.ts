/**
 * Channel RPC Service -- channel operations for worker DOs.
 *
 * Provides:
 * - fork: create a forked channel
 * - callMethod: proxy tool/method calls from harness to PubSub participant
 * - discoverMethods: return advertised methods from channel roster
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { PubSubServer } from "@natstack/pubsub-server";
import type { WorkerRouter } from "../workerRouter.js";
import type { PubSubFacade } from "./pubsubFacade.js";
import type { HarnessManager } from "../harnessManager.js";
import { executeActions } from "../executeActions.js";
import type { WorkerAction, WorkerActions } from "@natstack/harness";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("ChannelService");

export function createChannelService(deps: {
  pubsub: PubSubServer;
  router: WorkerRouter;
  facade: PubSubFacade;
  harnessManager: HarnessManager;
}): ServiceDefinition {
  const { pubsub, router, facade, harnessManager } = deps;

  return {
    name: "channel",
    description: "Channel operations (fork, method calls, discovery)",
    policy: { allowed: ["server", "worker", "harness"] },
    methods: {
      fork: {
        description: "Create a forked channel from a source channel at a specific message ID",
        args: z.tuple([
          z.string(), // sourceChannel
          z.number(), // forkPointId
          z.object({
            contextId: z.string().optional(),
            createdBy: z.string().optional(),
          }).optional(),
        ]),
      },
      callMethod: {
        description: "Call a method on a participant in a channel",
        args: z.tuple([
          z.string(), // channelId
          z.string(), // participantId
          z.string(), // methodName
          z.unknown(), // args
        ]),
      },
      discoverMethods: {
        description: "Discover methods advertised by participants in a channel",
        args: z.tuple([z.string()]), // channelId
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "fork": {
          const sourceChannel = args[0] as string;
          const forkPointId = args[1] as number;
          const options = (args[2] as { contextId?: string; createdBy?: string } | undefined) ?? {};

          // Create a new channel ID
          const forkedChannelId = `fork:${sourceChannel}:${randomUUID().slice(0, 8)}`;

          // Create the channel in the message store
          const messageStore = pubsub.getMessageStore();
          const contextId = options.contextId ?? "default";
          const createdBy = options.createdBy ?? "system";

          messageStore.createChannel(forkedChannelId, contextId, createdBy);
          messageStore.setChannelFork(forkedChannelId, sourceChannel, forkPointId);

          log.info(`Forked channel ${sourceChannel} at ${forkPointId} -> ${forkedChannelId}`);
          return { channelId: forkedChannelId };
        }

        case "callMethod": {
          const channelId = args[0] as string;
          const targetParticipantId = args[1] as string;
          const methodName = args[2] as string;
          const methodArgs = args[3];

          const callId = randomUUID();

          // Resolve the caller's identity: _ctx.callerId is the harnessId,
          // look up its owning DO and find the DO's participant ID
          const doReg = router.getDOForHarness(_ctx.callerId);
          const callerParticipantId = doReg
            ? router.getParticipantsForDO(doReg.className, doReg.objectKey)[0]
            : undefined;

          if (!doReg || !callerParticipantId) {
            throw new Error(`Cannot resolve caller participant for harness ${_ctx.callerId}`);
          }

          const callActions = await router.dispatch(
            doReg.className,
            doReg.objectKey,
            "onOutgoingMethodCall",
            channelId,
            callId,
            targetParticipantId,
            methodName,
            methodArgs,
          );

          log.info(
            `Method call ${methodName} to ${targetParticipantId} on ${channelId} (callId=${callId})`,
          );
          return executeOutgoingMethodCall({
            actions: callActions,
            callId,
            callerParticipantId,
            channelId,
            fallbackTargetParticipantId: targetParticipantId,
            fallbackMethodName: methodName,
            fallbackArgs: methodArgs,
            facade,
            harnessManager,
            router,
          });
        }

        case "discoverMethods": {
          const channelId = args[0] as string;

          // Resolve the caller's owning DO so we can exclude self-methods.
          // Without this, the agent would discover its own methods (pause, resume)
          // as MCP tools, creating circular self-referencing tools.
          const callerDO = router.getDOForHarness(_ctx.callerId);
          const selfParticipantIds = callerDO
            ? new Set(router.getParticipantsForDO(callerDO.className, callerDO.objectKey))
            : new Set<string>();

          // Get roster from PubSub and extract advertised methods from participant metadata
          const participants = pubsub.getChannelParticipants(channelId);
          const methods: Array<{ participantId: string; name: string; description: string; parameters?: unknown }> = [];

          for (const p of participants) {
            // Skip methods from the caller's own DO participant
            if (selfParticipantIds.has(p.participantId)) continue;

            const advertised = p.metadata["methods"];
            if (Array.isArray(advertised)) {
              for (const m of advertised) {
                const method = m as Record<string, unknown>;
                methods.push({
                  participantId: p.participantId,
                  name: method["name"] as string,
                  description: (method["description"] as string) ?? "",
                  ...(method["parameters"] ? { parameters: method["parameters"] } : {}),
                });
              }
            }
          }

          log.info(`Discover methods for channel ${channelId}: found ${methods.length} (excluded ${selfParticipantIds.size} self-participant(s))`);
          return methods;
        }

        default:
          throw new Error(`Unknown channels method: ${method}`);
      }
    },
  };
}

async function executeOutgoingMethodCall(deps: {
  actions: WorkerActions;
  callId: string;
  callerParticipantId: string;
  channelId: string;
  fallbackTargetParticipantId: string;
  fallbackMethodName: string;
  fallbackArgs: unknown;
  facade: PubSubFacade;
  harnessManager: HarnessManager;
  router: WorkerRouter;
}): Promise<unknown> {
  const {
    actions,
    callId,
    callerParticipantId,
    channelId,
    fallbackTargetParticipantId,
    fallbackMethodName,
    fallbackArgs,
    facade,
    harnessManager,
    router,
  } = deps;

  let resultAction: Extract<WorkerAction, { target: "channel"; op: "method-result" }> | undefined;
  let deferredCall: Extract<WorkerAction, { target: "channel"; op: "call-method" }> | undefined;
  const sideEffects: WorkerAction[] = [];

  for (const action of actions.actions) {
    if (action.target === "channel" && action.op === "method-result" && action.callId === callId) {
      resultAction = action;
      continue;
    }
    if (action.target === "channel" && action.op === "call-method" && action.callId === callId && !deferredCall) {
      deferredCall = action;
      continue;
    }
    sideEffects.push(action);
  }

  if (sideEffects.length > 0) {
    await executeActions(
      { actions: sideEffects },
      { facade, harnessManager, router, participantId: callerParticipantId },
    );
  }

  if (resultAction) {
    if (resultAction.isError) {
      throw new Error(stringifyMethodError(resultAction.content));
    }
    return resultAction.content;
  }

  if (deferredCall) {
    return facade.callParticipantMethod(
      callerParticipantId,
      deferredCall.channelId,
      deferredCall.participantId,
      deferredCall.callId,
      deferredCall.method,
      deferredCall.args,
    );
  }

  return facade.callParticipantMethod(
    callerParticipantId,
    channelId,
    fallbackTargetParticipantId,
    callId,
    fallbackMethodName,
    fallbackArgs,
  );
}

function stringifyMethodError(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "error" in content) {
    return String((content as { error: unknown }).error);
  }
  return JSON.stringify(content);
}
