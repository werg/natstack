/**
 * workerLog — forwards `console.*` output from worker DOs to the server
 * terminal.
 *
 * Why: workerd's native console routing does not reliably surface DO
 * `console.log`/`console.warn`/`console.error` to the embedding process's
 * stdout/stderr in our setup. That makes every swallowed error inside a DO
 * invisible during development — the most common way the agentic stack
 * silently stalls.
 *
 * How: `DurableObjectBase` installs a console proxy that, in addition to
 * calling the original console, fires a fire-and-forget `workerLog.write`
 * RPC to the server. This service logs through `dev-log` with the caller's
 * DO identity as the prefix, so logs appear in the main terminal as:
 *   [server] [workerLog] [do:workers/pubsub-channel:PubSubChannel:ctx-…] warn: <message>
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("workerLog");

type Level = "log" | "info" | "warn" | "error";

export function createWorkerLogService(): ServiceDefinition {
  return {
    name: "workerLog",
    description: "Forward DO console output to the server terminal",
    policy: { allowed: ["shell", "panel", "server", "worker"] },
    methods: {
      write: {
        args: z.tuple([
          z.enum(["log", "info", "warn", "error"]),
          z.string(),
        ]),
      },
    },
    handler: async (ctx, method, args) => {
      if (method !== "write") throw new Error(`Unknown method: ${method}`);
      const [level, message] = args as [Level, string];
      const prefix = `[${ctx.callerId}]`;
      switch (level) {
        case "error": log.error(`${prefix} ${message}`); break;
        case "warn": log.warn(`${prefix} ${message}`); break;
        case "info": log.info(`${prefix} ${message}`); break;
        case "log":
        default: log.info(`${prefix} ${message}`); break;
      }
      return undefined;
    },
  };
}
