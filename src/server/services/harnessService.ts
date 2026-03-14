/**
 * Harness RPC Service -- receives HarnessOutput events from harness processes
 * and routes them to the owning DO via DODispatch.
 *
 * Simplified: no action execution — just forwards the event to the DO.
 * The DO handles all side effects via direct outbound HTTP calls.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { DODispatch } from "../doDispatch.js";
import type { HarnessManager } from "../harnessManager.js";
import type { HarnessOutput } from "@natstack/harness";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("HarnessService");

function createAsyncQueue() {
  let chain = Promise.resolve();

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn);
      chain = next.then(() => undefined, () => undefined);
      return next;
    },
    async flush(): Promise<void> {
      await chain;
    },
  };
}

export function createHarnessService(deps: {
  doDispatch: DODispatch;
  harnessManager: HarnessManager;
}): ServiceDefinition {
  const { doDispatch, harnessManager } = deps;
  const queues = new Map<string, ReturnType<typeof createAsyncQueue>>();

  return {
    name: "harness",
    description: "Harness event ingestion (receives events from harness processes)",
    policy: { allowed: ["harness", "server"] },
    methods: {
      pushEvent: {
        description: "Push a harness output event to the owning DO",
        args: z.tuple([
          z.string(),   // harnessId
          z.unknown(),   // event (HarnessOutput)
        ]),
      },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "pushEvent": {
          const harnessId = args[0] as string;
          const event = args[1] as HarnessOutput;
          const queue = queues.get(harnessId) ?? createAsyncQueue();
          queues.set(harnessId, queue);

          try {
            await queue.enqueue(async () => {
              // Look up the owning DO via HarnessManager
              const doRef = harnessManager.getDOForHarness(harnessId);
              if (!doRef) {
                throw new Error(`No DO registration for harness ${harnessId}`);
              }

              // Dispatch to the DO — returns void (no actions to execute)
              await doDispatch.dispatch(doRef, "onHarnessEvent", harnessId, event);
            });

            return { ok: true };
          } catch (err) {
            log.error(`pushEvent dispatch failed for ${harnessId}:`, err);
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        default:
          throw new Error(`Unknown harness method: ${method}`);
      }
    },
  };
}
