/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";

export interface GatewayConfig {
  serverUrl: string;
  token: string;
  aliases?: readonly string[];
}

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Runtime entity ID for this panel or worker */
  var __natstackEntityId: string | undefined;
  /** Stable workspace slot id for panel tree operations. */
  var __natstackSlotId: string | undefined;
  /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
  var __natstackContextId: string | undefined;
  /** Environment kind: "panel" or "shell" */
  var __natstackKind: "panel" | "shell" | undefined;
  /** Parent panel ID if this is a child panel/worker */
  var __natstackParentId: string | null | undefined;
  /** Runtime entity ID for the parent panel, used for child-to-parent RPC. */
  var __natstackParentEntityId: string | null | undefined;
  /** Initial theme appearance */
  var __natstackInitialTheme: "light" | "dark" | undefined;
  /** Single gateway configuration for HTTP and RPC-derived clients. */
  var __natstackGatewayConfig: GatewayConfig | undefined;
  /** Source repo path for this endpoint */
  var __natstackSourceRepo: string | undefined;
  /** Exact effective version for the source currently running. */
  var __natstackEffectiveVersion: string | null | undefined;
  /** Environment variables */
  var __natstackEnv: Record<string, string> | undefined;
}

export interface InjectedConfig {
  entityId: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  kind: "panel" | "shell";
  parentId: PanelSlotId | null;
  parentEntityId: PanelEntityId | null;
  initialTheme: "light" | "dark";
  gatewayConfig: GatewayConfig;
  env: Record<string, string>;
  effectiveVersion: string | null;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __natstackEntityId?: string;
  __natstackSlotId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
  __natstackParentEntityId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGatewayConfig?: GatewayConfig;
  __natstackSourceRepo?: string;
  __natstackEffectiveVersion?: string | null;
  __natstackEnv?: Record<string, string>;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function normalizeGatewayConfigForBrowser(config: GatewayConfig): GatewayConfig {
  const location = (globalThis as { location?: { origin?: string } }).location;
  if (!location?.origin) return config;

  try {
    const injectedUrl = new URL(config.serverUrl);
    const pageUrl = new URL(location.origin);
    const sameLoopbackPort =
      injectedUrl.protocol === pageUrl.protocol &&
      injectedUrl.port === pageUrl.port &&
      LOOPBACK_HOSTS.has(injectedUrl.hostname) &&
      LOOPBACK_HOSTS.has(pageUrl.hostname);
    if (!sameLoopbackPort || injectedUrl.origin === pageUrl.origin) return config;

    const rewritten = new URL(config.serverUrl);
    rewritten.protocol = pageUrl.protocol;
    rewritten.host = pageUrl.host;
    const aliases = Array.from(new Set([...(config.aliases ?? []), config.serverUrl]));
    return { ...config, serverUrl: rewritten.toString().replace(/\/$/, ""), aliases };
  } catch {
    return config;
  }
}

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  const entityId = g.__natstackEntityId;
  if (typeof entityId === "undefined" || !entityId) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackEntityId to be defined."
    );
  }
  if (!g.__natstackGatewayConfig?.serverUrl || !g.__natstackGatewayConfig?.token) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackGatewayConfig with serverUrl and token."
    );
  }

  const effectiveVersion =
    g.__natstackEffectiveVersion ?? g.__natstackEnv?.["__NATSTACK_EFFECTIVE_VERSION"] ?? null;
  const gatewayConfig = normalizeGatewayConfigForBrowser(g.__natstackGatewayConfig);

  return {
    entityId: entityId as PanelEntityId,
    slotId: g.__natstackSlotId as PanelSlotId | undefined,
    contextId: g.__natstackContextId ?? "",
    kind: g.__natstackKind ?? "panel",
    parentId:
      typeof g.__natstackParentId === "string" && g.__natstackParentId.length > 0
        ? (g.__natstackParentId as PanelSlotId)
        : null,
    parentEntityId:
      typeof g.__natstackParentEntityId === "string" && g.__natstackParentEntityId.length > 0
        ? (g.__natstackParentEntityId as PanelEntityId)
        : null,
    initialTheme: g.__natstackInitialTheme === "dark" ? "dark" : "light",
    gatewayConfig,
    env: g.__natstackEnv ?? {},
    effectiveVersion,
  };
}
