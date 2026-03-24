/**
 * Workspace tree discovery — recursively scans the workspace to find git repos,
 * extracts metadata (package.json, SKILL.md), and maintains a cached tree.
 */

import * as path from "path";
import * as fsPromises from "fs/promises";
import type { WorkspaceNode, WorkspaceTree } from "../types.js";

/**
 * Manages workspace tree scanning, caching, and repo path discovery.
 */
export class WorkspaceTreeManager {
  private cachedTree: WorkspaceTree | null = null;
  private treeCacheTime: number = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second cache
  /** Track discovered repo paths for validation (normalized with forward slashes) */
  readonly discoveredRepoPaths: Set<string> = new Set();
  private reposPath: string;

  constructor(reposPath: string) {
    this.reposPath = reposPath;
  }

  /**
   * Get the workspace tree of all git repos.
   * Caches result for performance.
   */
  async getWorkspaceTree(): Promise<WorkspaceTree> {
    const now = Date.now();
    if (this.cachedTree && now - this.treeCacheTime < this.CACHE_TTL_MS) {
      return this.cachedTree;
    }

    this.discoveredRepoPaths.clear();

    const children = await this.scanDirectory(this.reposPath, "");

    this.cachedTree = { children };
    this.treeCacheTime = now;
    return this.cachedTree;
  }

  /**
   * Invalidate the cached tree (call after repo operations).
   * Also clears discovered paths to ensure consistency.
   */
  invalidateTreeCache(): void {
    this.cachedTree = null;
    this.discoveredRepoPaths.clear();
  }

  /**
   * Normalize a path to use forward slashes.
   */
  normalizePath(repoPath: string): string {
    return repoPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }

  /**
   * Check if a path is a valid discovered repo.
   * Validates against the cached tree to prevent directory traversal.
   */
  isValidRepoPath(repoPath: string): boolean {
    const normalized = this.normalizePath(repoPath);
    if (!normalized) {
      return false;
    }
    if (normalized.includes("..") || path.isAbsolute(repoPath)) {
      return false;
    }
    return this.discoveredRepoPaths.has(normalized);
  }

  /**
   * Convert a relative repo path to absolute path.
   */
  toAbsolutePath(repoPath: string): string {
    const normalized = this.normalizePath(repoPath);
    return path.join(this.reposPath, normalized);
  }

  /**
   * Check if a directory is a git repo (async).
   */
  private async isGitRepoAsync(absolutePath: string): Promise<boolean> {
    try {
      await fsPromises.access(path.join(absolutePath, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively scan a directory, stopping at git repo boundaries.
   */
  private async scanDirectory(absolutePath: string, relativePath: string): Promise<WorkspaceNode[]> {
    const nodes: WorkspaceNode[] = [];

    try {
      const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const childAbsPath = path.join(absolutePath, entry.name);
        const childRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        const isGitRepo = await this.isGitRepoAsync(childAbsPath);

        const node: WorkspaceNode = {
          name: entry.name,
          path: childRelPath,
          isGitRepo,
          children: [],
        };

        if (isGitRepo) {
          this.discoveredRepoPaths.add(childRelPath);
          const metadata = await this.extractMetadata(childAbsPath);
          node.launchable = metadata.launchable;
          node.packageInfo = metadata.packageInfo;
          node.skillInfo = metadata.skillInfo;
        } else {
          node.children = await this.scanDirectory(childAbsPath, childRelPath);
          if (node.children.length === 0) continue;
        }

        nodes.push(node);
      }
    } catch (error) {
      console.warn(`[WorkspaceTree] Failed to scan ${absolutePath}:`, error);
    }

    return nodes.sort((a, b) => {
      const aIsFolder = !a.isGitRepo && a.children.length > 0;
      const bIsFolder = !b.isGitRepo && b.children.length > 0;
      if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Parse YAML frontmatter from a markdown file.
   */
  private parseYamlFrontmatter(content: string): Record<string, string> | undefined {
    if (!content.startsWith("---\n")) {
      return undefined;
    }
    const endIndex = content.indexOf("\n---", 4);
    if (endIndex === -1) {
      return undefined;
    }
    const yamlContent = content.slice(4, endIndex);

    const result: Record<string, string> = {};
    for (const line of yamlContent.split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && value) {
        result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  /**
   * Extract metadata from a directory's package.json and SKILL.md.
   */
  private async extractMetadata(absolutePath: string): Promise<{
    launchable?: WorkspaceNode["launchable"];
    packageInfo?: WorkspaceNode["packageInfo"];
    skillInfo?: WorkspaceNode["skillInfo"];
  }> {
    const result: {
      launchable?: WorkspaceNode["launchable"];
      packageInfo?: WorkspaceNode["packageInfo"];
      skillInfo?: WorkspaceNode["skillInfo"];
    } = {};

    const packageJsonPath = path.join(absolutePath, "package.json");
    try {
      const content = await fsPromises.readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      if (packageJson.name) {
        result.packageInfo = {
          name: packageJson.name as string,
          version: packageJson.version as string | undefined,
        };
      }

      if (packageJson.natstack) {
        const ns = packageJson.natstack;
        result.launchable = {
          title: ns.title || packageJson.name || path.basename(absolutePath),
          ...(ns.hiddenInLauncher ? { hidden: true } : {}),
        };
      }
    } catch {
      // No package.json or invalid JSON
    }

    const skillMdPath = path.join(absolutePath, "SKILL.md");
    try {
      const content = await fsPromises.readFile(skillMdPath, "utf-8");
      const frontmatter = this.parseYamlFrontmatter(content);
      if (frontmatter && frontmatter["name"] && frontmatter["description"]) {
        result.skillInfo = {
          name: frontmatter["name"],
          description: frontmatter["description"],
        };
      }
    } catch {
      // No SKILL.md
    }

    return result;
  }
}
