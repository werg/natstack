/**
 * Wire schema for the "events" subscription service.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const eventsMethods = defineServiceMethods({
  subscribe: { args: z.tuple([z.string()]), returns: z.void() },
  unsubscribe: { args: z.tuple([z.string()]), returns: z.void() },
  unsubscribeAll: { args: z.tuple([]), returns: z.void() },
});
