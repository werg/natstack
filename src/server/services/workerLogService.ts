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

export interface WorkerLogRecord {
  /** Worker source path (e.g. "workers/pubsub-channel"). May be null if unparseable. */
  source: string | null;
  /** Full caller id ("do:workers/foo:Klass:ctx-…" or a regular worker id). */
  callerId: string;
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface WorkerLogServiceDeps {
  /**
   * Optional structured-log sink. Called for every worker-emitted record in
   * addition to terminal logging. The server uses this to populate
   * `workspace.units.logs` with worker output.
   */
  onLog?: (record: WorkerLogRecord) => void;
}

/**
 * Parse the owning worker source out of a caller id.
 *
 * DO callers look like `do:workers/<source>:<Klass>:<ctx>`; regular worker
 * instances use names sanitized from their source. Both have the source as
 * the second `/`-delimited segment when present.
 */
export function workerSourceFromCallerId(callerId: string): string | null {
  if (callerId.startsWith("do:")) {
    const rest = callerId.slice(3);
    const firstColon = rest.indexOf(":");
    const sourcePart = firstColon === -1 ? rest : rest.slice(0, firstColon);
    return sourcePart || null;
  }
  // Regular workers register as `worker:<name>` in some paths or just `<name>`.
  // We don't have a precise inverse of the canonicalization, so the caller
  // id is the best label we have here.
  return null;
}

export function createWorkerLogService(deps: WorkerLogServiceDeps = {}): ServiceDefinition {
  return {
    name: "workerLog",
    description: "Forward DO console output to the server terminal and the workspace-unit log stream",
    policy: { allowed: ["shell", "panel", "server", "worker", "extension"] },
    methods: {
      write: {
        args: z.tuple([z.enum(["log", "info", "warn", "error"]), z.string()]),
      },
    },
    handler: async (ctx, method, args) => {
      if (method !== "write") throw new Error(`Unknown method: ${method}`);
      const [level, message] = args as [Level, string];
      const prefix = `[${ctx.callerId}]`;
      const normalizedLevel: WorkerLogRecord["level"] = level === "log" ? "info" : level;
      switch (level) {
        case "error":
          log.error(`${prefix} ${message}`);
          break;
        case "warn":
          log.warn(`${prefix} ${message}`);
          break;
        case "info":
        case "log":
        default:
          log.info(`${prefix} ${message}`);
          break;
      }
      deps.onLog?.({
        source: workerSourceFromCallerId(ctx.callerId),
        callerId: ctx.callerId,
        timestamp: Date.now(),
        level: normalizedLevel,
        message,
      });
      return undefined;
    },
  };
}
