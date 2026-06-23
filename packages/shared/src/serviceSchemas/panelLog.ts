/**
 * panelLog service method schemas — forwards panel console warnings/errors
 * and lifecycle events from the Electron shell into the server's
 * runtime-diagnostics store. Pure-data wire contract shared by the server
 * registration and typed clients.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// `append` writes the forwarded records into the server's runtime-diagnostics
// store, so it is a write with a log-append side effect.
const APPEND_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const PanelLogRecordSchema = z.object({
  unitSource: z
    .string()
    .describe('Workspace-relative unit source the panel was built from (e.g. "panels/chat").'),
  panelId: z.string().describe("The concrete panel instance the record came from."),
  timestamp: z.number().describe("Epoch milliseconds when the record was produced."),
  level: z.enum(["debug", "info", "warn", "error"]).describe("Severity of the forwarded record."),
  message: z.string().describe("Human-readable log/lifecycle message text."),
  source: z
    .enum(["console", "lifecycle"])
    .describe("Origin of the record: panel console output or a lifecycle event (crash/load fail)."),
  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional structured key/value context attached to the record."),
  url: z.string().optional().describe("URL associated with the console entry, when available."),
  line: z.number().optional().describe("Source line number associated with the entry, when known."),
});

export type PanelLogRecord = z.infer<typeof PanelLogRecordSchema>;

export const panelLogMethods = defineServiceMethods({
  append: {
    description:
      "Forward a batch of panel console/lifecycle records (max 200) from the Electron shell into the server's runtime-diagnostics store.",
    args: z.tuple([z.array(PanelLogRecordSchema).max(200)]),
    returns: z.void(),
    access: APPEND_ACCESS,
    examples: [
      {
        args: [
          [
            {
              unitSource: "panels/chat",
              panelId: "panel-abc123",
              timestamp: 1_700_000_000_000,
              level: "error",
              message: "Uncaught TypeError",
              source: "console",
            },
          ],
        ],
      },
    ],
  },
});
