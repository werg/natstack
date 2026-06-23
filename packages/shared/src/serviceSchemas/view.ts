/**
 * view service method schemas — control of native Electron views (bounds,
 * visibility, theme CSS, browser navigation, and native panel/shell-overlay
 * slots). Pure-data wire contract shared by the server registration and typed
 * clients.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

// Access descriptors shared across the view method groups. `callers` mirror the
// service policy (`["shell", "app"]`); the `policy` field is left unchanged so
// it remains the enforced gate. Almost every method mutates native window/view
// state, so these carry `sensitivity: "write"`.

const VIEW_BOUNDS_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_VISIBILITY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_INPUT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_THEME_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_SLOT_BIND_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_SLOT_CLEAR_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_SHELL_READY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_TOGGLE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_SHOW_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_OVERLAY_HIDE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_NAVIGATE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_NAV_HISTORY_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_RELOAD_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const VIEW_STOP_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const ViewBoundsSchema = z.object({
  x: z.number().describe("Left edge in window-relative pixels."),
  y: z.number().describe("Top edge in window-relative pixels."),
  width: z.number().describe("View width in pixels."),
  height: z.number().describe("View height in pixels."),
});
export type ViewBounds = z.infer<typeof ViewBoundsSchema>;

export const ViewPointSchema = z.object({
  x: z.number().describe("X coordinate in window-relative pixels."),
  y: z.number().describe("Y coordinate in window-relative pixels."),
});
export type ViewPoint = z.infer<typeof ViewPointSchema>;

const OverlayRangeSchema = z.object({
  start: z.number().describe("Inclusive start index of the highlighted range."),
  end: z.number().describe("Exclusive end index of the highlighted range."),
});
export const ShellOverlayRowSchema = z.object({
  label: z.string().describe("Primary text shown for the row."),
  meta: z.string().optional().describe("Secondary/detail text shown alongside the label."),
  labelRanges: z
    .array(OverlayRangeSchema)
    .optional()
    .describe("Character ranges within `label` to highlight (e.g. fuzzy-match hits)."),
  metaRanges: z
    .array(OverlayRangeSchema)
    .optional()
    .describe("Character ranges within `meta` to highlight."),
  icon: z.string().optional().describe("Optional icon identifier rendered before the label."),
  selected: z.boolean().optional().describe("Whether this row is the currently selected one."),
  type: z.string().describe("Row kind used by the shell to route activation/payload handling."),
  payload: z.unknown().optional().describe("Opaque data passed back when the row is activated."),
});

export const NativePanelSlotSyncResultSchema = z.union([
  z.object({ status: z.enum(["bound", "updated"]) }),
  z.object({ status: z.literal("missing"), reason: z.string() }),
]);
export type NativePanelSlotSyncResult = z.infer<typeof NativePanelSlotSyncResultSchema>;

export const viewMethods = defineServiceMethods({
  setBounds: {
    description: "Reposition and resize a native view to the given window-relative pixel bounds.",
    args: z.tuple([z.string(), ViewBoundsSchema]),
    returns: z.void(),
    access: VIEW_BOUNDS_ACCESS,
    examples: [{ args: ["view-123", { x: 0, y: 48, width: 800, height: 600 }] }],
  },
  setVisible: {
    description: "Show or hide a native view without changing its bounds.",
    args: z.tuple([z.string(), z.boolean()]),
    returns: z.void(),
    access: VIEW_VISIBILITY_ACCESS,
    examples: [{ args: ["view-123", true] }],
  },
  forwardMouseClick: {
    description:
      "Synthesize a left mouse click at a window-relative point inside a view, focusing it; returns false if the point falls outside the view's bounds or the view is gone.",
    args: z.tuple([z.string(), ViewPointSchema]),
    returns: z.boolean(),
    access: VIEW_INPUT_ACCESS,
    examples: [{ args: ["view-123", { x: 120, y: 80 }], returns: true }],
  },
  setThemeCss: {
    description: "Apply a global theme CSS string injected into hosted views.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_THEME_ACCESS,
  },
  bindNativePanelSlot: {
    description:
      "Bind a panel into a native slot owned by the calling host view at the given bounds; returns the slot sync status.",
    args: z.tuple([
      z.object({
        nativeSlotId: z.string().describe("Caller-chosen identifier for the native slot."),
        panelId: z.string().describe("Panel to place into the slot."),
        bounds: ViewBoundsSchema.describe("Window-relative bounds the panel should occupy."),
        focused: z.boolean().optional().describe("Whether the slot should receive focus."),
      }),
    ]),
    returns: NativePanelSlotSyncResultSchema,
    access: VIEW_SLOT_BIND_ACCESS,
    examples: [
      {
        args: [
          {
            nativeSlotId: "slot-main",
            panelId: "panel-chat",
            bounds: { x: 0, y: 0, width: 400, height: 600 },
          },
        ],
      },
    ],
  },
  updateNativePanelSlot: {
    description:
      "Update the bounds and/or focus of an already-bound native panel slot; returns the slot sync status.",
    args: z.tuple([
      z.object({
        nativeSlotId: z.string().describe("Identifier of the previously bound native slot."),
        bounds: ViewBoundsSchema.optional().describe("New window-relative bounds, if changing."),
        focused: z.boolean().optional().describe("New focus state, if changing."),
      }),
    ]),
    returns: NativePanelSlotSyncResultSchema,
    access: VIEW_SLOT_BIND_ACCESS,
  },
  clearNativePanelSlot: {
    description: "Unbind and remove a native panel slot owned by the calling host view.",
    args: z.tuple([
      z.object({
        nativeSlotId: z.string().describe("Identifier of the native slot to clear."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_SLOT_CLEAR_ACCESS,
  },
  setHostedShellReady: {
    description:
      "Mark the caller's hosted shell as ready (or not), which gates whether its owner view is shown.",
    args: z.tuple([
      z.object({
        ready: z.boolean().describe("Whether the hosted shell has finished loading."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_SHELL_READY_ACCESS,
  },
  setShellOverlay: {
    description: "Activate or deactivate the shell overlay layer.",
    args: z.tuple([z.boolean()]),
    returns: z.void(),
    access: VIEW_OVERLAY_TOGGLE_ACCESS,
  },
  showNativeShellOverlay: {
    description:
      "Show a native shell overlay (e.g. a command palette/list) with the given rows at the supplied bounds.",
    args: z.tuple([
      z.object({
        id: z.string().describe("Overlay instance identifier."),
        rows: z.array(ShellOverlayRowSchema).describe("Rows to render in the overlay list."),
        empty: z.string().describe("Text shown when there are no rows."),
        bounds: ViewBoundsSchema.describe("Window-relative bounds for the overlay."),
        focus: z.boolean().optional().describe("Whether the overlay should grab focus."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  updateNativeShellOverlay: {
    description:
      "Update an already-shown native shell overlay; every field is optional, so only the provided properties change.",
    args: z.tuple([
      z.object({
        id: z.string().optional().describe("Overlay instance identifier, if retargeting."),
        rows: z.array(ShellOverlayRowSchema).optional().describe("Replacement rows, if changing."),
        empty: z.string().optional().describe("Replacement empty-state text, if changing."),
        bounds: ViewBoundsSchema.optional().describe("New window-relative bounds, if changing."),
        focus: z.boolean().optional().describe("New focus state, if changing."),
      }),
    ]),
    returns: z.void(),
    access: VIEW_OVERLAY_SHOW_ACCESS,
  },
  hideNativeShellOverlay: {
    description:
      "Hide a native shell overlay, optionally identified by id; omit the id to hide the active overlay.",
    args: z.tuple([z.string().optional()]),
    returns: z.void(),
    access: VIEW_OVERLAY_HIDE_ACCESS,
  },
  browserNavigate: {
    description:
      "Navigate a browser view to an http(s) URL (rejected if the URL is not http/https).",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    access: VIEW_NAVIGATE_ACCESS,
    examples: [{ args: ["browser-1", "https://example.com"] }],
  },
  browserGoBack: {
    description: "Navigate a browser view back one entry in its history.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_NAV_HISTORY_ACCESS,
  },
  browserGoForward: {
    description: "Navigate a browser view forward one entry in its history.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_NAV_HISTORY_ACCESS,
  },
  browserReload: {
    description: "Reload a browser view.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_RELOAD_ACCESS,
  },
  browserForceReload: {
    description: "Reload a browser view bypassing the cache.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_RELOAD_ACCESS,
  },
  browserStop: {
    description: "Stop any in-progress load in a browser view.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: VIEW_STOP_ACCESS,
  },
});
