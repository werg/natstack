import * as fs from "fs";
import * as path from "path";

// Re-export types from shared types (canonical definitions)
export type {
  Panel,
  PanelSnapshot,
  PackageManifest,
  ChildSpec,
} from "./types.js";

import type { PackageManifest } from "./types.js";

/**
 * A panel manifest after `loadPanelManifest` validation: `title` is guaranteed
 * to be a non-empty string. Use this return type when callers need a title
 * without re-asserting.
 */
export type LoadedPanelManifest = PackageManifest & { title: string };

/**
 * Load and validate a panel manifest from package.json.
 *
 * The TypeScript type (`PackageManifest`) is shared with workers, so all fields
 * are optional. This loader enforces panel-specific runtime requirements: a
 * `natstack` block must exist and `title` must be set. It also merges top-level
 * `dependencies` into the manifest for the panel runtime's downstream use.
 */
export function loadPanelManifest(panelPath: string): LoadedPanelManifest {
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

  const manifest = packageJson["natstack"] as PackageManifest;

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

  // Title is guaranteed by the check above; the cast narrows the type.
  return manifest as LoadedPanelManifest;
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
  getPanelContextId,
  getInjectHostThemeVariables,
  getBrowserResolvedUrl,
  getPanelStateArgs,
  createSnapshot,
} from "./panel/accessors.js";
