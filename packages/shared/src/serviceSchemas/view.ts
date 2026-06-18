/**
 * view service method schemas.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const ViewBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ViewBounds = z.infer<typeof ViewBoundsSchema>;

export const ViewPointSchema = z.object({ x: z.number(), y: z.number() });
export type ViewPoint = z.infer<typeof ViewPointSchema>;

const OverlayRangeSchema = z.object({ start: z.number(), end: z.number() });
export const ShellOverlayRowSchema = z.object({
  label: z.string(),
  meta: z.string().optional(),
  labelRanges: z.array(OverlayRangeSchema).optional(),
  metaRanges: z.array(OverlayRangeSchema).optional(),
  icon: z.string().optional(),
  selected: z.boolean().optional(),
  type: z.string(),
  payload: z.unknown().optional(),
});

export const NativePanelSlotSyncResultSchema = z.union([
  z.object({ status: z.enum(["bound", "updated"]) }),
  z.object({ status: z.literal("missing"), reason: z.string() }),
]);
export type NativePanelSlotSyncResult = z.infer<typeof NativePanelSlotSyncResultSchema>;

export const viewMethods = defineServiceMethods({
  setBounds: { args: z.tuple([z.string(), ViewBoundsSchema]), returns: z.void() },
  setVisible: { args: z.tuple([z.string(), z.boolean()]), returns: z.void() },
  forwardMouseClick: { args: z.tuple([z.string(), ViewPointSchema]), returns: z.boolean() },
  setThemeCss: { args: z.tuple([z.string()]), returns: z.void() },
  updateLayout: {
    args: z.tuple([
      z.object({
        titleBarHeight: z.number().optional(),
        sidebarVisible: z.boolean().optional(),
        sidebarWidth: z.number().optional(),
        saveBarHeight: z.number().optional(),
        notificationBarHeight: z.number().optional(),
        consentBarHeight: z.number().optional(),
      }),
    ]),
    returns: z.void(),
  },
  updatePanelViewportBounds: {
    args: z.tuple([ViewBoundsSchema.nullable()]),
    returns: z.void(),
  },
  bindNativePanelSlot: {
    args: z.tuple([
      z.object({
        nativeSlotId: z.string(),
        panelId: z.string(),
        bounds: ViewBoundsSchema,
        focused: z.boolean().optional(),
      }),
    ]),
    returns: NativePanelSlotSyncResultSchema,
  },
  updateNativePanelSlot: {
    args: z.tuple([
      z.object({
        nativeSlotId: z.string(),
        bounds: ViewBoundsSchema.optional(),
        focused: z.boolean().optional(),
      }),
    ]),
    returns: NativePanelSlotSyncResultSchema,
  },
  clearNativePanelSlot: {
    args: z.tuple([z.object({ nativeSlotId: z.string() })]),
    returns: z.void(),
  },
  setHostedShellReady: {
    args: z.tuple([z.object({ ready: z.boolean() })]),
    returns: z.void(),
  },
  setShellOverlay: { args: z.tuple([z.boolean()]), returns: z.void() },
  showNativeShellOverlay: {
    args: z.tuple([
      z.object({
        id: z.string(),
        rows: z.array(ShellOverlayRowSchema),
        empty: z.string(),
        bounds: ViewBoundsSchema,
        focus: z.boolean().optional(),
      }),
    ]),
    returns: z.void(),
  },
  updateNativeShellOverlay: {
    args: z.tuple([
      z.object({
        id: z.string().optional(),
        rows: z.array(ShellOverlayRowSchema).optional(),
        empty: z.string().optional(),
        bounds: ViewBoundsSchema.optional(),
        focus: z.boolean().optional(),
      }),
    ]),
    returns: z.void(),
  },
  hideNativeShellOverlay: { args: z.tuple([z.string().optional()]), returns: z.void() },
  browserNavigate: { args: z.tuple([z.string(), z.string()]), returns: z.void() },
  browserGoBack: { args: z.tuple([z.string()]), returns: z.void() },
  browserGoForward: { args: z.tuple([z.string()]), returns: z.void() },
  browserReload: { args: z.tuple([z.string()]), returns: z.void() },
  browserForceReload: { args: z.tuple([z.string()]), returns: z.void() },
  browserStop: { args: z.tuple([z.string()]), returns: z.void() },
});
