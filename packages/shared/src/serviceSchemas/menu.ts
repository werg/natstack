/**
 * menu service method schemas.
 */

import { z } from "zod";
import type { PanelContextMenuAction } from "../types.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const MenuPositionSchema = z.object({ x: z.number(), y: z.number() });
export type MenuPosition = z.infer<typeof MenuPositionSchema>;

export const MenuItemSchema = z.object({ id: z.string(), label: z.string() });
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
  showHamburger: { args: z.tuple([MenuPositionSchema]), returns: z.void() },
  showContext: {
    args: z.tuple([z.array(MenuItemSchema), MenuPositionSchema]),
    returns: z.string().nullable(),
  },
  showPanelContext: {
    args: z.tuple([z.string(), MenuPositionSchema]),
    returns: PanelContextMenuActionSchema.nullable(),
  },
});
