/**
 * Global type declarations for @natstack/build
 */

interface PanelBridge {
  getCacheConfig(): Promise<{
    maxEntriesPerPanel: number;
    maxSizePerPanel: number;
    expirationMs: number;
  }>;
  loadDiskCache(): Promise<Record<string, {
    key: string;
    value: string;
    timestamp: number;
    size: number;
  }>>;
  saveDiskCache(entries: Record<string, {
    key: string;
    value: string;
    timestamp: number;
    size: number;
  }>): Promise<void>;
  recordCacheHits(cacheKeys: string[]): Promise<void>;
  getRepoCacheKeys(): Promise<string[]>;
  loadCacheEntries(keys: string[]): Promise<Record<string, {
    key: string;
    value: string;
    timestamp: number;
    size: number;
  }>>;
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
