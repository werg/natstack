/**
 * Immutable Template Spec Hashing
 *
 * Generates deterministic hashes for template specifications.
 * Two templates with the same specHash are guaranteed to be identical.
 */

import * as crypto from "crypto";
import type {
  ResolvedTemplate,
  ResolvedGitSpec,
  ImmutableTemplateSpec,
  TemplateConflict,
} from "./types.js";
import { TemplateConflictError } from "./types.js";

/**
 * Entry with source tracking for conflict detection
 */
interface StructureEntryWithSource extends ResolvedGitSpec {
  source: string;
}

/**
 * Flatten a resolved template tree into a single structure map.
 * Merges inherited structures with child structures, detecting conflicts.
 *
 * @param resolved - The resolved template to flatten
 * @param sourceName - Name to use for this template in conflict messages
 * @returns The flattened structure and any conflicts found
 */
export function flattenTemplate(
  resolved: ResolvedTemplate,
  sourceName?: string
): {
  structure: Record<string, ResolvedGitSpec>;
  conflicts: TemplateConflict[];
} {
  const source = sourceName ?? resolved.name ?? resolved.sourceSpec;

  // Start with parent structure if extends
  let baseStructure: Record<string, StructureEntryWithSource> = {};

  if (resolved.extends) {
    const parent = flattenTemplate(
      resolved.extends.resolvedTemplate,
      resolved.extends.spec
    );

    // Copy parent structure with source tracking
    for (const [path, spec] of Object.entries(parent.structure)) {
      baseStructure[path] = {
        ...spec,
        source: resolved.extends.spec,
      };
    }
  }

  // Check for conflicts and merge current structure
  const conflicts: TemplateConflict[] = [];

  for (const [targetPath, spec] of Object.entries(resolved.structure)) {
    const existing = baseStructure[targetPath];

    if (existing) {
      // Conflict check: same path with different (repo, commit) tuple
      const isDifferent =
        existing.repo !== spec.repo ||
        existing.resolvedCommit !== spec.resolvedCommit;

      if (isDifferent) {
        conflicts.push({
          targetPath,
          specs: [
            {
              source: existing.source,
              spec: existing.originalSpec,
              repo: existing.repo,
              resolvedCommit: existing.resolvedCommit,
            },
            {
              source,
              spec: spec.originalSpec,
              repo: spec.repo,
              resolvedCommit: spec.resolvedCommit,
            },
          ],
        });
      }
      // If same (repo, commit), no conflict - child effectively confirms parent
    }

    // Child always wins for the final structure (if no conflict error)
    baseStructure[targetPath] = { ...spec, source };
  }

  // Remove source annotation for final output
  const finalStructure: Record<string, ResolvedGitSpec> = {};
  for (const [path, spec] of Object.entries(baseStructure)) {
    const { source: _, ...rest } = spec;
    finalStructure[path] = rest;
  }

  return { structure: finalStructure, conflicts };
}

/**
 * Compute an immutable spec from a resolved template.
 * Flattens the inheritance chain and generates a deterministic hash.
 *
 * @param resolved - The resolved template
 * @returns The immutable spec with hash
 * @throws TemplateConflictError if conflicts exist in the inheritance chain
 */
export function computeImmutableSpec(
  resolved: ResolvedTemplate
): ImmutableTemplateSpec {
  const { structure, conflicts } = flattenTemplate(resolved);

  if (conflicts.length > 0) {
    throw new TemplateConflictError(conflicts);
  }

  // Build inheritance chain for debugging
  const inheritanceChain = buildInheritanceChain(resolved);

  // Generate deterministic hash
  const specHash = computeStructureHash(structure);

  return {
    specHash,
    structure,
    inheritanceChain,
  };
}

/**
 * Build the inheritance chain from a resolved template.
 *
 * @param resolved - The resolved template
 * @returns Array of template identifiers from root to leaf
 */
function buildInheritanceChain(resolved: ResolvedTemplate): string[] {
  const chain: string[] = [];

  // Walk up the inheritance chain
  let current: ResolvedTemplate | undefined = resolved;
  while (current) {
    const identifier = current.name ?? current.sourceSpec;
    chain.unshift(identifier); // Add to front (root first)
    current = current.extends?.resolvedTemplate;
  }

  return chain;
}

/**
 * Compute a deterministic SHA256 hash for a structure map.
 *
 * @param structure - The flattened structure
 * @returns SHA256 hash as hex string
 */
export function computeStructureHash(
  structure: Record<string, ResolvedGitSpec>
): string {
  // Sort paths alphabetically for determinism
  const sortedPaths = Object.keys(structure).sort();

  // Build canonical entries: [[path, {repo, commit}], ...]
  const canonicalEntries: Array<[string, { repo: string; commit: string }]> = [];

  for (const path of sortedPaths) {
    const spec = structure[path];
    if (!spec) continue; // Should never happen since we got path from Object.keys
    canonicalEntries.push([
      path,
      {
        repo: spec.repo,
        commit: spec.resolvedCommit,
      },
    ]);
  }

  // Generate canonical JSON (keys already sorted by construction)
  const canonicalJson = JSON.stringify(canonicalEntries);

  // Compute SHA256 hash
  return crypto.createHash("sha256").update(canonicalJson).digest("hex");
}

/**
 * Check if two immutable specs are equivalent.
 * Compares by hash for efficiency.
 *
 * @param a - First spec
 * @param b - Second spec
 * @returns true if specs are equivalent
 */
export function specsAreEqual(
  a: ImmutableTemplateSpec,
  b: ImmutableTemplateSpec
): boolean {
  return a.specHash === b.specHash;
}

/**
 * Get a short hash prefix suitable for display or context IDs.
 *
 * @param spec - The immutable spec
 * @param length - Number of characters (default: 12)
 * @returns Truncated hash
 */
export function getShortHash(spec: ImmutableTemplateSpec, length = 12): string {
  return spec.specHash.slice(0, length);
}
