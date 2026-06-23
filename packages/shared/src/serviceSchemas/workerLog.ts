/**
 * workerLog service method schemas — forwards `console.*` output from worker
 * DOs to the server terminal. Pure-data wire contract shared by the server
 * registration and typed clients.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// `write` appends a console record to the server terminal and the
// workspace-unit log stream, so it is a write with a log-append side effect.
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const workerLogMethods = defineServiceMethods({
  write: {
    description:
      "Forward one DO console line (level + message, plus optional source) to the server terminal and the workspace-unit log stream.",
    args: z.tuple([
      z.enum(["log", "info", "warn", "error"]),
      z.string(),
      z
        .object({
          source: z
            .string()
            .optional()
            .describe('Worker source path label (e.g. "workers/example-store").'),
        })
        .optional(),
    ]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["warn", "DO turn stalled", { source: "workers/example-store" }] }],
  },
});
