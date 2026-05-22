/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { GitConfig } from "../core/index.js";
import type { PanelEntityId, PanelSlotId } from "@natstack/shared/panel/ids";

export interface GatewayConfig {
  serverUrl: string;
  token: string;
}

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Runtime entity ID for this panel or worker */
  var __natstackEntityId: string | undefined;
  /** Deprecated alias for __natstackEntityId. */
  var __natstackId: string | undefined;
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
  /** Single gateway configuration for HTTP, RPC-derived clients, and git */
  var __natstackGatewayConfig: GatewayConfig | undefined;
  /** Source repo path for this endpoint */
  var __natstackSourceRepo: string | undefined;
  /** Environment variables */
  var __natstackEnv: Record<string, string> | undefined;
}

export interface InjectedConfig {
  entityId: PanelEntityId;
  id: PanelEntityId;
  slotId?: PanelSlotId;
  contextId: string;
  kind: "panel" | "shell";
  parentId: PanelSlotId | null;
  parentEntityId: PanelEntityId | null;
  initialTheme: "light" | "dark";
  gatewayConfig: GatewayConfig;
  gitConfig: GitConfig | null;
  env: Record<string, string>;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __natstackEntityId?: string;
  __natstackId?: string;
  __natstackSlotId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
  __natstackParentEntityId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGatewayConfig?: GatewayConfig;
  __natstackSourceRepo?: string;
  __natstackGitConfig?: unknown;
  __natstackEnv?: Record<string, string>;
};

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  const entityId = g.__natstackEntityId ?? g.__natstackId;
  if (typeof entityId === "undefined" || !entityId) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackEntityId to be defined."
    );
  }
  if (typeof g.__natstackGitConfig !== "undefined") {
    throw new Error(
      "Legacy NatStack runtime globals are not supported. Expected __natstackGatewayConfig only."
    );
  }
  if (!g.__natstackGatewayConfig?.serverUrl || !g.__natstackGatewayConfig?.token) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackGatewayConfig with serverUrl and token."
    );
  }

  const sourceRepo = g.__natstackSourceRepo ?? g.__natstackEnv?.["__NATSTACK_SOURCE_REPO"] ?? "";
  const gitConfig: GitConfig = {
    serverUrl: `${g.__natstackGatewayConfig.serverUrl.replace(/\/$/, "")}/_git`,
    token: g.__natstackGatewayConfig.token,
    sourceRepo,
  };

  return {
    entityId: entityId as PanelEntityId,
    id: entityId as PanelEntityId,
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
    gatewayConfig: g.__natstackGatewayConfig,
    gitConfig,
    env: g.__natstackEnv ?? {},
  };
}
