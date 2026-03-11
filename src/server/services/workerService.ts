/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - getChannelWorkers: DOs subscribed to a channel
 * - callDO: dispatch a method to a DO (with special handling for subscribe/unsubscribe)
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { WorkerRouter } from "../workerRouter.js";
import type { PubSubFacade } from "./pubsubFacade.js";
import type { HarnessManager } from "../harnessManager.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { ParticipantDescriptor, UnsubscribeResult } from "@natstack/harness";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerService");

export function createWorkerService(deps: {
  router: WorkerRouter;
  facade: PubSubFacade;
  harnessManager: HarnessManager;
  buildSystem: BuildSystemV2;
}): ServiceDefinition {
  const { router, facade, harnessManager, buildSystem } = deps;

  return {
    name: "workers",
    description: "Worker DO operations (subscribe, call, list)",
    policy: { allowed: ["server", "panel", "worker"] },
    methods: {
      listSources: {
        description: "List available worker sources with durable object classes",
        args: z.tuple([]),
      },
      getChannelWorkers: {
        description: "Get DOs subscribed to a channel",
        args: z.tuple([z.string()]), // channelId
      },
      callDO: {
        description: "Call a method on a DO",
        args: z.tuple([
          z.string(), // className
          z.string(), // objectKey
          z.string(), // method
        ]).rest(z.unknown()), // ...args
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "listSources": {
          const graph = buildSystem.getGraph();
          return graph
            .allNodes()
            .filter((n) => {
              // Include workers that declare durable object classes
              // The 'durable' field may be absent from older manifests
              const manifest = n.manifest as Record<string, unknown>;
              const durable = manifest["durable"] as { classes?: unknown[] } | undefined;
              return (
                n.kind === "worker" &&
                durable &&
                Array.isArray(durable.classes) &&
                durable.classes.length > 0
              );
            })
            .map((n) => {
              const manifest = n.manifest as Record<string, unknown>;
              const durable = manifest["durable"] as { classes: unknown[] };
              return {
                name: n.name,
                source: n.relativePath,
                title: n.manifest.title,
                classes: durable.classes,
              };
            });
        }

        case "getChannelWorkers": {
          const channelId = args[0] as string;
          // Find all participant entries in the facade for this channel
          const entries = facade.getAllEntries().filter(
            (e) => e.channelId === channelId,
          );
          return entries.map((e) => ({
            participantId: e.participantId,
            className: e.className,
            objectKey: e.objectKey,
            channelId: e.channelId,
          }));
        }

        case "callDO": {
          const className = args[0] as string;
          const objectKey = args[1] as string;
          const doMethod = args[2] as string;
          const doArgs = args.slice(3);

          // Special handling for subscribeChannel
          if (doMethod === "subscribeChannel") {
            return await handleSubscribeChannel(
              className,
              objectKey,
              doArgs,
              router,
              facade,
            );
          }

          // Special handling for unsubscribeChannel
          if (doMethod === "unsubscribeChannel") {
            return await handleUnsubscribeChannel(
              className,
              objectKey,
              doArgs,
              router,
              facade,
              harnessManager,
            );
          }

          // Generic DO method call
          const actions = await router.dispatch(
            className,
            objectKey,
            doMethod,
            ...doArgs,
          );
          return actions;
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
  };
}

// ─── Subscribe/Unsubscribe helpers ──────────────────────────────────────────

async function handleSubscribeChannel(
  className: string,
  objectKey: string,
  doArgs: unknown[],
  router: WorkerRouter,
  facade: PubSubFacade,
): Promise<unknown> {
  const channelId = doArgs[0] as string;
  const contextId = (doArgs[1] as string | undefined) ?? channelId;
  const config = doArgs[2] as Record<string, unknown> | undefined;

  // Call the DO's subscribeChannel method to get the ParticipantDescriptor.
  // The DO expects { channelId, contextId, config? }.
  const result = await router.dispatch(
    className,
    objectKey,
    "subscribeChannel",
    { channelId, contextId, config },
  );

  // The DO should return a ParticipantDescriptor (not WorkerActions)
  // in the first action, or as the direct result.
  // Convention: the DO returns WorkerActions where the first action contains
  // descriptor info, or the result itself is a descriptor.
  // For simplicity, we treat the result as having a 'descriptor' field.
  const descriptor = extractDescriptor(result);
  if (!descriptor) {
    log.warn(
      `subscribeChannel: DO ${className}/${objectKey} returned no descriptor`,
    );
    return { ok: false, error: "No participant descriptor" };
  }

  // Generate a participant ID
  const participantId = `do:${className}:${objectKey}:${channelId}`;

  // Subscribe via the facade
  await facade.subscribe({
    channelId,
    participantId,
    className,
    objectKey,
    descriptor,
  });

  // Tell the DO its participant ID so it can use it in RPC calls
  await router.dispatch(className, objectKey, "setParticipantId", channelId, participantId);

  return { ok: true, participantId };
}

async function handleUnsubscribeChannel(
  className: string,
  objectKey: string,
  doArgs: unknown[],
  router: WorkerRouter,
  facade: PubSubFacade,
  harnessManager: HarnessManager,
): Promise<unknown> {
  const channelId = doArgs[0] as string;

  // Call the DO's unsubscribeChannel method to get the UnsubscribeResult
  const result = await router.dispatch(
    className,
    objectKey,
    "unsubscribeChannel",
    channelId,
  );

  const unsubResult = extractUnsubscribeResult(result);

  // Find the participant for this DO on this channel
  const participantId = `do:${className}:${objectKey}:${channelId}`;

  // Unsubscribe from PubSub
  facade.unsubscribe(participantId);

  // Stop any associated harness processes
  if (unsubResult?.harnessIds) {
    for (const harnessId of unsubResult.harnessIds) {
      try {
        router.unregisterHarness(harnessId);
        await harnessManager.stop(harnessId);
      } catch (err) {
        log.warn(`Failed to stop harness ${harnessId}:`, err);
      }
    }
  }

  return { ok: true };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a ParticipantDescriptor from a DO method result.
 * The result may be either a WorkerActions wrapper or a direct descriptor.
 */
function extractDescriptor(result: unknown): ParticipantDescriptor | null {
  if (!result || typeof result !== "object") return null;

  // Direct descriptor (has required fields)
  const obj = result as Record<string, unknown>;
  if ("handle" in obj && "name" in obj && "type" in obj) {
    return obj as unknown as ParticipantDescriptor;
  }

  // WorkerActions wrapper: check actions array
  if ("actions" in obj && Array.isArray(obj["actions"])) {
    // Look for a descriptor in the first action
    for (const action of obj["actions"]) {
      if (action && typeof action === "object" && "descriptor" in action) {
        return (action as Record<string, unknown>)["descriptor"] as ParticipantDescriptor;
      }
    }
  }

  // Descriptor nested under 'descriptor' key
  if ("descriptor" in obj && obj["descriptor"] && typeof obj["descriptor"] === "object") {
    return obj["descriptor"] as ParticipantDescriptor;
  }

  return null;
}

/**
 * Extract an UnsubscribeResult from a DO method result.
 */
function extractUnsubscribeResult(result: unknown): UnsubscribeResult | null {
  if (!result || typeof result !== "object") return null;

  const obj = result as Record<string, unknown>;
  if ("harnessIds" in obj && Array.isArray(obj["harnessIds"])) {
    return obj as unknown as UnsubscribeResult;
  }

  // Check in actions wrapper
  if ("actions" in obj && Array.isArray(obj["actions"])) {
    // Return empty if no harness IDs found
    return { harnessIds: [] };
  }

  return { harnessIds: [] };
}
