/**
 * Repo discovery — enumerate the first-class versioned repos of a workspace
 * (W3). Two shapes (per the re-architecture plan):
 *
 *  - **Container sections** (`packages/ panels/ workers/ extensions/ apps/
 *    about/ skills/ templates/ projects/`): each immediate subdir
 *    `section/<name>` is a repo. Build units come from the package graph;
 *    `projects/<vault>` are content-only repos.
 *  - **Flat sections** that hold files directly (today only `meta`): the section
 *    itself is one repo with a single-segment repoPath.
 *
 * The repo set is derived from the live workspace view's file list (which is the
 * composed union of every repo's `main`), so discovery is purely a function of
 * tracked paths — no disk walk required.
 */

import {
  CONTAINER_SECTIONS,
  CONTENT_SECTIONS,
  FLAT_SECTIONS,
  isFlatSection,
} from "@natstack/shared/runtime/entitySpec";

export type RepoKind = "build-unit" | "content" | "meta";

export interface DiscoveredRepo {
  /** Workspace-relative repo path (e.g. `packages/core`, `projects/vault`, `meta`). */
  repoPath: string;
  kind: RepoKind;
}

/**
 * Discover the repo set from a workspace-rooted file-path list. The list is the
 * `listStateFiles` paths of the live workspace view (workspace-relative).
 */
export function discoverRepos(filePaths: string[]): DiscoveredRepo[] {
  const repos = new Map<string, DiscoveredRepo>();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    const section = segments[0];
    if (!section) continue;
    if (FLAT_SECTIONS.has(section)) {
      repos.set(section, { repoPath: section, kind: "meta" });
      continue;
    }
    if (CONTAINER_SECTIONS.has(section) && segments.length >= 2) {
      const name = segments[1];
      if (!name) continue;
      const repoPath = `${section}/${name}`;
      const kind: RepoKind = CONTENT_SECTIONS.has(section) ? "content" : "build-unit";
      repos.set(repoPath, { repoPath, kind });
    }
  }
  return [...repos.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

// Re-export the canonical taxonomy (defined in @natstack/shared/runtime/entitySpec)
// so existing `./repoDiscovery.js` importers keep working unchanged.
export { CONTAINER_SECTIONS, CONTENT_SECTIONS, FLAT_SECTIONS, isFlatSection };
