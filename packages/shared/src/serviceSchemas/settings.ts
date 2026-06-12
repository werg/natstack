/**
 * settings service method schemas.
 */

import { z } from "zod";
import type { SettingsData } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const settingsMethods = defineServiceMethods({
  getData: {
    args: z.tuple([]),
    returns: z.custom<SettingsData>(),
  },
});
