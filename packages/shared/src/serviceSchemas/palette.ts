/**
 * palette service method schemas — the app-level command palette bridge.
 *
 * Panels `register` their contributed commands (keyed by the calling panel id);
 * the shell `list`s the contributions and `run`s a chosen one, which the main
 * process dispatches back to the owning panel via `runtime:palette-run`.
 */

import { z } from "zod";
import type { PaletteCommand } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";

const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const WRITE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const paletteMethods = defineServiceMethods({
  register: {
    description:
      "Register or replace the calling panel/app's contributed command-palette commands.",
    args: z.tuple([z.array(z.custom<PaletteCommand>())]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  unregister: {
    description: "Remove all command-palette contributions owned by the calling panel/app.",
    args: z.tuple([]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
  list: {
    description: "List panel/app command-palette contributions visible to the chrome shell.",
    args: z.tuple([]),
    returns: z.custom<Array<{ panelId: string; commands: PaletteCommand[] }>>(),
    access: READ_ACCESS,
  },
  run: {
    description: "Dispatch a selected command-palette command back to its owning panel/app.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: WRITE_ACCESS,
  },
});
