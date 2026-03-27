/**
 * panelFactory — Stateless panel utilities.
 *
 * Pure functions extracted from PanelLifecycle. Used by both the server
 * panel service and Electron PanelOrchestrator. No class, no state.
 */

import * as path from "path";
import type { Panel, PanelArtifacts } from "./types.js";
import { createSnapshot } from "./panel/accessors.js";
import { contextIdToSubdomain } from "./panelIdUtils.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";

// =============================================================================
// Types
// =============================================================================

/** DTO returned by server panel.create / panel.createBrowser */
export interface PanelCreateResult {
  panelId: string;
  contextId: string;
  rpcToken: string;
  gitToken?: string;
  source: string;
  title: string;
  url?: string;
  stateArgs: Record<string, unknown>;
  options: Record<string, unknown>;
  autoArchiveWhenEmpty?: boolean;
}

export interface BuildBootstrapConfigOpts {
  panelId: string;
  contextId: string;
  source: string;
  parentId: string | null;
  theme: "light" | "dark";
  rpcPort: number;
  rpcToken: string;
  serverRpcPort: number;
  serverRpcToken: string;
  gitToken: string;
  gitBaseUrl: string;
  workerdPort: number;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;
  env?: Record<string, string>;
  stateArgs?: Record<string, unknown>;
}

export interface BuildPanelUrlOpts {
  source: string;
  contextId: string;
  panelHttpPort: number;
  externalHost: string;
  protocol: "http" | "https";
}

export interface BuildPanelEnvOpts {
  panelId: string;
  gitBaseUrl: string;
  gitToken: string;
  serverRpcToken: string | null;
  workerdPort: number;
  contextId: string;
  sourceRepo: string;
  externalHost: string;
  protocol: "http" | "https";
  gatewayPort: number;
  baseEnv?: Record<string, string> | null;
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Resolve a source path relative to the workspace root.
 */
export function resolveSource(
  source: string,
  panelsRoot: string,
): { relativePath: string; absolutePath: string } {
  return normalizeRelativePanelPath(source, panelsRoot);
}

/**
 * Assemble the full bootstrap config delivered to panels via RPC.
 */
export function buildBootstrapConfig(opts: BuildBootstrapConfigOpts): unknown {
  const subdomain = contextIdToSubdomain(opts.contextId);
  const host = opts.externalHost;
  const wsProtocol = opts.protocol === "https" ? "wss" : "ws";
  const port = opts.gatewayPort;

  const gitConfig = {
    serverUrl: opts.gitBaseUrl,
    token: opts.gitToken,
    sourceRepo: opts.source,
  };
  const pubsubConfig = {
    serverUrl: `${wsProtocol}://${subdomain}.${host}:${port}/_w/workers/pubsub-channel/PubSubChannel`,
    token: opts.serverRpcToken,
  };

  return {
    panelId: opts.panelId,
    contextId: opts.contextId,
    parentId: opts.parentId,
    theme: opts.theme,
    rpcPort: opts.rpcPort,
    rpcToken: opts.rpcToken,
    serverRpcPort: opts.serverRpcPort,
    serverRpcToken: opts.serverRpcToken,
    gitConfig,
    pubsubConfig,
    env: {
      ...opts.env,
      PARENT_ID: opts.parentId ?? "",
      __GIT_CONFIG: JSON.stringify(gitConfig),
      __PUBSUB_CONFIG: JSON.stringify(pubsubConfig),
    },
    stateArgs: opts.stateArgs ?? {},
  };
}

/**
 * Compute the HTTP URL for a panel.
 */
export function buildPanelUrl(opts: BuildPanelUrlOpts): string {
  // Browser panels store the URL directly in source as "browser:{url}"
  if (opts.source.startsWith("browser:")) {
    return opts.source.slice("browser:".length);
  }

  const protocol = opts.protocol;
  const host = opts.externalHost;
  const subdomain = contextIdToSubdomain(opts.contextId);
  return `${protocol}://${subdomain}.${host}:${opts.panelHttpPort}/${opts.source}/`;
}

/**
 * Build env vars for a panel, merging base env with system env.
 */
export function buildPanelEnv(opts: BuildPanelEnvOpts): Record<string, string> {
  const gitConfig = JSON.stringify({
    serverUrl: opts.gitBaseUrl,
    token: opts.gitToken,
    sourceRepo: opts.sourceRepo,
  });

  const panelSubdomain = contextIdToSubdomain(opts.contextId);
  const envHost = opts.externalHost;
  const wsProtocol = opts.protocol === "https" ? "wss" : "ws";
  const wsPort = opts.gatewayPort;
  const pubsubConfig = wsPort
    ? JSON.stringify({
        serverUrl: `${wsProtocol}://${panelSubdomain}.${envHost}:${wsPort}/_w/workers/pubsub-channel/PubSubChannel`,
        token: opts.serverRpcToken,
      })
    : "";

  // Pass critical environment variables that Node.js APIs depend on
  const criticalEnv: Record<string, string> = {};
  for (const key of [
    "HOME", "USER", "PATH", "TMPDIR", "TEMP", "TMP", "SHELL",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[key]) {
      criticalEnv[key] = process.env[key]!;
    }
  }

  return {
    ...criticalEnv,
    ...opts.baseEnv,
    __GIT_SERVER_URL: opts.gitBaseUrl,
    __GIT_TOKEN: opts.gitToken,
    __GIT_CONFIG: gitConfig,
    __PUBSUB_CONFIG: pubsubConfig,
  };
}

/**
 * Convert a server PanelCreateResult DTO into a full Panel object
 * for the in-memory registry.
 */
export function buildPanelFromResult(
  result: PanelCreateResult,
  parentId: string | null,
): Panel {
  const isBrowser = result.source.startsWith("browser:");

  const initialSnapshot = createSnapshot(
    result.source,
    result.contextId,
    result.options,
    result.stateArgs,
  );

  if (result.autoArchiveWhenEmpty) {
    initialSnapshot.autoArchiveWhenEmpty = true;
  }

  const artifacts: PanelArtifacts = isBrowser
    ? { buildState: "ready", htmlPath: result.url }
    : { buildState: "building", buildProgress: "Starting build..." };

  return {
    id: result.panelId,
    title: result.title,
    children: [],
    selectedChildId: null,
    snapshot: initialSnapshot,
    artifacts,
  };
}

/**
 * Generate a contextId from a panelId.
 */
export function generateContextId(panelId: string): string {
  return `ctx-${panelId
    .replace(/[^a-z0-9]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 59)}`;
}

/**
 * Derive a normalized source path for browser panels from a hostname.
 */
export function browserSourceFromHostname(hostname: string): string {
  return `browser~${hostname.replace(/[^a-z0-9.-]/gi, "-")}`;
}
