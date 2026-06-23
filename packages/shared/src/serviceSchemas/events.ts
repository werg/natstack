/**
 * Wire schema for the "events" subscription service.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the events methods. The service-level
// `policy` on the registration stays the enforced caller gate (we omit
// `access.callers` here); these carry the doc/safety metadata the read-only
// gate and capability catalog read. Subscription bookkeeping mutates the
// caller's server-side subscriber table, so subscribe/unsubscribe are writes.
const SUBSCRIBE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const UNSUBSCRIBE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const eventsMethods = defineServiceMethods({
  subscribe: {
    description:
      "Subscribe this caller's connection to a named event so future emits are delivered over the transport; immediately replays the current snapshot if the server has one.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: SUBSCRIBE_ACCESS,
    examples: [{ args: ["panel-tree-updated"] }],
  },
  unsubscribe: {
    description:
      "Stop delivering a single named event to this caller's connection; a no-op if it was not subscribed.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: UNSUBSCRIBE_ACCESS,
    examples: [{ args: ["panel-tree-updated"] }],
  },
  unsubscribeAll: {
    description:
      "Remove this caller's connection from every event subscription it currently holds.",
    args: z.tuple([]),
    returns: z.void(),
    access: UNSUBSCRIBE_ACCESS,
  },
});
