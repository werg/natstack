/**
 * Global type declarations for @natstack/build
 *
 * Note: These types duplicate some from @natstack/core because @natstack/build
 * is compiled independently and doesn't have @natstack/core as a build dependency.
 * The types must match those in @natstack/core/src/panelApi.ts.
 */

interface CacheEntry {
  key: string;
  value: string;
  timestamp: number;
  size: number;
}

interface PanelBridge {
  getCacheConfig(): Promise<{
    maxEntriesPerPanel: number;
    maxSizePerPanel: number;
    expirationMs: number;
  }>;
  loadDiskCache(): Promise<Record<string, CacheEntry>>;
  saveDiskCache(entries: Record<string, CacheEntry>): Promise<void>;
  recordCacheHits(cacheKeys: string[]): Promise<void>;
  getRepoCacheKeys(): Promise<string[]>;
  loadCacheEntries(keys: string[]): Promise<Record<string, CacheEntry>>;
  getDevMode(): Promise<boolean>;
}

declare global {
  interface Window {
    __natstackPanelBridge?: PanelBridge;
  }

  interface GlobalThis {
    __natstackDevMode?: boolean;
    __natstackUnifiedCache?: import('./cache-manager.js').UnifiedCache;
    __natstackRepoUrl?: string;
    __natstackSourceCommit?: string; // Git commit SHA for cache key optimization
    __natstackDepCommits?: Record<string, string>; // Dependency name -> commit SHA
  }
}

export {};
