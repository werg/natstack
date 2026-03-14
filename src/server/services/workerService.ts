/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Simplified: generic dispatch only, no subscribe/unsubscribe handling
 * (DOs handle their own subscriptions via PubSub HTTP API).
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - getChannelWorkers: DOs subscribed to a channel (queries PubSub HTTP API)
 * - callDO: dispatch a method to a DO
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { DODispatch } from "../doDispatch.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { PubSubServer } from "@natstack/pubsub-server";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerService");

export function createWorkerService(deps: {
  doDispatch: DODispatch;
  buildSystem: BuildSystemV2;
  pubsub: PubSubServer;
}): ServiceDefinition {
  const { doDispatch, buildSystem, pubsub } = deps;

  return {
    name: "workers",
    description: "Worker DO operations (call, list)",
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
          z.string(), // source
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
          // Query PubSub roster for DO participants
          const participants = pubsub.getChannelParticipants(channelId);
          return participants
            .filter((p) => p.participantId.startsWith("do:"))
            .map((p) => {
              // Parse participantId format: do:{source}:{className}:{objectKey}:{channelId}
              const parts = p.participantId.split(":");
              return {
                participantId: p.participantId,
                source: parts[1] ?? "",
                className: parts[2] ?? "",
                objectKey: parts[3] ?? "",
                channelId,
              };
            });
        }

        case "callDO": {
          const source = args[0] as string;
          const className = args[1] as string;
          const objectKey = args[2] as string;
          const doMethod = args[3] as string;
          const doArgs = args.slice(4);

          // Generic DO method call via DODispatch
          const result = await doDispatch.dispatch(
            { source, className, objectKey },
            doMethod,
            ...doArgs,
          );
          return result;
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
  };
}
