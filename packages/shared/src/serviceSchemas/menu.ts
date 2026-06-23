/**
 * menu service method schemas.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import type { PanelContextMenuAction } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Popping a native menu is a UI side effect (and the showContext/showPanelContext
// variants resolve once the user picks an item), so these are write-sensitivity
// with a `show-menu` side effect rather than `readonly`.
const SHOW_MENU_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const MenuPositionSchema = z.object({
  x: z.number().describe("Screen/window x coordinate where the menu should pop up."),
  y: z.number().describe("Screen/window y coordinate where the menu should pop up."),
});
export type MenuPosition = z.infer<typeof MenuPositionSchema>;

export const MenuItemSchema = z.object({
  id: z.string().describe("Stable identifier returned when this item is selected."),
  label: z.string().describe("Visible text for the menu item."),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

const PanelContextMenuActionSchema = z.enum([
  "reload",
  "reload-panel",
  "reload-view",
  "force-reload",
  "force-reload-view",
  "rebuild-panel",
  "stop",
  "back",
  "forward",
  "copy-address",
  "copy-panel-id",
  "open-external",
  "duplicate",
  "add-child",
  "unload",
  "archive",
]) satisfies z.ZodType<PanelContextMenuAction>;

export const menuMethods = defineServiceMethods({
  showHamburger: {
    description: "Pop up the application hamburger menu at the given position.",
    args: z.tuple([MenuPositionSchema]),
    returns: z.void(),
    access: SHOW_MENU_ACCESS,
    examples: [{ args: [{ x: 12, y: 40 }] }],
  },
  showContext: {
    description:
      "Pop up a context menu built from the given items at the position; resolves with the selected item's id, or null if dismissed.",
    args: z.tuple([z.array(MenuItemSchema), MenuPositionSchema]),
    returns: z.string().nullable(),
    access: SHOW_MENU_ACCESS,
    examples: [
      {
        args: [
          [
            { id: "copy", label: "Copy" },
            { id: "paste", label: "Paste" },
          ],
          { x: 100, y: 200 },
        ],
      },
    ],
  },
  showPanelContext: {
    description:
      "Pop up the per-panel context menu (back/reload/duplicate/archive/etc.) for the given panel; resolves with the chosen panel action, or null if dismissed.",
    args: z.tuple([z.string(), MenuPositionSchema]),
    returns: PanelContextMenuActionSchema.nullable(),
    access: SHOW_MENU_ACCESS,
    examples: [{ args: ["panel-abc123", { x: 100, y: 200 }] }],
  },
});
