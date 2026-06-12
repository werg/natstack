/**
 * panel service method schemas.
 */

import { z } from "zod";
import type {
  GetChildrenPaginatedRequest,
  MovePanelRequest,
  PaginatedChildren,
  PaginatedRootPanels,
  Panel,
  PanelFocusResult,
  PanelLifecycleResult,
  PanelNavigationState,
  PanelTreeSnapshot,
  ThemeAppearance,
} from "../types.js";
import type { PanelRuntimeLease } from "../panel/panelLease.js";
import type {
  BrowserAddressOptions,
  PanelAddressOptions,
  PanelChromeState,
} from "../panelChrome.js";
import { BROWSER_NAVIGATION_TRANSITIONS } from "../panelCommands.js";
import { defineServiceMethods } from "../typedServiceClient.js";

const PanelIdSchema = z.string();
const CreateResultSchema = z.object({ id: z.string(), title: z.string() });

export const PanelCreateOptionsSchema = z
  .object({
    name: z.string().optional(),
    isRoot: z.boolean().optional(),
    ref: z.string().optional(),
  })
  .optional();

export const PanelCreateChildOptionsSchema = z
  .object({
    name: z.string().optional(),
    focus: z.boolean().optional(),
    ref: z.string().optional(),
  })
  .optional();

export const PanelNavigateOptionsSchema = z
  .object({
    ref: z.string().optional(),
    contextId: z.string().optional(),
    stateArgs: z.record(z.unknown()).optional(),
  })
  .optional();

export const BrowserNavigationIntentSchema = z.object({
  transition: z.enum(BROWSER_NAVIGATION_TRANSITIONS).optional(),
  typed: z.boolean().optional(),
});

export const panelMethods = defineServiceMethods({
  loadTree: {
    args: z.tuple([]),
    returns: z.object({
      rootPanels: z.array(z.custom<Panel>()),
      collapsedIds: z.array(z.string()),
    }),
  },
  getTree: { args: z.tuple([]), returns: z.array(z.custom<Panel>()) },
  getTreeSnapshot: { args: z.tuple([]), returns: z.custom<PanelTreeSnapshot>() },
  getFocusedPanelId: { args: z.tuple([]), returns: z.string().nullable() },
  notifyFocused: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelFocusResult>() },
  updateTheme: { args: z.tuple([z.custom<ThemeAppearance>()]), returns: z.void() },
  openDevTools: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  getChromeState: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelChromeState>() },
  getRuntimeLease: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelRuntimeLease>().nullable() },
  takeOver: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  getAddressOptions: {
    args: z.tuple([z.string(), z.string().optional()]),
    returns: z.custom<PanelAddressOptions>(),
  },
  getBrowserAddressOptions: {
    args: z.tuple([z.string()]),
    returns: z.custom<BrowserAddressOptions>(),
  },
  markBrowserNavigationIntent: {
    args: z.tuple([PanelIdSchema, BrowserNavigationIntentSchema]),
    returns: z.void(),
  },
  reload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  reloadView: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  forceReloadView: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  rebuildPanel: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  rebuildAndReload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  goBack: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  goForward: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  unload: { args: z.tuple([PanelIdSchema]), returns: z.custom<PanelLifecycleResult>() },
  archive: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  initGitRepo: { args: z.tuple([PanelIdSchema]), returns: z.void() },
  updatePanelState: {
    args: z.tuple([PanelIdSchema, z.custom<PanelNavigationState>()]),
    returns: z.void(),
  },
  createAboutPanel: { args: z.tuple([z.string()]), returns: CreateResultSchema },
  navigate: {
    args: z.tuple([PanelIdSchema, z.string(), PanelNavigateOptionsSchema]),
    returns: CreateResultSchema,
  },
  create: {
    args: z.tuple([z.string(), PanelCreateOptionsSchema]),
    returns: CreateResultSchema,
  },
  createChild: {
    args: z.tuple([PanelIdSchema, z.string(), PanelCreateChildOptionsSchema]),
    returns: CreateResultSchema,
  },
  createBrowser: {
    args: z.tuple([
      z.string(),
      z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional(),
    ]),
    returns: CreateResultSchema,
  },
  createBrowserChild: {
    args: z.tuple([
      PanelIdSchema,
      z.string(),
      z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional(),
    ]),
    returns: CreateResultSchema,
  },
  movePanel: {
    args: z.tuple([z.custom<MovePanelRequest>()]),
    returns: z.void(),
  },
  getChildrenPaginated: {
    args: z.tuple([z.custom<GetChildrenPaginatedRequest>()]),
    returns: z.custom<PaginatedChildren>(),
  },
  getRootPanelsPaginated: {
    args: z.tuple([z.object({ offset: z.number(), limit: z.number() })]),
    returns: z.custom<PaginatedRootPanels>(),
  },
  getCollapsedIds: { args: z.tuple([]), returns: z.array(z.string()) },
  setCollapsed: { args: z.tuple([PanelIdSchema, z.boolean()]), returns: z.void() },
  expandIds: { args: z.tuple([z.array(PanelIdSchema)]), returns: z.void() },
});
