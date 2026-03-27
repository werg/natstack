/**
 * Server-side Panel Service — backend panel orchestration.
 *
 * Single writer to SQLite persistence. Handles: create, close, state
 * mutations, tree operations. Electron's PanelRegistry is a read-only
 * in-memory cache that mirrors this service's state.
 */

import * as path from "path";
import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { PanelPersistence } from "../../shared/db/panelPersistence.js";
import type { PanelSearchIndex } from "../../shared/db/panelSearchIndex.js";
import type { TokenManager } from "../../shared/tokenManager.js";
import type { FsService } from "../../shared/fsService.js";
import type { GitServer } from "@natstack/git-server";
import type { PanelManifest } from "../../shared/types.js";
import { loadPanelManifest } from "../../shared/panelTypes.js";
import { validateStateArgs } from "../../shared/stateArgsValidator.js";
import { computePanelId } from "../../shared/panelIdUtils.js";
import {
  resolveSource,
  generateContextId,
  browserSourceFromHostname,
  buildPanelEnv,
  type PanelCreateResult,
} from "../../shared/panelFactory.js";
import { createSnapshot, getPanelSource, getPanelContextId, getPanelStateArgs } from "../../shared/panel/accessors.js";

/**
 * Mutable URL config for panel-facing endpoints.
 * In IPC mode, values are set once at creation. In standalone mode,
 * `setGatewayPort()` updates URLs after the gateway binds.
 */
export class PanelUrlConfig {
  protocol: "http" | "https";
  externalHost: string;
  private _gitBaseUrl: string;
  private _pubsubBaseUrl: string;
  private _gatewayPort: number;

  constructor(opts: { protocol: "http" | "https"; externalHost: string; gitBaseUrl: string; pubsubBaseUrl: string; gatewayPort: number }) {
    this.protocol = opts.protocol;
    this.externalHost = opts.externalHost;
    this._gitBaseUrl = opts.gitBaseUrl;
    this._pubsubBaseUrl = opts.pubsubBaseUrl;
    this._gatewayPort = opts.gatewayPort;
  }

  get gitBaseUrl() { return this._gitBaseUrl; }
  get pubsubBaseUrl() { return this._pubsubBaseUrl; }
  get gatewayPort() { return this._gatewayPort; }

  /** Update URLs to route through the gateway (called after gateway.start()). */
  setGatewayPort(port: number): void {
    const wsProto = this.protocol === "https" ? "wss" : "ws";
    this._gatewayPort = port;
    this._gitBaseUrl = `${this.protocol}://${this.externalHost}:${port}/_git`;
    this._pubsubBaseUrl = `${wsProto}://default.${this.externalHost}:${port}`;
  }
}

export interface PanelServiceDeps {
  persistence: PanelPersistence;
  searchIndex: PanelSearchIndex | null;
  tokenManager: TokenManager;
  fsService: FsService;
  gitServer: GitServer;
  workspacePath: string;
  /** Live RPC port getter — returns gateway port in standalone mode. */
  getRpcPort: () => number;
  workerdPort: number;
  /** Mutable URL config — reads are late-bound so gateway port updates propagate. */
  urlConfig: PanelUrlConfig;
}

export function createPanelService(deps: PanelServiceDeps): ServiceDefinition {
  const {
    persistence, searchIndex, tokenManager, fsService,
    gitServer, workspacePath, getRpcPort, workerdPort,
    urlConfig,
  } = deps;

  // Internal helpers

  function resolveManifest(
    absolutePath: string,
    relativePath: string,
    allowMissing: boolean,
  ): PanelManifest {
    try {
      return loadPanelManifest(absolutePath);
    } catch (error) {
      if (allowMissing) {
        return { title: path.basename(relativePath) };
      }
      throw new Error(
        `Failed to load manifest for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function persistAndIndex(
    panelId: string,
    title: string,
    parentId: string | null,
    snapshot: ReturnType<typeof createSnapshot>,
  ): void {
    persistence.createPanel({ id: panelId, title, parentId, snapshot });

    if (parentId) {
      persistence.setSelectedChild(parentId, panelId);
    }

    if (searchIndex) {
      try {
        searchIndex.indexPanel({ id: panelId, title, path: snapshot.source });
      } catch (err) {
        console.error(`[PanelService] Failed to index panel ${panelId}:`, err);
      }
    }
  }

  /** Archive childless panels with autoArchiveWhenEmpty (e.g., unused launcher UIs). */
  function cleanupChildlessAutoArchivePanels(
    panels: import("../../shared/types.js").Panel[],
    persist: PanelPersistence,
  ): void {
    for (const panel of panels) {
      if (panel.children.length > 0) {
        cleanupChildlessAutoArchivePanels(panel.children, persist);
        panel.children = panel.children.filter(c => !persist.isArchived(c.id));
      }
      if (panel.snapshot.autoArchiveWhenEmpty && panel.children.length === 0) {
        try { persist.archivePanel(panel.id); }
        catch (e) { console.error(`[PanelService] Failed to archive panel ${panel.id}:`, e); }
      }
    }
  }

  /** Collect panelId + all descendant IDs from the DB. */
  function collectSubtree(panelId: string): string[] {
    const ids: string[] = [panelId];
    const children = persistence.getChildren(panelId);
    for (const child of children) {
      ids.push(...collectSubtree(child.id));
    }
    return ids;
  }

  // Service definition

  return {
    name: "panel",
    description: "Server-side panel orchestration (create, close, state, persistence)",
    policy: { allowed: ["shell", "server"] },
    methods: {
      create: {
        args: z.tuple([
          z.string(), // source
          z.object({
            parentId: z.string().optional(),
            name: z.string().optional(),
            contextId: z.string().optional(),
            env: z.record(z.string()).optional(),
            stateArgs: z.record(z.unknown()).optional(),
            isRoot: z.boolean().optional(),
            addAsRoot: z.boolean().optional(),
            autoArchiveWhenEmpty: z.boolean().optional(),
          }).optional(),
        ]),
      },
      close: { args: z.tuple([z.string()]) },
      createBrowser: {
        args: z.tuple([
          z.string().nullable(), // parentId
          z.string(),            // url
          z.object({ name: z.string().optional() }).optional(),
        ]),
      },
      getCredentials: { args: z.tuple([z.string()]) },
      updateTitle: { args: z.tuple([z.string(), z.string()]) },
      updateContext: {
        args: z.tuple([
          z.string(),
          z.object({
            contextId: z.string().optional(),
            source: z.string().optional(),
            stateArgs: z.record(z.unknown()).optional(),
          }),
        ]),
      },
      updateStateArgs: { args: z.tuple([z.string(), z.record(z.unknown())]) },
      setCollapsed: { args: z.tuple([z.string(), z.boolean()]) },
      setCollapsedBatch: { args: z.tuple([z.array(z.string()), z.boolean()]) },
      getCollapsedIds: { args: z.tuple([]) },
      updateSelectedPath: { args: z.tuple([z.string()]) },
      movePanel: { args: z.tuple([z.string(), z.string().nullable(), z.number()]) },
      loadTree: { args: z.tuple([]) },
      shutdownCleanup: { args: z.tuple([z.array(z.string())]) },
    },
    handler: async (_ctx, method, args) => {
      const a = args as unknown[];

      switch (method) {
        // =================================================================
        // Create
        // =================================================================
        case "create": {
          const [source, opts] = a as [string, {
            parentId?: string;
            name?: string;
            contextId?: string;
            env?: Record<string, string>;
            stateArgs?: Record<string, unknown>;
            isRoot?: boolean;
            addAsRoot?: boolean;
            autoArchiveWhenEmpty?: boolean;
          }?];

          const { relativePath, absolutePath } = resolveSource(source, workspacePath);
          const allowMissing = !!opts?.contextId;
          const manifest = resolveManifest(absolutePath, relativePath, allowMissing);

          // Validate stateArgs against manifest schema
          let validatedStateArgs: Record<string, unknown> | undefined;
          if (opts?.stateArgs || manifest.stateArgs) {
            const validation = validateStateArgs(opts?.stateArgs ?? {}, manifest.stateArgs);
            if (!validation.success) {
              throw new Error(`Invalid stateArgs for ${relativePath}: ${validation.error}`);
            }
            validatedStateArgs = validation.data as Record<string, unknown>;
          }

          const panelId = computePanelId({
            relativePath,
            parent: opts?.parentId ? { id: opts.parentId } : null,
            requestedId: opts?.name,
            isRoot: opts?.isRoot,
          });

          const contextId = opts?.contextId ?? generateContextId(panelId);

          // Tokens
          tokenManager.createToken(panelId, "panel");
          const rpcToken = tokenManager.getToken(panelId)!;
          const gitToken = gitServer.getTokenForPanel(panelId);

          // FS context registration (skip browser panels)
          fsService.registerPanelContext(panelId, contextId);

          // Build env — use pre-computed panel-facing URLs
          const serverRpcToken = rpcToken;
          const gitBaseUrl = urlConfig.gitBaseUrl;
          const env = buildPanelEnv({
            panelId,
            gitBaseUrl,
            gitToken,
            serverRpcToken,
            workerdPort,
            contextId,
            sourceRepo: relativePath,
            externalHost: urlConfig.externalHost,
            protocol: urlConfig.protocol,
            gatewayPort: urlConfig.gatewayPort,
            baseEnv: opts?.env,
          });

          const snapshot = createSnapshot(relativePath, contextId, { env }, validatedStateArgs);
          if (opts?.autoArchiveWhenEmpty || manifest.autoArchiveWhenEmpty) {
            snapshot.autoArchiveWhenEmpty = true;
          }

          // Persist
          const parentId = opts?.parentId ?? null;
          persistAndIndex(panelId, manifest.title, parentId, snapshot);

          const result: PanelCreateResult = {
            panelId,
            contextId,
            rpcToken,
            gitToken,
            source: relativePath,
            title: manifest.title,
            stateArgs: validatedStateArgs ?? {},
            options: { env },
            autoArchiveWhenEmpty: snapshot.autoArchiveWhenEmpty,
          };
          return result;
        }

        // =================================================================
        // Close
        // =================================================================
        case "close": {
          const [panelId] = a as [string];
          const closedIds = collectSubtree(panelId);

          for (const id of closedIds) {
            tokenManager.revokeToken(id);
            gitServer.revokeTokenForPanel(id);
            fsService.unregisterPanelContext(id);
            fsService.closeHandlesForCaller(id);
            persistence.archivePanel(id);
          }

          return { closedIds };
        }

        // =================================================================
        // Create browser panel
        // =================================================================
        case "createBrowser": {
          const [parentId, url, opts] = a as [string | null, string, { name?: string }?];

          if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
            throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
          }
          try { new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
          const hostname = new URL(url).hostname;
          const normalizedSource = browserSourceFromHostname(hostname);

          const panelId = computePanelId({
            relativePath: normalizedSource,
            parent: parentId ? { id: parentId } : null,
            requestedId: opts?.name,
          });

          const contextId = generateContextId(panelId);
          tokenManager.createToken(panelId, "panel");
          const rpcToken = tokenManager.getToken(panelId)!;

          const snapshot = createSnapshot(`browser:${url}`, contextId, {});
          persistAndIndex(panelId, opts?.name ?? hostname, parentId, snapshot);

          // No FS context for browser panels

          const result: PanelCreateResult = {
            panelId,
            contextId,
            rpcToken,
            source: `browser:${url}`,
            title: opts?.name ?? hostname,
            url,
            stateArgs: {},
            options: {},
          };
          return result;
        }

        // =================================================================
        // Credentials
        // =================================================================
        case "getCredentials": {
          const [panelId] = a as [string];
          const serverRpcToken = tokenManager.ensureToken(panelId, "panel");
          const gitToken = gitServer.getTokenForPanel(panelId);

          return {
            serverRpcToken,
            gitToken,
            gitConfig: {
              serverUrl: urlConfig.gitBaseUrl,
              token: gitToken,
            },
            pubsubConfig: {
              serverUrl: `${urlConfig.pubsubBaseUrl}/_w/workers/pubsub-channel/PubSubChannel`,
              token: serverRpcToken,
            },
            rpcPort: getRpcPort(),
            workerdPort,
            gitBaseUrl: urlConfig.gitBaseUrl,
          };
        }

        // =================================================================
        // State mutations
        // =================================================================
        case "updateTitle": {
          const [panelId, title] = a as [string, string];
          persistence.setTitle(panelId, title);
          if (searchIndex) {
            try { searchIndex.updateTitle(panelId, title); }
            catch (e) { console.warn(`[PanelService] Search index updateTitle failed for ${panelId}:`, e); }
          }
          return;
        }

        case "updateContext": {
          const [panelId, updates] = a as [string, { contextId?: string; source?: string; stateArgs?: Record<string, unknown> }];
          const existing = persistence.getPanel(panelId);
          if (!existing) throw new Error(`Panel not found: ${panelId}`);

          const updatedSnapshot = { ...existing.snapshot };
          if (updates.contextId) updatedSnapshot.contextId = updates.contextId;
          if (updates.source) {
            updatedSnapshot.source = updates.source;
            // Sync manifest-derived snapshot fields (autoArchiveWhenEmpty)
            try {
              const absolutePath = path.resolve(workspacePath, updates.source);
              const manifest = loadPanelManifest(absolutePath);
              if (manifest.autoArchiveWhenEmpty) {
                updatedSnapshot.autoArchiveWhenEmpty = true;
              } else {
                delete updatedSnapshot.autoArchiveWhenEmpty;
              }
            } catch {
              // Manifest not loadable (browser panel, etc.) — clear the flag
              delete updatedSnapshot.autoArchiveWhenEmpty;
            }
          }
          if (updates.stateArgs) updatedSnapshot.stateArgs = updates.stateArgs;

          persistence.updatePanel(panelId, { snapshot: updatedSnapshot });

          // Update FS context mapping if contextId changed
          if (updates.contextId) {
            fsService.registerPanelContext(panelId, updates.contextId);
          }
          return;
        }

        case "updateStateArgs": {
          const [panelId, updates] = a as [string, Record<string, unknown>];
          const panel = persistence.getPanel(panelId);
          if (!panel) throw new Error(`Panel not found: ${panelId}`);

          // Load manifest for schema validation
          const panelSource = getPanelSource(panel);
          let schema;
          try {
            const absolutePath = path.resolve(workspacePath, panelSource);
            const manifest = loadPanelManifest(absolutePath);
            schema = manifest.stateArgs;
          } catch {
            // Dynamic source — skip validation
          }

          const currentArgs = getPanelStateArgs(panel) ?? {};
          const merged = { ...currentArgs, ...updates };
          for (const key of Object.keys(merged)) {
            if (merged[key] === null) delete merged[key];
          }

          const validation = validateStateArgs(merged, schema);
          if (!validation.success) {
            throw new Error(`Invalid stateArgs: ${validation.error}`);
          }

          const updatedSnapshot = { ...panel.snapshot, stateArgs: validation.data };
          persistence.updatePanel(panelId, { snapshot: updatedSnapshot });

          return validation.data;
        }

        case "setCollapsed": {
          const [panelId, collapsed] = a as [string, boolean];
          persistence.setCollapsed(panelId, collapsed);
          return;
        }

        case "setCollapsedBatch": {
          const [panelIds, collapsed] = a as [string[], boolean];
          persistence.setCollapsedBatch(panelIds, collapsed);
          return;
        }

        case "getCollapsedIds": {
          return persistence.getCollapsedIds();
        }

        case "updateSelectedPath": {
          const [panelId] = a as [string];
          persistence.updateSelectedPath(panelId);
          if (searchIndex) {
            try { searchIndex.incrementAccessCount(panelId); }
            catch (e) { console.warn(`[PanelService] Search index incrementAccessCount failed for ${panelId}:`, e); }
          }
          return;
        }

        case "movePanel": {
          const [panelId, targetParentId, position] = a as [string, string | null, number];
          persistence.movePanel(panelId, targetParentId, position);
          return;
        }

        // =================================================================
        // Tree operations
        // =================================================================
        case "loadTree": {
          const tree = persistence.getFullTree();
          // Clean up childless autoArchiveWhenEmpty panels (e.g., unused launcher UIs)
          cleanupChildlessAutoArchivePanels(tree, persistence);
          // Return tree + collapsed IDs in one call (eliminates a round-trip)
          const rootPanels = tree.filter(p => !persistence.isArchived(p.id));
          const collapsedIds = persistence.getCollapsedIds();
          return { rootPanels, collapsedIds };
        }

        case "shutdownCleanup": {
          const [livePanelIds] = a as [string[]];
          const liveSet = new Set(livePanelIds);
          // Archive panels that are no longer live
          const tree = persistence.getFullTree();
          const archiveIfDead = (panels: import("../../shared/types.js").Panel[]) => {
            for (const panel of panels) {
              if (!liveSet.has(panel.id)) {
                persistence.archivePanel(panel.id);
              }
              if (panel.children.length > 0) {
                archiveIfDead(panel.children);
              }
            }
          };
          archiveIfDead(tree);
          return;
        }

        default:
          throw new Error(`Unknown panel method: ${method}`);
      }
    },
  };
}
