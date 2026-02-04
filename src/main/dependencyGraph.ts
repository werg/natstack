/**
 * Consumer Registry for Build System Cache Invalidation
 *
 * Tracks which panels/workers/agents use which packages for targeted cache
 * invalidation. When a package is published, we invalidate caches for all
 * consumers that depend on it.
 *
 * Note: We don't need to track transitive dependencies because consumers
 * register with ALL their resolved packages from Arborist (which already
 * includes transitives). When an intermediate package changes, the consumer
 * is invalidated directly, rebuilds, and re-registers with updated deps.
 *
 * Benefits:
 * - O(1) cache lookups
 * - O(consumers) invalidation checks (no graph traversal)
 * - Simple, predictable behavior
 */

import * as fs from "fs";
import { promises as fsPromises } from "fs";
import * as path from "path";
import { app } from "electron";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("DependencyGraph");

const CONSUMERS_CACHE_VERSION = "2"; // Bumped: removed transitive tracking
const CONSUMERS_CACHE_FILENAME = "dependency-consumers.json";

interface ConsumersCacheData {
  version: string;
  consumers: Record<string, string[]>;
}

export class DependencyGraph {
  // Track which panels/workers use which packages (consumer key → packages)
  private consumers = new Map<string, Set<string>>();

  // Persistence state
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private readonly SAVE_DEBOUNCE_MS = 2000; // 2 seconds

  /**
   * Initialize the graph. No package discovery needed since consumers
   * register their resolved packages directly from Arborist.
   */
  async initialize(_natstackPackagesDir: string): Promise<void> {
    // No-op: consumers are loaded from disk separately
    log.verbose(` Initialized (consumer-only mode)`);
  }

  /**
   * Add workspace packages to the graph.
   * No-op since we only track consumers, not package relationships.
   */
  async addWorkspace(_workspacePath: string): Promise<void> {
    // No-op: consumers register their own packages via registerConsumer
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
   * Returns consumers that directly use the package.
   *
   * Note: We don't need transitive lookup because consumers register with
   * ALL their resolved packages from Arborist (including transitives).
   */
  getAffectedConsumers(pkgName: string): Set<string> {
    const affected = new Set<string>();

    for (const [consumerKey, consumerPackages] of this.consumers) {
      if (consumerPackages.has(pkgName)) {
        affected.add(consumerKey);
      }
    }

    return affected;
  }

  /**
   * Update when a package's dependencies change.
   * No-op since we don't track package relationships anymore.
   * Consumers will re-register with updated deps when they rebuild.
   */
  updatePackage(pkgName: string, _newDeps: string[]): void {
    log.verbose(` Package ${pkgName} updated (consumers will re-register on rebuild)`);
  }

  /**
   * Remove workspace packages when workspace closes.
   * No-op for package tracking, but consumers are preserved.
   */
  removeWorkspace(_workspacePath: string): void {
    // No-op: we don't track package relationships
    // Consumers are preserved (they use canonical paths)
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
   * Get the number of registered consumers.
   */
  getConsumerCount(): number {
    return this.consumers.size;
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

      // Ensure directory exists
      await fsPromises.mkdir(path.dirname(cachePath), { recursive: true });

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
