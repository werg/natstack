/**
 * Source Extractor — extracts source files from git at specific commits.
 *
 * Before building, we extract source files at the correct git ref into a temp
 * directory so esbuild reads the content that matches the EV, not whatever
 * happens to be checked out in the working tree.
 *
 * Uses `git archive` piped to `tar` for extraction — no shell involved.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import { getCommitAt, resolveMainRef } from "./effectiveVersion.js";

// ---------------------------------------------------------------------------
// Git Archive Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the full git tree at a specific commit into a target directory.
 * Uses `git archive --format=tar <commit>` piped to `tar -x -C <dir>`.
 */
function extractGitTree(
  repoPath: string,
  commitSha: string,
  targetDir: string,
): void {
  // git archive outputs tar to stdout
  const archive = spawnSync("git", ["archive", "--format=tar", commitSha], {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024, // 100MB
  });

  if (archive.status !== 0) {
    const stderr = archive.stderr?.toString() ?? "";
    throw new Error(
      `git archive failed for ${repoPath} at ${commitSha}: ${stderr}`,
    );
  }

  // Pipe archive output into tar to extract
  const extract = spawnSync("tar", ["-x", "-C", targetDir], {
    input: archive.stdout,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });

  if (extract.status !== 0) {
    const stderr = extract.stderr?.toString() ?? "";
    throw new Error(
      `tar extract failed for ${repoPath} at ${commitSha}: ${stderr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Transitive Dependency Collection
// ---------------------------------------------------------------------------

/**
 * Walk internalDeps recursively to collect all nodes needed for a build.
 * Returns the target node plus all its transitive internal dependencies.
 */
export function collectTransitiveInternalDeps(
  node: GraphNode,
  graph: PackageGraph,
): GraphNode[] {
  const visited = new Set<string>();
  const result: GraphNode[] = [];

  function walk(n: GraphNode): void {
    if (visited.has(n.name)) return;
    visited.add(n.name);

    for (const depName of n.internalDeps) {
      const dep = graph.tryGet(depName);
      if (dep) walk(dep);
    }

    result.push(n);
  }

  walk(node);
  return result;
}

// ---------------------------------------------------------------------------
// Source Extraction for Build
// ---------------------------------------------------------------------------

export interface ExtractedSource {
  /** Root directory containing extracted source (temp dir) */
  sourceRoot: string;
  /** Clean up the extracted source */
  cleanup(): void;
}

/**
 * Extract source files from git for a unit and all its transitive internal deps.
 *
 * Phase 1 (sync): Resolve commit SHAs for every node — prefers pre-captured
 * commits from commitMap (built by pushTrigger from persisted ref state), falls
 * back to resolving from git when absent (cold-start / on-demand paths). All SHAs
 * captured before any extraction begins, so concurrent pushes can't create
 * inconsistency.
 *
 * Phase 2 (sync): Extract each node at its captured SHA via git archive.
 *
 * Preserves relative paths: <sourceRoot>/panels/chat/, <sourceRoot>/packages/core/
 */
export function extractSourceForBuild(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot: string,
  commitMap?: Map<string, string>,
): ExtractedSource {
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "natstack-source-"),
  );

  // Collect all nodes needed for this build
  const nodes = collectTransitiveInternalDeps(unit, graph);

  // Phase 1: Resolve commit SHAs — prefer pre-captured, fall back to git
  const resolvedMap = new Map<string, string>();
  for (const node of nodes) {
    const preCapture = commitMap?.get(node.name);
    if (preCapture) {
      resolvedMap.set(node.name, preCapture);
    } else {
      // Resolve current main ref (cold-start / on-demand fallback)
      const ref = resolveMainRef(node.path);
      const sha = getCommitAt(node.path, ref);
      if (!sha) {
        throw new Error(
          `Cannot resolve commit for ${node.name} at ${node.path}`,
        );
      }
      resolvedMap.set(node.name, sha);
    }
  }

  // Phase 2: Extract each node at its captured SHA
  try {
    for (const node of nodes) {
      const sha = resolvedMap.get(node.name)!;
      const relPath = path.relative(workspaceRoot, node.path);
      const extractTarget = path.join(sourceRoot, relPath);
      fs.mkdirSync(extractTarget, { recursive: true });
      extractGitTree(node.path, sha, extractTarget);
    }
  } catch (error) {
    // Clean up on extraction failure
    try {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }

  return {
    sourceRoot,
    cleanup() {
      try {
        fs.rmSync(sourceRoot, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}
