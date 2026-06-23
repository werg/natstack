/**
 * settings service method schemas.
 */

import { z } from "zod";
import type { SettingsData } from "../types.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Pure read of the resolved settings/model-role config; touches no persistent
// state. The service-level `policy` remains the enforced caller gate (we omit
// `access.callers` here).
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const settingsMethods = defineServiceMethods({
  getData: {
    description:
      "Return the resolved settings snapshot, including the central-config model-role map (role → 'provider:model' string).",
    args: z.tuple([]),
    returns: z.custom<SettingsData>(),
    access: READ_ACCESS,
  },
});
