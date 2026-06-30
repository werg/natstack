/**
 * panelFactory — Stateless panel utilities.
 *
 * Pure functions extracted from PanelLifecycle. Used by both the server
 * panel service and Electron PanelOrchestrator. No class, no state.
 */

import * as path from "path";
import type { Panel, PanelArtifacts } from "./types.js";
import { createSnapshot } from "./panel/accessors.js";
import { normalizeRelativePanelPath } from "./pathUtils.js";
import type { PanelEntityId, PanelSlotId } from "./panel/ids.js";

// =============================================================================
// Types
// =============================================================================

/** DTO returned by panel slot create/navigate operations. */
export interface PanelCreateResult {
  panelId: string;
  contextId: string;
  source: string;
  title: string;
  url?: string;
  stateArgs: Record<string, unknown>;
  options: Record<string, unknown>;
  autoArchiveWhenEmpty?: boolean;
  privileged?: boolean;
}

export interface BuildBootstrapConfigOpts {
  entityId: PanelEntityId;
  slotId: PanelSlotId;
  contextId: string;
  source: string;
  effectiveVersion?: string | null;
  parentId: PanelSlotId | null;
  parentEntityId?: PanelEntityId | null;
  theme: "light" | "dark";
  gatewayConfig: { serverUrl: string; token: string; aliases?: readonly string[] };
  env?: Record<string, string>;
  stateArgs?: Record<string, unknown>;
}

export interface BuildPanelUrlOpts {
  source: string;
  contextId: string;
  ref?: string;
  gatewayPort: number;
  basePath?: string;
}

export interface BuildPanelEnvOpts {
  panelId: string;
  gatewayToken: string | null;
  gatewayAliases?: readonly string[];
  contextId: string;
  sourceRepo: string;
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
  panelsRoot: string
): { relativePath: string; absolutePath: string } {
  return normalizeRelativePanelPath(source, panelsRoot);
}

/**
 * Assemble the full bootstrap config delivered to panels via RPC.
 */
export function buildBootstrapConfig(opts: BuildBootstrapConfigOpts): unknown {
  return {
    entityId: opts.entityId,
    slotId: opts.slotId,
    contextId: opts.contextId,
    parentId: opts.parentId,
    parentEntityId: opts.parentEntityId ?? null,
    theme: opts.theme,
    sourceRepo: opts.source,
    effectiveVersion: opts.effectiveVersion ?? null,
    gatewayConfig: opts.gatewayConfig,
    env: {
      ...opts.env,
      PARENT_ID: opts.parentId ?? "",
      __NATSTACK_SOURCE_REPO: opts.source,
      __NATSTACK_EFFECTIVE_VERSION: opts.effectiveVersion ?? "",
      __NATSTACK_GATEWAY_CONFIG: JSON.stringify(opts.gatewayConfig),
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

  const params = new URLSearchParams();
  params.set("contextId", opts.contextId);
  if (opts.ref) params.set("ref", opts.ref);
  const encodedPath = encodeURIComponent(opts.source).replace(/%2F/g, "/");
  const basePath = opts.basePath?.replace(/\/+$/, "") ?? "";
  // Panels load from a fixed loopback origin (the local asset façade); the
  // host bridges panel RPC over the pipe, so no remote host/protocol applies.
  return `http://127.0.0.1:${opts.gatewayPort}${basePath}/${encodedPath}/?${params.toString()}`;
}

/**
 * Build env vars for a panel, merging base env with system env.
 */
export function buildPanelEnv(opts: BuildPanelEnvOpts): Record<string, string> {
  const gatewayServerUrl = opts.gatewayPort ? `http://127.0.0.1:${opts.gatewayPort}` : "";
  const gatewayConfig = gatewayServerUrl
    ? JSON.stringify({
        serverUrl: gatewayServerUrl,
        token: opts.gatewayToken ?? "",
        aliases: opts.gatewayAliases,
      })
    : "";
  // Pass critical environment variables that Node.js APIs depend on
  const criticalEnv: Record<string, string> = {};
  for (const key of [
    "HOME",
    "USER",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[key]) {
      criticalEnv[key] = process.env[key]!;
    }
  }

  return {
    ...criticalEnv,
    ...opts.baseEnv,
    __NATSTACK_SOURCE_REPO: opts.sourceRepo,
    __NATSTACK_GATEWAY_CONFIG: gatewayConfig,
  };
}

/**
 * Convert a server PanelCreateResult DTO into a full Panel object
 * for the in-memory registry.
 */
export function buildPanelFromResult(result: PanelCreateResult, parentId: string | null): Panel {
  const isBrowser = result.source.startsWith("browser:");

  const initialSnapshot = createSnapshot(
    result.source,
    result.contextId,
    result.options,
    result.stateArgs
  );

  if (result.autoArchiveWhenEmpty) {
    initialSnapshot.autoArchiveWhenEmpty = true;
  }
  if (result.privileged) {
    initialSnapshot.privileged = true;
  }

  const artifacts: PanelArtifacts = isBrowser
    ? { buildState: "ready", htmlPath: result.url }
    : { buildState: "building", buildProgress: "Starting build..." };

  return {
    id: result.panelId,
    title: result.title,
    children: [],
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
