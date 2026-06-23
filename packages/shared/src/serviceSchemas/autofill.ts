/**
 * autofill service method schemas.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// `confirmSave` resolves a pending save/update prompt: "save" persists the
// credential, "never" suppresses saves for the origin, "dismiss" snoozes it.
// All three mutate stored autofill state, so it is a write side effect.
const CONFIRM_SAVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const autofillMethods = defineServiceMethods({
  confirmSave: {
    description:
      "Resolve a pending password save/update prompt for a panel: 'save' stores the credential, 'never' permanently suppresses saves for its origin, 'dismiss' snoozes the prompt.",
    args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
    returns: z.void(),
    access: CONFIRM_SAVE_ACCESS,
    examples: [{ args: ["panel-abc123", "save"] }],
  },
});
