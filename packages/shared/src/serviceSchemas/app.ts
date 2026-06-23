/**
 * Wire schema for the Electron "app" lifecycle service.
 */

import { z } from "zod";
import type { AppInfo, ThemeAppearance, ThemeMode } from "../types.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the app service's read/write method groups.
// `callers` is left unset here (the service-level policy `["shell", "app"]`
// remains the gate); these carry doc/safety metadata for the capability catalog.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const appMethods = defineServiceMethods({
  getInfo: {
    description: "App version plus connection mode/host and current server connection status.",
    args: z.tuple([]),
    returns: z.custom<AppInfo>(),
    access: READ_ACCESS,
    examples: [
      {
        args: [],
        returns: { version: "1.0.0", connectionMode: "local", connectionStatus: "connected" },
      },
    ],
  },
  getSystemTheme: {
    description: "Whether the OS is currently in dark or light appearance.",
    args: z.tuple([]),
    returns: z.enum(["dark", "light"]) satisfies z.ZodType<ThemeAppearance>,
    access: READ_ACCESS,
    examples: [{ args: [], returns: "dark" }],
  },
  setThemeMode: {
    description:
      "Set the app theme source to light, dark, or system (follow OS). Requires the window-management capability.",
    args: z.tuple([z.custom<ThemeMode>()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["dark"] }],
  },
  openDevTools: {
    description:
      "Open Chromium DevTools for the calling app view (or the shell). Requires the window-management capability.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  openExternal: {
    description:
      "Open an http(s) URL in the user's default external browser. Requires the open-external capability; non-http(s) URLs are rejected.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
    examples: [{ args: ["https://example.com"] }],
  },
  openWorkspacePath: {
    description: "Reveal the workspace directory in the OS file manager. Shell-only.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  clearBuildCache: {
    description:
      "Recompute the build graph and invalidate ready panels so they rebuild on next load. Requires the panel-hosting capability.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  getShellPages: {
    description:
      "List the shell's built-in about/info page routes. Requires the panel-hosting capability.",
    args: z.tuple([]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
  },
  applyUpdate: {
    description:
      "Apply a pending build update for the given app id; returns whether an update was applied. Requires shell or a panel-hosting app.",
    args: z.tuple([z.string()]),
    returns: z.object({ applied: z.boolean() }),
    access: WRITE_ACCESS,
    examples: [{ args: ["com.example.app"], returns: { applied: true } }],
  },
  listPendingUpdates: {
    description:
      "List apps with a pending build update, including source/target build keys and versions. Requires shell or a panel-hosting app.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        appId: z.string().describe("Identifier of the app with a pending update."),
        source: z.string().optional().describe("Source build key the update originates from."),
        target: z.string().optional().describe("Target build key the update moves to."),
        url: z.string().describe("Location of the pending update artifact."),
        buildKey: z
          .string()
          .nullable()
          .optional()
          .describe("Build key the update would install, if known."),
        effectiveVersion: z
          .string()
          .nullable()
          .optional()
          .describe("Effective version after applying the update, if known."),
        previousBuildKey: z
          .string()
          .nullable()
          .optional()
          .describe("Build key currently installed, if known."),
        previousEffectiveVersion: z
          .string()
          .nullable()
          .optional()
          .describe("Effective version currently installed, if known."),
      })
    ),
    access: READ_ACCESS,
  },
});
