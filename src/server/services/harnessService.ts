/**
 * Harness RPC Service -- receives HarnessOutput events from harness processes
 * and routes them to the owning DO.
 *
 * When a harness pushes an event, we:
 * 1. Look up the owning DO via router.getDOForHarness()
 * 2. Dispatch to the DO's onHarnessEvent method
 * 3. Execute any returned actions
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { WorkerRouter } from "../workerRouter.js";
import type { HarnessOutput } from "@natstack/harness";
import type { ExecuteActionsFn } from "./pubsubFacade.js";
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
  router: WorkerRouter;
  executeActions: ExecuteActionsFn;
  /** Resolve which participantId owns a harness's DO (for action context) */
  resolveParticipantForHarness: (harnessId: string) => string | undefined;
}): ServiceDefinition {
  const { router, executeActions, resolveParticipantForHarness } = deps;
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
              // Look up the owning DO
              const doReg = router.getDOForHarness(harnessId);
              if (!doReg) {
                log.warn(`pushEvent: no DO registration for harness ${harnessId}`);
                return;
              }

              const { className, objectKey } = doReg;

              // Dispatch to the DO
              const actions = await router.dispatch(
                className,
                objectKey,
                "onHarnessEvent",
                harnessId,
                event,
              );

              // Execute returned actions
              if (actions && actions.actions && actions.actions.length > 0) {
                // Find the participant ID for action context
                const participantId = resolveParticipantForHarness(harnessId);
                if (participantId) {
                  await executeActions(actions, { participantId });
                } else {
                  log.error(
                    `pushEvent: no participantId for harness ${harnessId} — ${actions.actions.length} actions DROPPED (types: ${actions.actions.map(a => `${a.target}:${(a as any).op ?? (a as any).command?.type}`).join(', ')})`,
                  );
                }
              }
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
