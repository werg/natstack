/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { GitConfig, PubSubConfig } from "../core/index.js";

export interface GatewayConfig {
  serverUrl: string;
  token: string;
}

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Unique identifier for this panel or worker */
  var __natstackId: string | undefined;
  /** Context ID for storage partition (format: {mode}_{type}_{identifier}) */
  var __natstackContextId: string | undefined;
  /** Environment kind: "panel" or "shell" */
  var __natstackKind: "panel" | "shell" | undefined;
  /** Parent panel ID if this is a child panel/worker */
  var __natstackParentId: string | null | undefined;
  /** Initial theme appearance */
  var __natstackInitialTheme: "light" | "dark" | undefined;
  /** Single gateway configuration for HTTP, RPC-derived clients, git and pubsub */
  var __natstackGatewayConfig: GatewayConfig | undefined;
  /** Source repo path for this endpoint */
  var __natstackSourceRepo: string | undefined;
  /** Environment variables */
  var __natstackEnv: Record<string, string> | undefined;
}

export interface InjectedConfig {
  id: string;
  contextId: string;
  kind: "panel" | "shell";
  parentId: string | null;
  initialTheme: "light" | "dark";
  gatewayConfig: GatewayConfig;
  gitConfig: GitConfig | null;
  pubsubConfig: PubSubConfig | null;
  env: Record<string, string>;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __natstackId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGatewayConfig?: GatewayConfig;
  __natstackSourceRepo?: string;
  __natstackGitConfig?: unknown;
  __natstackPubSubConfig?: unknown;
  __natstackEnv?: Record<string, string>;
};

function toWebSocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  if (typeof g.__natstackId === "undefined" || !g.__natstackId) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackId to be defined."
    );
  }
  if (typeof g.__natstackGitConfig !== "undefined" || typeof g.__natstackPubSubConfig !== "undefined") {
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
  const pubsubConfig: PubSubConfig = {
    serverUrl: toWebSocketUrl(g.__natstackGatewayConfig.serverUrl),
    token: g.__natstackGatewayConfig.token,
  };

  return {
    id: g.__natstackId,
    contextId: g.__natstackContextId ?? "",
    kind: g.__natstackKind ?? "panel",
    parentId:
      typeof g.__natstackParentId === "string" && g.__natstackParentId.length > 0
        ? g.__natstackParentId
        : null,
    initialTheme: g.__natstackInitialTheme === "dark" ? "dark" : "light",
    gatewayConfig: g.__natstackGatewayConfig,
    gitConfig,
    pubsubConfig,
    env: g.__natstackEnv ?? {},
  };
}
