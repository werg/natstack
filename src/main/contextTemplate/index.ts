/**
 * Context Template System
 *
 * Provides Docker-like layered filesystem inheritance for panel contexts.
 * Templates define git repositories to clone into specific paths within
 * a context's filesystem scope (OPFS).
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   resolveTemplate,
 *   computeImmutableSpec,
 *   createContextId,
 *   ensureContextPartitionInitialized,
 * } from "./contextTemplate/index.js";
 *
 * // Resolve a template spec to its full definition
 * const resolved = await resolveTemplate("templates/my-template#main");
 *
 * // Compute the immutable spec (detects conflicts)
 * const immutableSpec = computeImmutableSpec(resolved);
 *
 * // Generate a context ID
 * const contextId = createContextId(immutableSpec.specHash, "my-panel");
 *
 * // Initialize a context partition from the template (OPFS-based)
 * await ensureContextPartitionInitialized(contextId, immutableSpec, gitConfig);
 * ```
 */

// Types
export type {
  GitSpec,
  ContextTemplateYaml,
  ParsedGitSpec,
  ResolvedGitSpec,
  ResolvedTemplate,
  ImmutableTemplateSpec,
  TemplateBuildState,
  TemplateBuild,
  TemplateConflict,
  TemplateProgress,
  ParsedContextId,
  ContextInitMarker,
  ResolveOptions,
  BuildOptions,
  InitOptions,
  PartitionBuildGitConfig,
} from "./types.js";

export {
  TemplateConflictError,
  CircularExtendsError,
  PathValidationError,
} from "./types.js";

// Context ID functions
export {
  parseContextId,
  isValidContextId,
  createContextId,
  generateInstanceId,
  deriveInstanceIdFromPanelId,
  getTemplateSpecHashFromContextId,
} from "./contextId.js";

// Parser functions
export {
  parseGitSpec,
  isCommitHash,
  validateTargetPath,
  parseTemplateYaml,
  loadTemplateFromDir,
  hasTemplateFile,
  validateTemplateStructure,
  formatGitSpec,
  TEMPLATE_FILE_NAME,
} from "./parser.js";

// Resolver functions
export {
  resolveTemplate,
  resolveTemplateCommit,
  templateExists,
} from "./resolver.js";

// Spec hash functions
export {
  flattenTemplate,
  computeImmutableSpec,
  computeStructureHash,
  specsAreEqual,
  getShortHash,
} from "./specHash.js";

// Cache functions
export {
  isTemplateBuildReady,
  loadTemplateBuildMeta,
  saveTemplateBuildMeta,
  getCachedTemplateSpec,
  listTemplateBuilds,
  cleanupOrphanedTempBuilds,
  cleanupStaleLocks,
  removeTemplateBuild,
  getCacheStats,
} from "./cache.js";

// Partition copier functions
export {
  copyPartitionFolder,
  cleanupPartition,
  partitionExists,
  listPartitions,
  getPartitionSize,
} from "./partitionCopier.js";

// Partition builder functions
export {
  getTemplatePartitionPath,
  isTemplatePartitionReady,
  ensureTemplatePartition,
  buildTemplatePartition,
  handleTemplateComplete,
  type TemplateCompleteResult,
} from "./partitionBuilder.js";

// Discovery functions
export { listAvailableTemplates } from "./discovery.js";

// Re-export path helpers
export {
  getTemplateBuildDirectory,
  getTemplateBuildPath,
  getTemplateBuildLockPath,
  getPartitionsDirectory,
  getPartitionPath,
  getTemplatePartitionName,
  getPartitionBuildLockPath,
} from "../paths.js";

// High-level convenience functions

import type { ImmutableTemplateSpec, TemplateProgress, GitSpec, PartitionBuildGitConfig } from "./types.js";
import { resolveTemplate } from "./resolver.js";
import { computeImmutableSpec } from "./specHash.js";
import { createContextId } from "./contextId.js";
import { ensureTemplatePartition } from "./partitionBuilder.js";
import { copyPartitionFolder, partitionExists } from "./partitionCopier.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("ContextTemplate");

/**
 * Create a context ID from a template git spec.
 * Resolves the template, computes the immutable spec, and generates the ID.
 *
 * @param templateGitSpec - Git spec for the template
 * @param instanceId - Instance identifier
 * @returns The generated context ID
 */
export async function createContextIdFromTemplateSpec(
  templateGitSpec: GitSpec,
  instanceId: string
): Promise<string> {
  const resolved = await resolveTemplate(templateGitSpec);
  const immutable = computeImmutableSpec(resolved);
  return createContextId(immutable.specHash, instanceId);
}

/**
 * Ensure a context partition is initialized from its template.
 * Uses OPFS-based storage via hidden worker for template building.
 * This is the method for safe (sandboxed) panels that use OPFS.
 *
 * Flow:
 * 1. Check if context partition already exists
 * 2. If not, ensure template partition exists (build via hidden worker if needed)
 * 3. Copy template partition to context partition
 *
 * @param contextId - The context ID (must be template-based)
 * @param spec - The immutable template spec
 * @param gitConfig - Git configuration for cloning (serverUrl and token)
 * @param onProgress - Optional progress callback
 */
export async function ensureContextPartitionInitialized(
  contextId: string,
  spec: ImmutableTemplateSpec,
  gitConfig: PartitionBuildGitConfig,
  onProgress?: (progress: TemplateProgress) => void
): Promise<void> {
  log.verbose(` ensureContextPartitionInitialized:`, {
    contextId,
    specHash: spec.specHash.slice(0, 12),
    structureEntries: Object.keys(spec.structure).length,
  });

  // Check if partition already exists
  if (partitionExists(contextId)) {
    log.verbose(` Partition already exists for context`);
    return;
  }

  // Ensure template partition exists (build if needed)
  log.verbose(` Ensuring template partition...`);
  onProgress?.({ stage: "cloning", message: "Building template partition..." });
  const templatePartitionName = await ensureTemplatePartition(spec, gitConfig, onProgress);

  // Copy template partition to context partition
  log.verbose(` Copying partition to context...`);
  onProgress?.({ stage: "copying", message: "Initializing context partition..." });
  await copyPartitionFolder(templatePartitionName, contextId);

  log.verbose(` Context partition initialized successfully`);
}
