import * as fs from "fs";
import * as path from "path";

// Re-export types from shared types (canonical definitions)
export type {
  RepoArgSpec,
  Panel,
  PanelSnapshot,
  PanelManifest,
  ChildSpec,
  EnvArgSchema,
  ShellPage,
} from "../shared/types.js";

import type { PanelManifest } from "../shared/types.js";

/**
 * Load and validate a panel manifest from package.json.
 * Reads the natstack field and merges top-level dependencies.
 */
export function loadPanelManifest(panelPath: string): PanelManifest {
  if (!path.isAbsolute(panelPath)) {
    throw new Error(`loadPanelManifest requires absolute path, got relative: ${panelPath}`);
  }
  const packageJsonPath = path.join(panelPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in ${panelPath}`);
  }

  const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
  const packageJson = JSON.parse(packageContent) as Record<string, unknown>;

  if (!packageJson["natstack"]) {
    throw new Error(`package.json in ${panelPath} must include a 'natstack' field`);
  }

  const manifest = packageJson["natstack"] as PanelManifest;

  if (!manifest.title) {
    throw new Error("natstack.title must be specified in package.json");
  }

  // Merge package.json dependencies with natstack.dependencies
  const pkgDeps = packageJson["dependencies"] as Record<string, string> | undefined;
  if (pkgDeps) {
    manifest.dependencies = {
      ...manifest.dependencies,
      ...pkgDeps,
    };
  }

  return manifest;
}

export interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

export type PanelEventPayload =
  | { type: "child-creation-error"; url: string; error: string }
  | { type: "focus" }
  | { type: "theme"; theme: "light" | "dark" };

// Re-export accessor functions for panel state
export {
  getCurrentSnapshot,
  getPanelSource,
  getPanelOptions,
  getPanelEnv,
  getPanelRepoArgs,
  getPanelContextId,
  getInjectHostThemeVariables,
  getSourcePage,
  getBrowserResolvedUrl,
  getPanelStateArgs,
  createSnapshot,
} from "../shared/panel/accessors.js";
