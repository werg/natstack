/**
 * tokens service method schemas.
 */

import { z } from "zod";
import type { CallerKind } from "../serviceDispatcher.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const tokensMethods = defineServiceMethods({
  create: { args: z.tuple([z.string(), z.custom<CallerKind>()]), returns: z.string() },
  ensure: { args: z.tuple([z.string(), z.custom<CallerKind>()]), returns: z.string() },
  revoke: { args: z.tuple([z.string()]), returns: z.void() },
  get: { args: z.tuple([z.string()]), returns: z.string().nullable() },
  rotateAdmin: { args: z.tuple([]), returns: z.string() },
});
