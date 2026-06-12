/**
 * externalOpen service schema — approval-gated opening of URLs in the host
 * OS browser. The server attaches the handler in
 * src/server/services/externalOpenService.ts. Data types live in
 * `@natstack/shared/externalOpen`; the schema mirrors them type-checked.
 */

import { z } from "zod";
import type { OpenExternalOptions, OpenExternalResult } from "../externalOpen.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const openExternalOptionsSchema = z
  .object({
    expectedRedirectUri: z.string().optional(),
  })
  .strict() satisfies z.ZodType<OpenExternalOptions>;

export const openExternalResultSchema = z.object({
  approvalDecision: z.enum(["once", "session", "version", "repo"]).optional(),
}) satisfies z.ZodType<OpenExternalResult>;

export const externalOpenMethods = defineServiceMethods({
  openExternal: {
    args: z.tuple([z.string(), openExternalOptionsSchema.optional()]),
    returns: openExternalResultSchema,
  },
});
