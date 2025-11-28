/**
 * Git repo cache manifest tracker
 *
 * Tracks which cache entries each git repo URL actually uses during runtime.
 * When a new panel loads from a repo, we can warm its cache with the
 * most recently used entries for that repo.
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getCacheConfig } from "./cacheConfig.js";

interface RepoManifest {
  /** Git repo source URL */
  repoUrl: string;
  /** LRU-ordered list of cache keys (most recent last) */
  cacheKeys: string[];
  /** Maximum number of keys to track per repo */
  maxKeys: number;
  /** Last updated timestamp */
  lastUpdated: number;
}

interface ManifestData {
  version: string;
  manifests: Record<string, RepoManifest>;
  accessOrder: string[];
}

const MANIFEST_VERSION = "1";
const MANIFEST_FILENAME = "repo-cache-manifest.json";

class RepoCacheManifestManager {
  private manifests = new Map<string, RepoManifest>();
  private readonly config = getCacheConfig();
  private readonly MAX_KEYS_PER_REPO = this.config.maxKeysPerRepo;
  private readonly MAX_REPOS = this.config.maxRepos;
  private repoAccessOrder: string[] = []; // For LRU eviction of repos
  private saveTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private initialized = false;
  private readonly SAVE_DEBOUNCE_MS = 5000; // Save to disk every 5 seconds

  /**
   * Get the file path for the manifest
   */
  private getManifestFilePath(): string {
    const userDataPath = app.getPath("userData");
    return path.join(userDataPath, MANIFEST_FILENAME);
  }

  /**
   * Initialize the manifest manager by loading from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const manifestPath = this.getManifestFilePath();
    try {
      if (fs.existsSync(manifestPath)) {
        const content = fs.readFileSync(manifestPath, "utf-8");
        const data = JSON.parse(content) as ManifestData;

        if (data.version === MANIFEST_VERSION) {
          // Load manifests
          for (const [repoUrl, manifest] of Object.entries(data.manifests)) {
            this.manifests.set(repoUrl, manifest);
          }
          this.repoAccessOrder = data.accessOrder;
          console.log(`[RepoManifest] Loaded ${this.manifests.size} repo manifests from disk`);
        } else {
          console.log("[RepoManifest] Version mismatch, starting fresh");
        }
      } else {
        console.log("[RepoManifest] No manifest file found, starting fresh");
      }
    } catch (error) {
      console.error("[RepoManifest] Failed to load manifest from disk:", error);
    }

    this.initialized = true;
  }

  /**
   * Queue a debounced save to disk
   */
  private queueSave(): void {
    this.isDirty = true;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveToDisk();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Save the manifest to disk
   */
  private saveToDisk(): void {
    if (!this.isDirty) return;

    const manifestPath = this.getManifestFilePath();
    try {
      const data: ManifestData = {
        version: MANIFEST_VERSION,
        manifests: Object.fromEntries(this.manifests.entries()),
        accessOrder: this.repoAccessOrder,
      };

      const content = JSON.stringify(data, null, 2);
      fs.writeFileSync(manifestPath, content, "utf-8");
      this.isDirty = false;
      console.log(`[RepoManifest] Saved ${this.manifests.size} repo manifests to disk`);
    } catch (error) {
      console.error("[RepoManifest] Failed to save manifest to disk:", error);
    }
  }

  /**
   * Flush pending saves to disk
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.isDirty) {
      this.saveToDisk();
    }
  }

  /**
   * Record that a cache key was accessed by a panel from a given repo
   */
  recordCacheHit(repoUrl: string, cacheKey: string): void {
    // Get or create manifest for this repo
    let manifest = this.manifests.get(repoUrl);
    if (!manifest) {
      manifest = {
        repoUrl,
        cacheKeys: [],
        maxKeys: this.MAX_KEYS_PER_REPO,
        lastUpdated: Date.now(),
      };
      this.manifests.set(repoUrl, manifest);

      // Evict old repos if we have too many
      if (this.manifests.size > this.MAX_REPOS) {
        this.evictOldestRepo();
      }
    }

    // Update repo access order (LRU) - remove if exists, then add to end
    const existingRepoIndex = this.repoAccessOrder.indexOf(repoUrl);
    if (existingRepoIndex !== -1) {
      this.repoAccessOrder.splice(existingRepoIndex, 1);
    }
    this.repoAccessOrder.push(repoUrl);

    // Add cache key to manifest (if not already present)
    const existingIndex = manifest.cacheKeys.indexOf(cacheKey);
    if (existingIndex !== -1) {
      // Move to end (most recent)
      manifest.cacheKeys.splice(existingIndex, 1);
    }
    manifest.cacheKeys.push(cacheKey);

    // Evict old keys if we have too many
    if (manifest.cacheKeys.length > manifest.maxKeys) {
      const toRemove = manifest.cacheKeys.length - manifest.maxKeys;
      manifest.cacheKeys.splice(0, toRemove);
      console.log(`[RepoManifest] Evicted ${toRemove} old keys from ${repoUrl}`);
    }

    manifest.lastUpdated = Date.now();

    // Queue save to disk
    this.queueSave();
  }

  /**
   * Record multiple cache hits at once (batch operation)
   * Deduplicates keys before processing to avoid redundant work
   */
  recordCacheHits(repoUrl: string, cacheKeys: string[]): void {
    // Deduplicate keys to avoid O(n²) performance with duplicate keys
    const uniqueKeys = [...new Set(cacheKeys)];

    if (uniqueKeys.length < cacheKeys.length) {
      console.log(
        `[RepoManifest] Deduplicated ${cacheKeys.length - uniqueKeys.length} duplicate cache keys for ${repoUrl}`
      );
    }

    for (const key of uniqueKeys) {
      this.recordCacheHit(repoUrl, key);
    }
    // Single save for batch operation (already happens once)
  }

  /**
   * Get the list of cache keys to pre-populate for a repo
   * Returns keys in LRU order (most recently used last)
   */
  getCacheKeysForRepo(repoUrl: string): string[] {
    const manifest = this.manifests.get(repoUrl);
    if (!manifest) {
      console.log(`[RepoManifest] No manifest found for ${repoUrl}`);
      return [];
    }

    // Update access order
    this.repoAccessOrder = this.repoAccessOrder.filter((url) => url !== repoUrl);
    this.repoAccessOrder.push(repoUrl);

    console.log(`[RepoManifest] Found ${manifest.cacheKeys.length} cached keys for ${repoUrl}`);
    return [...manifest.cacheKeys]; // Return copy
  }

  /**
   * Get statistics about repo manifests
   */
  getStats(): {
    totalRepos: number;
    totalKeys: number;
    repoStats: Array<{
      repoUrl: string;
      keyCount: number;
      lastUpdated: number;
    }>;
  } {
    const repoStats = Array.from(this.manifests.values()).map((manifest) => ({
      repoUrl: manifest.repoUrl,
      keyCount: manifest.cacheKeys.length,
      lastUpdated: manifest.lastUpdated,
    }));

    const totalKeys = repoStats.reduce((sum, stat) => sum + stat.keyCount, 0);

    return {
      totalRepos: this.manifests.size,
      totalKeys,
      repoStats,
    };
  }

  /**
   * Clear all manifests
   */
  clear(): void {
    const size = this.manifests.size;
    this.manifests.clear();
    this.repoAccessOrder = [];
    this.queueSave();
    console.log(`[RepoManifest] Cleared ${size} repo manifests`);
  }

  /**
   * Evict the least recently used repo
   */
  private evictOldestRepo(): void {
    if (this.repoAccessOrder.length === 0) return;

    const oldestRepo = this.repoAccessOrder.shift()!;
    const manifest = this.manifests.get(oldestRepo);
    if (manifest) {
      console.log(`[RepoManifest] Evicting repo ${oldestRepo} (${manifest.cacheKeys.length} keys)`);
      this.manifests.delete(oldestRepo);
      this.queueSave();
    }
  }
}

// Global singleton instance
let manifestManager: RepoCacheManifestManager | null = null;

export function getRepoCacheManifestManager(): RepoCacheManifestManager {
  if (!manifestManager) {
    manifestManager = new RepoCacheManifestManager();
  }
  return manifestManager;
}
