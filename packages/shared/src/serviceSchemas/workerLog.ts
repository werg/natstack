/**
 * workerLog service method schemas — forwards `console.*` output from worker
 * DOs to the server terminal. Pure-data wire contract shared by the server
 * registration and typed clients.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const workerLogMethods = defineServiceMethods({
  write: {
    args: z.tuple([
      z.enum(["log", "info", "warn", "error"]),
      z.string(),
      z.object({ source: z.string().optional() }).optional(),
    ]),
    returns: z.void(),
  },
});
