/**
 * Wire schema for the Electron "app" lifecycle service.
 */

import { z } from "zod";
import type { AppInfo, ThemeAppearance, ThemeMode } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const appMethods = defineServiceMethods({
  getInfo: { args: z.tuple([]), returns: z.custom<AppInfo>() },
  getSystemTheme: { args: z.tuple([]), returns: z.enum(["dark", "light"]) satisfies z.ZodType<ThemeAppearance> },
  setThemeMode: { args: z.tuple([z.custom<ThemeMode>()]), returns: z.void() },
  openDevTools: { args: z.tuple([]), returns: z.void() },
  openExternal: { args: z.tuple([z.string()]), returns: z.void() },
  openWorkspacePath: { args: z.tuple([]), returns: z.void() },
  clearBuildCache: { args: z.tuple([]), returns: z.void() },
  getShellPages: { args: z.tuple([]), returns: z.array(z.string()) },
  applyUpdate: {
    args: z.tuple([z.string()]),
    returns: z.object({ applied: z.boolean() }),
  },
  listPendingUpdates: {
    args: z.tuple([]),
    returns: z.array(
      z.object({
        appId: z.string(),
        source: z.string().optional(),
        target: z.string().optional(),
        url: z.string(),
        buildKey: z.string().nullable().optional(),
        effectiveVersion: z.string().nullable().optional(),
        previousBuildKey: z.string().nullable().optional(),
        previousEffectiveVersion: z.string().nullable().optional(),
      })
    ),
  },
});
