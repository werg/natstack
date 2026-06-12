/**
 * panelLog service method schemas — forwards panel console warnings/errors
 * and lifecycle events from the Electron shell into the server's
 * runtime-diagnostics store. Pure-data wire contract shared by the server
 * registration and typed clients.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const PanelLogRecordSchema = z.object({
  /** Workspace-relative unit source (e.g. "panels/chat"). */
  unitSource: z.string(),
  /** The concrete panel instance the record came from. */
  panelId: z.string(),
  timestamp: z.number(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  source: z.enum(["console", "lifecycle"]),
  fields: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional(),
  line: z.number().optional(),
});

export type PanelLogRecord = z.infer<typeof PanelLogRecordSchema>;

export const panelLogMethods = defineServiceMethods({
  append: {
    args: z.tuple([z.array(PanelLogRecordSchema).max(200)]),
    returns: z.void(),
  },
});
