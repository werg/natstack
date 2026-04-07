/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - getChannelWorkers: DOs subscribed to a channel (queries channel DO)
 * - callDO: dispatch a method to a DO
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { DODispatch } from "../doDispatch.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerService");

export function createWorkerService(deps: {
  doDispatch: DODispatch;
  buildSystem: BuildSystemV2;
}): ServiceDefinition {
  const { doDispatch, buildSystem } = deps;

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
            .filter((n) =>
              n.kind === "worker" &&
              n.manifest.durable &&
              n.manifest.durable.classes.length > 0
            )
            .map((n) => ({
              name: n.name,
              source: n.relativePath,
              title: n.manifest.title,
              classes: n.manifest.durable!.classes,
            }));
        }

        case "getChannelWorkers": {
          const channelId = args[0] as string;
          // Query channel DO for participants
          const participants = await doDispatch.dispatch(
            { source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: channelId },
            "getParticipants",
          ) as Array<{ participantId: string; metadata: Record<string, unknown> }>;
          return (participants ?? [])
            .filter((p) => p.participantId.startsWith("do:"))
            .map((p) => {
              // Format: "do:{source}:{className}:{objectKey}"
              // Source contains "/" but no ":", className has no ":"
              const body = p.participantId.slice(3);
              const slashIdx = body.indexOf("/");
              const colonAfterSlash = slashIdx >= 0 ? body.indexOf(":", slashIdx) : -1;
              if (colonAfterSlash === -1) return null;
              const source = body.slice(0, colonAfterSlash);
              const rest = body.slice(colonAfterSlash + 1);
              const nextColon = rest.indexOf(":");
              if (nextColon === -1) return null;
              return {
                participantId: p.participantId,
                source,
                className: rest.slice(0, nextColon),
                objectKey: rest.slice(nextColon + 1),
                channelId,
              };
            })
            .filter(Boolean);
        }

        case "callDO": {
          const source = args[0] as string;
          const className = args[1] as string;
          const objectKey = args[2] as string;
          const doMethod = args[3] as string;
          const doArgs = args.slice(4);

          log.info(`[callDO] ${source}:${className}/${objectKey}.${doMethod}`);
          try {
            const result = await doDispatch.dispatch(
              { source, className, objectKey },
              doMethod,
              ...doArgs,
            );
            log.info(`[callDO] ${source}:${className}/${objectKey}.${doMethod} => OK`);
            return result;
          } catch (err) {
            log.warn(`[callDO] ${source}:${className}/${objectKey}.${doMethod} => FAILED: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
  };
}
