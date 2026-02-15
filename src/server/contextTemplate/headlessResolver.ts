/**
 * Headless Context Template Resolution
 *
 * Server-side template resolution for the headless/browser-extension environment.
 * Reuses the existing resolver, specHash, and contextId modules from the Electron
 * codebase, but runs entirely server-side since the server has workspace git access.
 *
 * The Electron flow is:
 *   resolveTemplate → computeImmutableSpec → createContextId →
 *   buildTemplatePartition (hidden WebContentsView) → copyPartitionFolder
 *
 * The headless flow is:
 *   resolveTemplate → computeImmutableSpec → createContextId →
 *   expose template spec via API → browser bootstrap populates OPFS
 */

import { resolveTemplate } from "../../main/contextTemplate/resolver.js";
import { computeImmutableSpec } from "../../main/contextTemplate/specHash.js";
import { createContextId, deriveInstanceIdFromPanelId } from "../../main/contextTemplate/contextId.js";
import type { ImmutableTemplateSpec, ResolvedGitSpec } from "../../main/contextTemplate/types.js";
import { getActiveWorkspace } from "../../main/paths.js";
import { createDevLogger } from "../../main/devLog.js";

const log = createDevLogger("HeadlessResolver");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved context with all the info needed for OPFS bootstrap */
export interface HeadlessResolvedContext {
  /** Generated context ID (e.g., "safe_tpl_a1b2c3d4e5f6_panels~editor") */
  contextId: string;
  /** First 12 chars of the template spec hash */
  specHashShort: string;
  /** Full spec hash */
  specHash: string;
  /** Flattened structure: OPFS target path → git repo+commit */
  structure: Record<string, ResolvedGitSpec>;
  /** Template inheritance chain (for debugging) */
  inheritanceChain: string[];
}

/** Serializable template spec for the browser bootstrap */
export interface SerializableTemplateSpec {
  /** Full spec hash */
  specHash: string;
  /** First 12 chars */
  specHashShort: string;
  /** OPFS target path → { repo, resolvedCommit } */
  structure: Record<string, { repo: string; commit: string }>;
  /** Inheritance chain (for debugging) */
  inheritanceChain: string[];
}

// ---------------------------------------------------------------------------
// Cache: specHash → ImmutableTemplateSpec
// ---------------------------------------------------------------------------

const specCache = new Map<string, ImmutableTemplateSpec>();

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a template spec to a full context for a panel.
 *
 * This is the headless equivalent of PanelManager.resolveContext():
 * 1. Resolve template inheritance chain
 * 2. Compute immutable spec hash
 * 3. Generate deterministic context ID
 *
 * @param panelId - The panel ID (used to derive instance ID)
 * @param templateSpec - Git spec for the template (e.g., "contexts/default")
 * @returns Resolved context with contextId and structure
 */
export async function resolveHeadlessContext(
  panelId: string,
  templateSpec: string,
): Promise<HeadlessResolvedContext> {
  const workspace = getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace — cannot resolve template");
  }

  log.info(`Resolving template "${templateSpec}" for panel "${panelId}"`);

  // Step 1: Resolve template inheritance chain (git refs → exact commits)
  const resolved = await resolveTemplate(templateSpec);

  // Step 2: Flatten and compute immutable spec hash
  const immutableSpec = computeImmutableSpec(resolved);
  const specHashShort = immutableSpec.specHash.slice(0, 12);

  // Cache the spec for later API lookups
  specCache.set(immutableSpec.specHash, immutableSpec);
  specCache.set(specHashShort, immutableSpec);

  // Step 3: Generate deterministic context ID
  const instanceId = deriveInstanceIdFromPanelId(panelId);
  const contextId = createContextId(immutableSpec.specHash, instanceId);

  log.info(`Resolved: contextId=${contextId}, specHash=${specHashShort}, entries=${Object.keys(immutableSpec.structure).length}`);

  return {
    contextId,
    specHashShort,
    specHash: immutableSpec.specHash,
    structure: immutableSpec.structure,
    inheritanceChain: immutableSpec.inheritanceChain,
  };
}

/**
 * Get a serializable template spec suitable for sending to the browser.
 *
 * The browser bootstrap uses this to know which git repos to fetch
 * and where to write them in OPFS.
 *
 * @param specHash - Full or short (12-char) spec hash
 * @returns Serializable template spec, or null if not cached
 */
export function getSerializableSpec(specHash: string): SerializableTemplateSpec | null {
  const spec = specCache.get(specHash);
  if (!spec) return null;

  const structure: Record<string, { repo: string; commit: string }> = {};
  for (const [targetPath, gitSpec] of Object.entries(spec.structure)) {
    structure[targetPath] = {
      repo: gitSpec.repo,
      commit: gitSpec.resolvedCommit,
    };
  }

  return {
    specHash: spec.specHash,
    specHashShort: spec.specHash.slice(0, 12),
    structure,
    inheritanceChain: spec.inheritanceChain,
  };
}

/**
 * Get the cached immutable spec (full typed version).
 */
export function getCachedSpec(specHash: string): ImmutableTemplateSpec | null {
  return specCache.get(specHash) ?? null;
}

/**
 * Check whether workspace has templates available for resolution.
 */
export function canResolveTemplates(): boolean {
  return getActiveWorkspace() !== null;
}
