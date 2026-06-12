/**
 * autofill service method schemas.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const autofillMethods = defineServiceMethods({
  confirmSave: {
    args: z.tuple([z.string(), z.enum(["save", "never", "dismiss"])]),
    returns: z.void(),
  },
});
