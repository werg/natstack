/**
 * Unified injected globals for panels and workers.
 *
 * Both environments receive the same global names.
 */

import type { GitConfig, PubSubConfig } from "../core/index.js";

/**
 * Injected globals available in both panel and worker environments.
 */
declare global {
  /** Unique identifier for this panel or worker */
  var __natstackId: string | undefined;
  /** Environment kind: "panel" or "worker" */
  var __natstackKind: "panel" | "worker" | undefined;
  /** Parent panel ID if this is a child panel/worker */
  var __natstackParentId: string | null | undefined;
  /** Initial theme appearance */
  var __natstackInitialTheme: "light" | "dark" | undefined;
  /** Git configuration for bootstrap */
  var __natstackGitConfig: GitConfig | null | undefined;
  /** PubSub configuration for real-time messaging */
  var __natstackPubSubConfig: PubSubConfig | null | undefined;
  /** Environment variables */
  var __natstackEnv: Record<string, string> | undefined;
}

export interface InjectedConfig {
  id: string;
  kind: "panel" | "worker";
  parentId: string | null;
  initialTheme: "light" | "dark";
  gitConfig: GitConfig | null;
  pubsubConfig: PubSubConfig | null;
  env: Record<string, string>;
}

// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __natstackId?: string;
  __natstackKind?: "panel" | "worker";
  __natstackParentId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGitConfig?: GitConfig | null;
  __natstackPubSubConfig?: PubSubConfig | null;
  __natstackEnv?: Record<string, string>;
};

/**
 * Get the injected configuration from globals.
 */
export function getInjectedConfig(): InjectedConfig {
  if (typeof g.__natstackId === "undefined" || !g.__natstackId) {
    throw new Error(
      "NatStack runtime globals not found. Expected __natstackId to be defined."
    );
  }

  return {
    id: g.__natstackId,
    kind: g.__natstackKind ?? "panel",
    parentId:
      typeof g.__natstackParentId === "string" && g.__natstackParentId.length > 0
        ? g.__natstackParentId
        : null,
    initialTheme: g.__natstackInitialTheme === "dark" ? "dark" : "light",
    gitConfig: g.__natstackGitConfig ?? null,
    pubsubConfig: g.__natstackPubSubConfig ?? null,
    env: g.__natstackEnv ?? {},
  };
}