/**
 * Bridge service method schemas — shared between Electron and headless modes.
 * Single source of truth for bridge method argument validation.
 */

import { z } from "zod";

export const BRIDGE_METHOD_SCHEMAS = {
  closeSelf: { args: z.tuple([]) },
  getInfo: { args: z.tuple([]) },
  setStateArgs: { args: z.tuple([z.record(z.unknown())]) },
  focusPanel: { args: z.tuple([z.string().optional()]) },
  getBootstrapConfig: { args: z.tuple([]) },
  getWorkspaceTree: { args: z.tuple([]) },
  listBranches: { args: z.tuple([z.string()]) },
  listCommits: { args: z.tuple([z.string(), z.string().optional(), z.number().optional()]) },
  openDevtools: { args: z.tuple([]) },
  openFolderDialog: { args: z.tuple([z.object({ title: z.string().optional() }).optional()]) },
  createBrowserPanel: { args: z.tuple([z.string(), z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional()]) },
  closeChild: { args: z.tuple([z.string()]) },
  openExternal: { args: z.tuple([z.string()]) },
  createRepo: { args: z.tuple([z.string()]) },
} as const;
