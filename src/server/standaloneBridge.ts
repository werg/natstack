/**
 * Standalone Bridge — lightweight bridge for browser-only panels.
 *
 * Replaces headlessBridge.ts. Operates on a flat session map (no tree,
 * no persistence) for standalone/browser-accessed panels.
 */

import type { BridgePanelManager } from "../shared/panelInterfaces.js";
import type { GitServer } from "@natstack/git-server";
import type { TokenManager } from "../shared/tokenManager.js";
import type { FsService } from "../shared/fsService.js";
import type { CdpBridge } from "./cdpBridge.js";
import { handleCommonBridgeMethod } from "../shared/bridgeHandlersCommon.js";
import { buildBootstrapConfig, generateContextId, browserSourceFromHostname } from "../shared/panelFactory.js";
import { computePanelId, contextIdToSubdomain } from "../shared/panelIdUtils.js";

// =============================================================================
// Standalone session map (replaces headless panel tree)
// =============================================================================

export interface StandaloneSession {
  panelId: string;
  source: string;
  subdomain: string;
  contextId: string;
  stateArgs: Record<string, unknown>;
  parentId: string | null;
}

// =============================================================================
// StandaloneBridge
// =============================================================================

export interface StandaloneBridgeDeps {
  sessions: Map<string, StandaloneSession>;
  tokenManager: TokenManager;
  fsService: FsService;
  gitServer: GitServer;
  cdpBridge: CdpBridge | null;
  rpcPort: number;
  workerdPort: number;
  protocol: "http" | "https";
  externalHost: string;
  gatewayPort: number;
}

/**
 * Create a BridgePanelManager backed by the standalone session map.
 */
export function createStandalonePanelManager(deps: StandaloneBridgeDeps): BridgePanelManager {
  const { sessions, tokenManager, fsService, gitServer, rpcPort, workerdPort } = deps;

  return {
    closePanel(panelId: string): void {
      const session = sessions.get(panelId);
      if (!session) return;
      tokenManager.revokeToken(panelId);
      fsService.unregisterPanelContext(panelId);
      fsService.closeHandlesForPanel(panelId);
      sessions.delete(panelId);
    },

    getInfo(panelId: string) {
      const session = sessions.get(panelId);
      if (!session) throw new Error(`Session not found: ${panelId}`);
      return {
        panelId: session.panelId,
        partition: session.contextId,
        contextId: session.contextId,
      };
    },

    async handleSetStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> {
      const session = sessions.get(panelId);
      if (!session) throw new Error(`Session not found: ${panelId}`);
      session.stateArgs = { ...session.stateArgs, ...updates };
      // Remove null keys
      for (const key of Object.keys(session.stateArgs)) {
        if (session.stateArgs[key] === null) delete session.stateArgs[key];
      }
      return session.stateArgs;
    },

    focusPanel(_panelId: string): void {
      // No-op in standalone mode
    },

    async getBootstrapConfig(callerId: string) {
      const session = sessions.get(callerId);
      if (!session) throw new Error(`Session not found: ${callerId}`);

      const rpcToken = tokenManager.ensureToken(callerId, "panel");
      const gitToken = gitServer.getTokenForPanel(callerId);
      const gitBaseUrl = `${deps.protocol}://${deps.externalHost}:${deps.gatewayPort}/_git`;

      return buildBootstrapConfig({
        panelId: callerId,
        contextId: session.contextId,
        source: session.source,
        parentId: session.parentId,
        theme: "dark",
        rpcPort: deps.gatewayPort,
        rpcToken,
        serverRpcPort: deps.gatewayPort,
        serverRpcToken: rpcToken,
        gitToken,
        gitBaseUrl,
        workerdPort: deps.gatewayPort,
        externalHost: deps.externalHost,
        protocol: deps.protocol,
        gatewayPort: deps.gatewayPort,
        stateArgs: session.stateArgs,
      });
    },

    async createBrowserPanel(callerId: string, url: string, options?: { name?: string }) {
      if (!deps.cdpBridge) {
        throw new Error("Browser automation requires --serve-panels");
      }

      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw new Error(`Invalid browser panel URL (must be http/https string): ${String(url)}`);
      }
      try { new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
      const hostname = new URL(url).hostname;
      const normalizedSource = browserSourceFromHostname(hostname);

      const panelId = computePanelId({
        relativePath: normalizedSource,
        parent: sessions.has(callerId) ? { id: callerId } : null,
        requestedId: options?.name,
      });

      const contextId = generateContextId(panelId);
      tokenManager.createToken(panelId, "panel");

      const session: StandaloneSession = {
        panelId,
        source: `browser:${url}`,
        subdomain: contextIdToSubdomain(contextId),
        contextId,
        stateArgs: {},
        parentId: sessions.has(callerId) ? callerId : null,
      };
      sessions.set(panelId, session);

      try {
        await deps.cdpBridge.openBrowserTab(panelId, url);
      } catch (err) {
        // Rollback
        sessions.delete(panelId);
        tokenManager.revokeToken(panelId);
        throw err;
      }

      return { id: panelId, title: options?.name ?? hostname };
    },

    async closeChild(callerId: string, childId: string): Promise<void> {
      const child = sessions.get(childId);
      if (!child || child.parentId !== callerId) {
        throw new Error(`Panel ${callerId} is not the parent of ${childId}`);
      }
      this.closePanel(childId);
    },
  };
}

/**
 * Handle a bridge service call in standalone mode.
 */
export async function handleStandaloneBridgeCall(
  deps: StandaloneBridgeDeps,
  pm: BridgePanelManager,
  callerId: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  // Try common handlers first
  const common = await handleCommonBridgeMethod(pm, callerId, method, args, deps.gitServer);
  if (common.handled) return common.result;

  // Standalone-specific handlers
  switch (method) {
    case "openDevtools":
      return; // No-op

    case "openFolderDialog":
      throw new Error("Folder dialogs are not available in standalone mode.");

    case "createRepo":
      throw new Error("Repo creation not yet available in standalone mode.");

    case "createBrowserPanel": {
      if (!pm.createBrowserPanel) throw new Error("Browser panel creation not available");
      const [url, opts] = args as [string, { name?: string; focus?: boolean }?];
      return pm.createBrowserPanel(callerId, url, opts);
    }

    case "openExternal": {
      if (!deps.cdpBridge) throw new Error("Browser automation requires --serve-panels");
      const [url] = args as [string];
      if (!/^https?:\/\//i.test(url)) throw new Error("openExternal only supports http/https URLs");
      await deps.cdpBridge.openExternalTab(url);
      return;
    }

    default:
      throw new Error(`Unknown bridge method: ${method}`);
  }
}
