/**
 * Workspace source tree scanner. Walks the workspace scope directories on disk
 * and reports repo roots (package.json / SKILL.md) with launchable/package/
 * skill metadata.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";

import type { WorkspaceNode, WorkspaceTree } from "@natstack/shared/types";
import { WORKSPACE_SOURCE_DIRS } from "@natstack/shared/workspace/sourceDirs";
import { discoverPackageGraph, type GraphNode } from "../buildV2/packageGraph.js";

interface ScanCache {
  tree: WorkspaceTree;
  at: number;
}

const TREE_CACHE_TTL_MS = 2_000;

export class WorkspaceTreeScanner {
  private cache: ScanCache | null = null;

  constructor(private readonly workspaceRoot: string) {}

  invalidate(): void {
    this.cache = null;
  }

  async getSourceTree(): Promise<WorkspaceTree> {
    if (this.cache && Date.now() - this.cache.at < TREE_CACHE_TTL_MS) {
      return this.cache.tree;
    }
    const graphByPath = new Map(
      discoverPackageGraph(this.workspaceRoot)
        .allNodes()
        .map((node) => [node.relativePath, node])
    );
    const children: WorkspaceNode[] = [];
    for (const scope of WORKSPACE_SOURCE_DIRS) {
      const scopeAbs = path.join(this.workspaceRoot, scope);
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(scopeAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      if (scope === "meta") {
        // meta is itself a unit root (workspace config), not a scope of units.
        children.push({
          name: "meta",
          path: "meta",
          isUnit: true,
          children: [],
        });
        continue;
      }
      const scopeChildren: WorkspaceNode[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const unitRel = `${scope}/${entry.name}`;
        const node = await this.unitNode(unitRel, entry.name, graphByPath.get(unitRel));
        if (node) scopeChildren.push(node);
      }
      if (scopeChildren.length > 0) {
        children.push({
          name: scope,
          path: scope,
          isUnit: false,
          children: scopeChildren.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
    }
    const tree: WorkspaceTree = { children };
    this.cache = { tree, at: Date.now() };
    return tree;
  }

  private async unitNode(
    unitRel: string,
    name: string,
    graphNode?: GraphNode
  ): Promise<WorkspaceNode | null> {
    const abs = path.join(this.workspaceRoot, unitRel);
    const node: WorkspaceNode = { name, path: unitRel, isUnit: true, children: [] };

    if (graphNode) {
      node.packageInfo = { name: graphNode.name };
      this.applyManifestMetadata(node, unitRel, name, graphNode.manifest);
    } else {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(abs, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
          natstack?: { title?: string; hiddenInLauncher?: boolean; shell?: unknown };
        };
        if (pkg.name) {
          node.packageInfo = { name: pkg.name, ...(pkg.version ? { version: pkg.version } : {}) };
        }
        this.applyManifestMetadata(node, unitRel, name, pkg.natstack);
      } catch {
        // no package.json — may still be a skill
      }
    }

    try {
      const skillRaw = await fs.readFile(path.join(abs, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillRaw)?.[1];
      if (frontmatter) {
        const meta = YAML.parse(frontmatter) as { name?: string; description?: string };
        if (meta?.name) {
          node.skillInfo = { name: meta.name, description: meta.description ?? "" };
        }
      }
    } catch {
      // not a skill
    }

    if (!node.packageInfo && !node.skillInfo) {
      // Bare directory with no unit markers — still listed so the UI can
      // surface it (matches the old tree manager's lenient posture) as long
      // as it has any files.
      try {
        const sub = await fs.readdir(abs);
        if (sub.length === 0) return null;
      } catch {
        return null;
      }
    }
    return node;
  }

  private applyManifestMetadata(
    node: WorkspaceNode,
    unitRel: string,
    name: string,
    manifest: { title?: string; hiddenInLauncher?: boolean } | undefined
  ): void {
    if (!manifest || (!unitRel.startsWith("panels/") && !unitRel.startsWith("about/"))) return;
    node.launchable = {
      type: "app",
      title: manifest.title ?? name,
      ...(manifest.hiddenInLauncher ? { hidden: true } : {}),
    };
  }
}
