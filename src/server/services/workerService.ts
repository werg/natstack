/**
 * Worker RPC Service -- high-level worker DO operations.
 *
 * Provides:
 * - listSources: available worker sources (durable.classes from manifests)
 * - getChannelWorkers: DOs subscribed to a channel (queries channel DO)
 * - callDO: dispatch a method to a DO
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
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
          // Query channel DO for participants
          const participants = await doDispatch.dispatch(
            { source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: channelId },
            "getParticipants",
          ) as Array<{ participantId: string; metadata: Record<string, unknown> }>;
          return (participants ?? [])
            .filter((p) => p.participantId.startsWith("/_w/"))
            .map((p) => {
              const parts = p.participantId.split("/").filter(Boolean);
              return {
                participantId: p.participantId,
                source: `${parts[1]}/${parts[2]}`,
                className: decodeURIComponent(parts[3] ?? ""),
                objectKey: decodeURIComponent(parts[4] ?? ""),
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
            log.info(`[callDO] ${source}:${className}/${objectKey}.${doMethod} => FAILED: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }
        }

        default:
          throw new Error(`Unknown workers method: ${method}`);
      }
    },
  };
}
