/**
 * Harness RPC Service -- receives HarnessOutput events from harness processes
 * and routes them to the owning DO via DODispatch.
 *
 * Simplified: no action execution — just forwards the event to the DO.
 * The DO handles all side effects via direct outbound HTTP calls.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { CallerKind } from "../../shared/serviceDispatcher.js";
import type { DODispatch, DORef } from "../doDispatch.js";
import type { HarnessManager } from "../harnessManager.js";
import type { ContextFolderManager } from "../../shared/contextFolderManager.js";
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

/** Validate that required fields exist on a command object. */
function requireFields(cmd: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (cmd[f] === undefined) {
      throw new Error(`Command '${cmd["type"]}' missing required field '${f}'`);
    }
  }
}

/** Map a HarnessCommand to RPC method name and args */
function commandToRpc(cmd: { type: string; [key: string]: unknown }): { method: string; args: unknown[] } {
  switch (cmd.type) {
    case "start-turn":
      requireFields(cmd, ["input"]);
      return { method: "startTurn", args: [cmd["input"]] };
    case "approve-tool":
      requireFields(cmd, ["toolUseId"]);
      return { method: "approveTool", args: [cmd["toolUseId"], cmd["allow"], cmd["alwaysAllow"], cmd["updatedInput"]] };
    case "interrupt":
      return { method: "interrupt", args: [] };
    case "fork":
      requireFields(cmd, ["forkPointMessageId"]);
      return { method: "fork", args: [cmd["forkPointMessageId"], cmd["turnSessionId"]] };
    case "dispose":
      return { method: "dispose", args: [] };
    case "tool-result":
      requireFields(cmd, ["callId", "result"]);
      return { method: "toolResult", args: [cmd["callId"], cmd["result"], cmd["isError"]] };
    case "discover-methods-result":
      requireFields(cmd, ["methods"]);
      return { method: "discoverMethodsResult", args: [cmd["methods"]] };
    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

export function createHarnessService(deps: {
  doDispatch: DODispatch;
  harnessManager: HarnessManager;
  contextFolderManager: ContextFolderManager;
}): ServiceDefinition {
  const { doDispatch, harnessManager, contextFolderManager } = deps;
  const queues = new Map<string, ReturnType<typeof createAsyncQueue>>();

  return {
    name: "harness",
    description: "Harness lifecycle management and event ingestion",
    policy: { allowed: ["harness", "server", "worker"] },
    methods: {
      pushEvent: {
        description: "Push a harness output event to the owning DO",
        args: z.tuple([
          z.string(),   // harnessId
          z.unknown(),   // event (HarnessOutput)
        ]),
        policy: { allowed: ["harness", "server"] as CallerKind[] },
      },
      spawn: {
        description: "Spawn a new harness process",
        args: z.tuple([z.object({
          doRef: z.object({ source: z.string(), className: z.string(), objectKey: z.string() }),
          harnessId: z.string().optional(),
          type: z.string(),
          contextId: z.string(),
          config: z.record(z.unknown()).optional(),
          initialInput: z.object({ content: z.string(), senderId: z.string() }).passthrough().optional(),
        })]),
        policy: { allowed: ["harness", "server", "worker"] as CallerKind[] },
      },
      sendCommand: {
        description: "Send a command to a running harness",
        args: z.tuple([z.string(), z.object({ type: z.string() }).passthrough()]),
        policy: { allowed: ["harness", "server", "worker"] as CallerKind[] },
      },
      stop: {
        description: "Stop a harness process",
        args: z.tuple([z.string()]),
        policy: { allowed: ["harness", "server", "worker"] as CallerKind[] },
      },
      getStatus: {
        description: "Get harness status",
        args: z.tuple([z.string()]),
        policy: { allowed: ["harness", "server", "worker"] as CallerKind[] },
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

        case "spawn": {
          const opts = args[0] as {
            doRef: DORef;
            harnessId?: string;
            type: string;
            contextId: string;
            config?: Record<string, unknown>;
            initialInput?: { content: string; senderId: string };
          };

          const { doRef, type, contextId, config, initialInput } = opts;
          let harnessId = opts.harnessId;

          if (!doRef || !type || !contextId) {
            throw new Error("Missing required fields: doRef, type, contextId");
          }

          // Generate harness ID if not provided
          if (!harnessId) {
            harnessId = `harness-${randomUUID()}`;
          }

          log.info(`Spawning harness ${harnessId} for DO ${doRef.source}:${doRef.className}/${doRef.objectKey}`);

          try {
            // Ensure context folder
            const contextFolderPath = await contextFolderManager.ensureContextFolder(contextId);

            // Serialize HarnessConfig for the child process
            const configEnv: Record<string, string> = config
              ? { HARNESS_CONFIG: JSON.stringify(config) }
              : {};
            const extraEnv = (config?.["extraEnv"] as Record<string, string>) ?? {};

            // Spawn the harness process
            await harnessManager.spawn({
              id: harnessId,
              type,
              workerId: `${doRef.source}:${doRef.className}:${doRef.objectKey}`,
              contextId,
              contextFolderPath,
              extraEnv: { ...extraEnv, ...configEnv },
            });

            // Wait for harness to authenticate (bridge becomes available)
            const bridge = await harnessManager.waitForBridge(harnessId);

            // Notify the DO that harness is ready
            await doDispatch.dispatch(doRef, "onHarnessEvent", harnessId, { type: "ready" });

            // If initial input provided, fire start-turn
            if (initialInput) {
              // Fire-and-forget start-turn (the AI turn blocks for minutes —
              // we don't hold the RPC call open for that)
              bridge.call(harnessId, "startTurn", initialInput).catch((err) => {
                log.error(`Initial start-turn failed for ${harnessId}:`, err);
              });
            }

            log.info(`Harness ${harnessId} spawned and ready for DO ${doRef.source}:${doRef.className}/${doRef.objectKey}`);
            return { ok: true, harnessId };
          } catch (err) {
            log.error(`Spawn failed for ${harnessId}:`, err);
            try { await harnessManager.stop(harnessId); } catch { /* already stopped */ }
            throw err;
          }
        }

        case "sendCommand": {
          const harnessId = args[0] as string;
          const command = args[1] as { type: string; [key: string]: unknown };

          if (!command || !command.type) {
            throw new Error("Missing command");
          }

          const bridge = harnessManager.getHarnessBridge(harnessId);
          if (!bridge) {
            throw new Error(`No bridge for harness ${harnessId}`);
          }

          const { method: rpcMethod, args: rpcArgs } = commandToRpc(command);

          if (command.type === "start-turn") {
            // Fire-and-forget: startTurn blocks for minutes
            bridge.call(harnessId, rpcMethod, ...rpcArgs).catch((err) => {
              log.error(`start-turn failed for ${harnessId}:`, err);
            });
            return { ok: true };
          } else {
            await bridge.call(harnessId, rpcMethod, ...rpcArgs);
            return { ok: true };
          }
        }

        case "stop": {
          const harnessId = args[0] as string;
          await harnessManager.stop(harnessId);
          return { ok: true };
        }

        case "getStatus": {
          const harnessId = args[0] as string;
          const harness = harnessManager.getHarness(harnessId);
          if (harness) {
            return { status: harness.status, type: harness.type };
          }
          throw new Error("Harness not found");
        }

        default:
          throw new Error(`Unknown harness method: ${method}`);
      }
    },
  };
}
