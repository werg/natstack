/**
 * PackageLinker - Tree-aware hard-linking from store to node_modules.
 *
 * Key features:
 * - Preserves Arborist's tree structure for proper peer dep handling
 * - Creates hard links for regular files (efficient disk usage)
 * - Recreates symlinks (can't hard-link symlinks)
 * - Creates .bin directory with symlinks to executables
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type Arborist from "@npmcli/arborist";
import pLimit from "p-limit";
import { PackageStore, getPackageStore } from "./store.js";
import { PackageFetcher, type PackageSpec } from "./fetcher.js";

// Type alias for Arborist Node (from @types/npmcli__arborist)
type Node = Arborist.Node;

/**
 * Serialized tree entry for caching.
 */
export interface SerializedTreeEntry {
  name: string;
  version: string;
  integrity: string;
  /** Relative path from node_modules root (e.g., "react" or "pkg-a/node_modules/react") */
  location: string;
  /** Binary entries: { binName: relativePath } */
  bins?: Record<string, string>;
}

/**
 * Serialized tree for caching resolution results.
 */
export interface SerializedTree {
  packages: SerializedTreeEntry[];
}

/**
 * PackageLinker links packages from the content-addressed store to node_modules.
 */
export class PackageLinker {
  private store: PackageStore;
  private fetcher: PackageFetcher;

  constructor(store: PackageStore, fetcher: PackageFetcher) {
    this.store = store;
    this.fetcher = fetcher;
  }

  /**
   * Link a resolved dependency tree to node_modules.
   * Preserves Arborist's tree structure for proper peer dep handling.
   *
   * @param targetDir - The deps directory (parent of node_modules)
   * @param tree - Arborist's ideal tree (root node)
   */
  async link(targetDir: string, tree: Node): Promise<void> {
    const nodeModulesDir = path.join(targetDir, "node_modules");

    // Clean existing node_modules
    if (fs.existsSync(nodeModulesDir)) {
      await fs.promises.rm(nodeModulesDir, { recursive: true, force: true });
    }
    await fs.promises.mkdir(nodeModulesDir, { recursive: true });

    // Walk tree recursively, respecting nested node_modules for peer deps
    await this.linkNode(tree, nodeModulesDir);

    // Create .bin directory with symlinks
    await this.createBinLinks(tree, nodeModulesDir);
  }

  /**
   * Link from a cached/serialized tree (skips Arborist resolution).
   */
  async linkFromCache(targetDir: string, serializedTree: SerializedTree): Promise<void> {
    const nodeModulesDir = path.join(targetDir, "node_modules");

    // Clean existing node_modules
    if (fs.existsSync(nodeModulesDir)) {
      await fs.promises.rm(nodeModulesDir, { recursive: true, force: true });
    }
    await fs.promises.mkdir(nodeModulesDir, { recursive: true });

    // Pre-create all package directories (eliminates mkdir races during parallel linking)
    await this.preCreateDirectories(nodeModulesDir, serializedTree.packages);

    // Parallel linking - each package links to a distinct directory subtree
    const limit = pLimit(20);
    await Promise.all(
      serializedTree.packages.map((entry) =>
        limit(async () => {
          const linkPath = path.join(nodeModulesDir, entry.location);
          await this.store.linkPackage(entry.name, entry.version, linkPath);
        })
      )
    );

    // Create .bin directory (sequential, small number of entries)
    await this.createBinLinksFromCache(serializedTree, nodeModulesDir);
  }

  /**
   * Pre-create all package directories to eliminate mkdir races during parallel linking.
   */
  private async preCreateDirectories(
    nodeModulesDir: string,
    packages: SerializedTreeEntry[]
  ): Promise<void> {
    const dirs = new Set<string>();

    for (const entry of packages) {
      const pkgDir = path.join(nodeModulesDir, entry.location);
      dirs.add(pkgDir);

      // Add parent for scoped packages (@types/node -> @types/)
      const parent = path.dirname(pkgDir);
      if (parent !== nodeModulesDir) {
        dirs.add(parent);
      }
    }

    // Sort shallow-to-deep, create sequentially to ensure parents exist before children
    const sorted = [...dirs].sort(
      (a, b) => a.split(path.sep).length - b.split(path.sep).length
    );
    for (const dir of sorted) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Recursively link a node and its children.
   * Children may be hoisted (flat) or nested (peer dep isolation).
   */
  private async linkNode(node: Node, nodeModulesDir: string): Promise<void> {
    for (const child of node.children.values()) {
      // Skip workspace links (local packages)
      if (child.isLink) continue;

      const pkg = child.package;
      const name = pkg.name;
      const version = pkg.version;

      if (!name || !version) continue;

      // Determine link location (respects Arborist's hoisting decisions)
      // For scoped packages like @types/node, split creates ["@types", "node"]
      const linkPath = path.join(nodeModulesDir, ...name.split("/"));

      // Hard link files, recreate symlinks
      await this.store.linkPackage(name, version, linkPath);

      // If child has nested node_modules (peer dep isolation), recurse
      if (child.children.size > 0) {
        const nestedModules = path.join(linkPath, "node_modules");
        await this.linkNode(child, nestedModules);
      }
    }
  }

  /**
   * Create .bin symlinks for executable packages.
   */
  private async createBinLinks(tree: Node, nodeModulesDir: string): Promise<void> {
    const binDir = path.join(nodeModulesDir, ".bin");
    let binDirCreated = false;

    const createBinDir = async () => {
      if (!binDirCreated) {
        await fs.promises.mkdir(binDir, { recursive: true });
        binDirCreated = true;
      }
    };

    for (const child of tree.children.values()) {
      if (child.isLink) continue;

      const bins = child.package.bin;
      if (!bins) continue;

      await createBinDir();

      // bins can be a string (single bin with package name) or object (multiple bins)
      const binEntries: Array<[string, string]> =
        typeof bins === "string"
          ? [[child.package.name?.split("/").pop() ?? child.name, bins]]
          : Object.entries(bins).filter((entry): entry is [string, string] => typeof entry[1] === "string");

      for (const [binName, binPath] of binEntries) {
        // Create relative symlink: .bin/tsc -> ../typescript/bin/tsc
        const packagePath = child.package.name?.split("/") ?? [child.name];
        const target = path.join("..", ...packagePath, binPath);
        const link = path.join(binDir, binName);

        try {
          // Remove existing symlink if present
          try {
            await fs.promises.unlink(link);
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await fs.promises.symlink(target, link);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
    }
  }

  /**
   * Create .bin symlinks from cached tree.
   */
  private async createBinLinksFromCache(
    serializedTree: SerializedTree,
    nodeModulesDir: string
  ): Promise<void> {
    const binDir = path.join(nodeModulesDir, ".bin");
    let binDirCreated = false;

    const createBinDir = async () => {
      if (!binDirCreated) {
        await fs.promises.mkdir(binDir, { recursive: true });
        binDirCreated = true;
      }
    };

    for (const entry of serializedTree.packages) {
      if (!entry.bins) continue;

      await createBinDir();

      for (const [binName, binPath] of Object.entries(entry.bins)) {
        // Create relative symlink
        const target = path.join("..", entry.location, binPath);
        const link = path.join(binDir, binName);

        try {
          try {
            await fs.promises.unlink(link);
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          await fs.promises.symlink(target, link);
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
    }
  }
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Collect all packages from an Arborist tree for fetching.
 * Deduplicates by name@version.
 */
export function collectPackagesFromTree(tree: Node): PackageSpec[] {
  const result: PackageSpec[] = [];
  const seen = new Set<string>();

  function walk(node: Node) {
    for (const child of node.children.values()) {
      if (child.isLink) continue;

      const pkg = child.package;
      const name = pkg.name;
      const version = pkg.version;

      if (!name || !version) continue;

      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          name,
          version,
          integrity: child.integrity ?? (pkg as { _integrity?: string })._integrity ?? "",
        });
      }

      // Recurse into nested node_modules
      if (child.children.size > 0) {
        walk(child);
      }
    }
  }

  walk(tree);
  return result;
}

/**
 * Serialize an Arborist tree for caching.
 * Captures package locations and bin entries.
 */
export function serializeTree(tree: Node): SerializedTree {
  const packages: SerializedTreeEntry[] = [];

  function walk(node: Node, locationPrefix: string) {
    for (const child of node.children.values()) {
      if (child.isLink) continue;

      const pkg = child.package;
      const name = pkg.name;
      const version = pkg.version;

      if (!name || !version) continue;

      // Location is the path under node_modules
      const location = locationPrefix ? `${locationPrefix}/node_modules/${name}` : name;

      // Extract bin entries
      let bins: Record<string, string> | undefined;
      if (pkg.bin) {
        if (typeof pkg.bin === "string") {
          bins = { [name.split("/").pop()!]: pkg.bin };
        } else {
          // Filter out undefined values
          bins = Object.fromEntries(
            Object.entries(pkg.bin).filter((entry): entry is [string, string] => typeof entry[1] === "string")
          );
          if (Object.keys(bins).length === 0) bins = undefined;
        }
      }

      packages.push({
        name,
        version,
        integrity: child.integrity ?? (pkg as { _integrity?: string })._integrity ?? "",
        location,
        bins,
      });

      // Recurse into nested node_modules
      if (child.children.size > 0) {
        walk(child, location);
      }
    }
  }

  walk(tree, "");
  return { packages };
}

/**
 * Hash dependencies object for cache key.
 */
export function hashDependencies(deps: Record<string, string>): string {
  const sorted = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// =============================================================================
// Factory function
// =============================================================================

/**
 * Create a PackageLinker instance.
 */
export async function createPackageLinker(fetcher: PackageFetcher): Promise<PackageLinker> {
  const store = await getPackageStore();
  return new PackageLinker(store, fetcher);
}
