/**
 * Bridge service method schemas — shared between Electron and headless modes.
 * Single source of truth for bridge method argument validation.
 *
 * Split into two groups:
 * - SERVER_BRIDGE_METHODS: data/persistence ops routed to the server
 * - ELECTRON_BRIDGE_METHODS: host UI ops handled via __natstackElectron IPC
 */

import { z } from "zod";

/**
 * Server-side bridge methods (data/persistence — handled by server bridge service).
 * These work in both Electron and standalone modes.
 */
export const SERVER_BRIDGE_METHODS = {
  closeSelf: { args: z.tuple([]) },
  closeChild: { args: z.tuple([z.string()]) },
  getInfo: { args: z.tuple([]) },
  setStateArgs: { args: z.tuple([z.record(z.unknown())]) },
  focusPanel: { args: z.tuple([z.string().optional()]) },
  getBootstrapConfig: { args: z.tuple([]) },
  getWorkspaceTree: { args: z.tuple([]) },
  listBranches: { args: z.tuple([z.string()]) },
  listCommits: { args: z.tuple([z.string(), z.string().optional(), z.number().optional()]) },
  createBrowserPanel: { args: z.tuple([z.string(), z.object({ name: z.string().optional(), focus: z.boolean().optional() }).optional()]) },
  createRepo: { args: z.tuple([z.string()]) },
  openExternal: { args: z.tuple([z.string()]) },
} as const;

/**
 * Electron-side bridge methods (host UI — handled via __natstackElectron IPC).
 * These are only available when running inside Electron.
 */
export const ELECTRON_BRIDGE_METHODS = {
  openDevtools: { args: z.tuple([]) },
  openFolderDialog: { args: z.tuple([z.object({ title: z.string().optional() }).optional()]) },
} as const;

/**
 * Combined schemas for backward compatibility.
 * Used by services that validate all bridge methods.
 */
export const BRIDGE_METHOD_SCHEMAS = {
  ...SERVER_BRIDGE_METHODS,
  ...ELECTRON_BRIDGE_METHODS,
} as const;
