/**
 * Git version provisioning for panel builds.
 *
 * This module is maintained for backward compatibility.
 * New code should use the shared build functions from ./build/sharedBuild.ts.
 *
 * @deprecated Use provisionSource and related functions from ./build/sharedBuild.js instead
 */

// Re-export types and functions from sharedBuild.ts
export {
  type VersionSpec,
  type ProvisionResult,
  type ProvisionProgress,
  provisionSource,
  resolveTargetCommit,
  getGitCommit,
  isWorktreeDirty,
  assertCleanWorktree,
  checkWorktreeClean,
  checkGitRepository,
} from "./build/sharedBuild.js";

// Import for backward compatibility wrapper
import {
  provisionSource,
  type VersionSpec,
  type ProvisionResult,
  type ProvisionProgress,
} from "./build/sharedBuild.js";

/**
 * Provision panel source code at a specific version.
 *
 * @deprecated Use provisionSource from ./build/sharedBuild.js instead
 *
 * @param panelsRoot - Absolute path to the workspace root
 * @param panelPath - Relative path to the panel within workspace (e.g., "panels/child")
 * @param version - Optional version specifier (branch, commit, or tag)
 * @param onProgress - Optional progress callback
 */
export async function provisionPanelVersion(
  panelsRoot: string,
  panelPath: string,
  version?: VersionSpec,
  onProgress?: (progress: ProvisionProgress) => void
): Promise<ProvisionResult> {
  return provisionSource({
    sourceRoot: panelsRoot,
    sourcePath: panelPath,
    version,
    onProgress,
  });
}
