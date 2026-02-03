/**
 * Dependency Graph for Build System Cache Invalidation
 *
 * Tracks package dependencies for efficient cache invalidation.
 * Instead of walking the dependency graph at build time to compute
 * cache keys, we maintain a reverse dependency index and invalidate
 * caches when packages are published.
 *
 * Benefits:
 * - O(1) cache lookups instead of O(n) graph walks
 * - Targeted invalidation via consumer tracking
 * - Simpler cache keys (no version hashes needed)
 * - Single source of truth for dependencies
 */

import * as fs from "fs";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { app } from "electron";
import { getPackagesDir } from "./paths.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("DependencyGraph");

const CONSUMERS_CACHE_VERSION = "1";
const CONSUMERS_CACHE_FILENAME = "dependency-consumers.json";

interface ConsumersCacheData {
  version: string;
  consumers: Record<string, string[]>;
}

export class DependencyGraph {
  // Forward: package → packages it depends on
  private forward = new Map<string, Set<string>>();
  // Reverse (transitive): package → all packages that depend on it
  private reverse = new Map<string, Set<string>>();
  // Track which panels/workers use which packages (consumer key → packages)
  private consumers = new Map<string, Set<string>>();

  // Persistence state
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private readonly SAVE_DEBOUNCE_MS = 2000; // 2 seconds

  /**
   * Initialize graph from natstack packages directory.
   */
  async initialize(natstackPackagesDir: string): Promise<void> {
    const packages = await this.discoverPackages(natstackPackagesDir);

    for (const pkg of packages) {
      const deps = this.extractInternalDeps(pkg.packageJson);
      this.forward.set(pkg.name, new Set(deps));
    }

    this.computeTransitiveReverse();
    log.verbose(` Initialized with ${this.forward.size} packages`);
  }

  /**
   * Add workspace packages to the graph.
   */
  async addWorkspace(workspacePath: string): Promise<void> {
    const scopes = ["packages", "panels", "workers", "agents"];
    let addedCount = 0;

    for (const scope of scopes) {
      const scopePath = path.join(workspacePath, scope);
      if (!fs.existsSync(scopePath)) continue;

      const packages = await this.discoverPackages(scopePath);
      for (const pkg of packages) {
        const deps = this.extractInternalDeps(pkg.packageJson);
        this.forward.set(pkg.name, new Set(deps));
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.computeTransitiveReverse();
      log.verbose(` Added ${addedCount} workspace packages`);
    }
  }

  /**
   * Get all packages that would be affected by a change to pkgName.
   * Includes transitive dependents.
   */
  getDependents(pkgName: string): Set<string> {
    return this.reverse.get(pkgName) ?? new Set();
  }

  /**
   * Register that a panel/worker uses certain packages.
   * Called after Arborist resolution to track what packages a consumer depends on.
   *
   * @param consumerKey - Unique key for the consumer (e.g., "panel:/path/to/panel")
   * @param packages - Package names that were resolved for this consumer
   */
  registerConsumer(consumerKey: string, packages: string[]): void {
    // Create or update the consumer's package set
    const consumerPackages = this.consumers.get(consumerKey) ?? new Set();
    for (const pkg of packages) {
      consumerPackages.add(pkg);
    }
    this.consumers.set(consumerKey, consumerPackages);
    this.queueSaveConsumers();
  }

  /**
   * Unregister a consumer (e.g., when a panel is closed or workspace changes).
   */
  unregisterConsumer(consumerKey: string): void {
    if (this.consumers.has(consumerKey)) {
      this.consumers.delete(consumerKey);
      this.queueSaveConsumers();
    }
  }

  /**
   * Get all consumer cache keys affected by a package change.
   * Returns consumers that directly use the package or transitively depend on it.
   */
  getAffectedConsumers(pkgName: string): Set<string> {
    const affected = new Set<string>();

    // Get all packages that could be affected (the changed package + its dependents)
    const affectedPackages = new Set<string>([pkgName]);
    for (const dependent of this.getDependents(pkgName)) {
      affectedPackages.add(dependent);
    }

    // Find all consumers that use any of the affected packages
    for (const [consumerKey, consumerPackages] of this.consumers) {
      for (const pkg of affectedPackages) {
        if (consumerPackages.has(pkg)) {
          affected.add(consumerKey);
          break; // No need to check more packages for this consumer
        }
      }
    }

    return affected;
  }

  /**
   * Incrementally update when a package's dependencies change.
   */
  updatePackage(pkgName: string, newDeps: string[]): void {
    this.forward.set(pkgName, new Set(newDeps));
    this.computeTransitiveReverse();
    log.verbose(` Updated ${pkgName} with ${newDeps.length} dependencies`);
  }

  /**
   * Remove workspace packages when workspace closes.
   *
   * NOTE: We intentionally do NOT delete consumers here. Consumer keys use
   * canonical paths that remain valid across workspace switches. Deleting
   * consumers on workspace switch would break cache invalidation when the
   * user returns to the workspace.
   *
   * Instead, stale consumers are pruned on app startup via pruneStaleConsumers(),
   * which checks if the consumer paths still exist on disk.
   */
  removeWorkspace(workspacePath: string): void {
    const prefixes = [
      "@workspace/",
      "@workspace-panels/",
      "@workspace-workers/",
      "@workspace-agents/",
    ];

    let removedCount = 0;
    for (const [pkg] of this.forward) {
      if (prefixes.some((p) => pkg.startsWith(p))) {
        this.forward.delete(pkg);
        this.reverse.delete(pkg);
        removedCount++;
      }
    }

    // DO NOT delete consumers here - they use canonical paths that remain
    // valid across workspace switches. See pruneStaleConsumers() for cleanup.

    if (removedCount > 0) {
      this.computeTransitiveReverse();
      log.verbose(` Removed ${removedCount} workspace packages`);
    }
  }

  /**
   * Prune stale consumer registrations by checking if paths still exist.
   *
   * Called on app startup to clean up consumers for deleted panels/workers/agents.
   * This prevents unbounded growth of the consumers cache while preserving
   * valid registrations across workspace switches.
   */
  async pruneStaleConsumers(): Promise<void> {
    let pruned = 0;

    for (const [consumerKey] of this.consumers) {
      // Extract path from consumer key: "panel:/path/to/panel" → "/path/to/panel"
      const match = consumerKey.match(/^(panel|worker|agent):(.+)$/);
      if (match) {
        const canonicalPath = match[2];
        if (canonicalPath && !fs.existsSync(canonicalPath)) {
          this.consumers.delete(consumerKey);
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      log.verbose(` Pruned ${pruned} stale consumer registrations`);
      this.queueSaveConsumers();
    }
  }

  /**
   * Get the number of packages in the graph.
   */
  getPackageCount(): number {
    return this.forward.size;
  }

  /**
   * Get the number of registered consumers.
   */
  getConsumerCount(): number {
    return this.consumers.size;
  }

  private extractInternalDeps(packageJson: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }): string[] {
    // Include all dependency types that could affect builds
    const allDeps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.peerDependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
    };

    return Object.keys(allDeps).filter(
      (d) =>
        d.startsWith("@natstack/") ||
        d.startsWith("@workspace/") ||
        d.startsWith("@workspace-panels/") ||
        d.startsWith("@workspace-workers/") ||
        d.startsWith("@workspace-agents/")
    );
  }

  private computeTransitiveReverse(): void {
    this.reverse.clear();

    // Initialize reverse with direct dependents
    for (const [pkg, deps] of this.forward) {
      for (const dep of deps) {
        if (!this.reverse.has(dep)) {
          this.reverse.set(dep, new Set());
        }
        this.reverse.get(dep)!.add(pkg);
      }
    }

    // Compute transitive closure (fixed-point iteration)
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pkg, dependents] of this.reverse) {
        for (const dependent of [...dependents]) {
          const transitive = this.reverse.get(dependent);
          if (transitive) {
            for (const t of transitive) {
              if (!dependents.has(t)) {
                dependents.add(t);
                changed = true;
              }
            }
          }
        }
      }
    }
  }

  private async discoverPackages(
    dir: string
  ): Promise<Array<{ name: string; packageJson: Record<string, unknown> }>> {
    const results: Array<{ name: string; packageJson: Record<string, unknown> }> = [];

    if (!fs.existsSync(dir)) return results;

    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

      if (entry.name.startsWith("@")) {
        // Scoped package directory
        const scopePath = path.join(dir, entry.name);
        const scopedEntries = await fs.promises.readdir(scopePath, {
          withFileTypes: true,
        });
        for (const scoped of scopedEntries) {
          if (!scoped.isDirectory()) continue;
          const pkgJsonPath = path.join(scopePath, scoped.name, "package.json");
          if (fs.existsSync(pkgJsonPath)) {
            try {
              const content = JSON.parse(
                await fs.promises.readFile(pkgJsonPath, "utf-8")
              ) as { name?: string; private?: boolean };
              if (!content.private && content.name) {
                results.push({
                  name: content.name,
                  packageJson: content as Record<string, unknown>,
                });
              }
            } catch {
              // Skip malformed package.json
            }
          }
        }
      } else {
        const pkgJsonPath = path.join(dir, entry.name, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const content = JSON.parse(
              await fs.promises.readFile(pkgJsonPath, "utf-8")
            ) as { name?: string; private?: boolean };
            if (!content.private && content.name) {
              results.push({
                name: content.name,
                packageJson: content as Record<string, unknown>,
              });
            }
          } catch {
            // Skip malformed package.json
          }
        }
      }
    }

    return results;
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  /**
   * Load consumers from disk cache.
   * Called during initialization to restore consumer registrations after app restart.
   */
  async loadConsumersFromDisk(): Promise<void> {
    const cachePath = this.getConsumersCachePath();

    try {
      await fsPromises.access(cachePath);
    } catch {
      // No cache file exists, start fresh
      return;
    }

    try {
      const content = await fsPromises.readFile(cachePath, "utf-8");
      const data = JSON.parse(content) as ConsumersCacheData;

      if (data.version !== CONSUMERS_CACHE_VERSION) {
        log.verbose(` Consumers cache version mismatch, discarding`);
        return;
      }

      for (const [key, packages] of Object.entries(data.consumers)) {
        this.consumers.set(key, new Set(packages));
      }

      log.verbose(` Loaded ${this.consumers.size} consumers from disk`);
    } catch (error) {
      console.warn("[DependencyGraph] Failed to load consumers from disk:", error);
    }
  }

  /**
   * Queue a debounced save of consumers to disk.
   */
  private queueSaveConsumers(): void {
    this.isDirty = true;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.saveConsumersToDisk();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Save consumers to disk with atomic write.
   */
  private async saveConsumersToDisk(): Promise<void> {
    if (!this.isDirty) return;

    const cachePath = this.getConsumersCachePath();
    const tempPath = `${cachePath}.tmp`;

    try {
      // Convert Map<string, Set<string>> to Record<string, string[]>
      const consumersObj: Record<string, string[]> = {};
      for (const [key, packages] of this.consumers) {
        consumersObj[key] = Array.from(packages);
      }

      const data: ConsumersCacheData = {
        version: CONSUMERS_CACHE_VERSION,
        consumers: consumersObj,
      };

      const content = JSON.stringify(data);

      // Atomic write: write to temp file, then rename
      await fsPromises.writeFile(tempPath, content, "utf-8");
      await fsPromises.rename(tempPath, cachePath);

      this.isDirty = false;
      log.verbose(` Saved ${this.consumers.size} consumers to disk`);
    } catch (error) {
      console.warn("[DependencyGraph] Failed to save consumers to disk:", error);

      // Clean up temp file if it exists
      try {
        await fsPromises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Flush pending saves to disk immediately.
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.isDirty) {
      await this.saveConsumersToDisk();
    }
  }

  private getConsumersCachePath(): string {
    const userDataPath = app.getPath("userData");
    return path.join(userDataPath, CONSUMERS_CACHE_FILENAME);
  }
}

// Singleton instance
let dependencyGraph: DependencyGraph | null = null;

/**
 * Get the dependency graph singleton.
 * Lazily initializes on first call.
 */
export async function getDependencyGraph(): Promise<DependencyGraph> {
  if (!dependencyGraph) {
    dependencyGraph = new DependencyGraph();
    const packagesDir = getPackagesDir();
    if (packagesDir) {
      await dependencyGraph.initialize(packagesDir);
    }
    // Load persisted consumer registrations
    await dependencyGraph.loadConsumersFromDisk();
    // Prune stale consumers (deleted panels/workers/agents)
    await dependencyGraph.pruneStaleConsumers();
  }
  return dependencyGraph;
}

/**
 * Clear the dependency graph singleton (for testing).
 * Flushes pending saves before clearing.
 */
export async function clearDependencyGraph(): Promise<void> {
  if (dependencyGraph) {
    await dependencyGraph.flush();
  }
  dependencyGraph = null;
}
