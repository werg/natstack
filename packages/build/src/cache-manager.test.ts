/**
 * Unit tests for UnifiedCache
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { UnifiedCache, type CacheMetrics } from './cache-manager.js';

describe('UnifiedCache', () => {
  describe('Basic Operations', () => {
    it('should create a cache with default options', () => {
      const cache = new UnifiedCache();
      const metrics = cache.getMetrics();

      assert.strictEqual(metrics.currentEntries, 0);
      assert.strictEqual(metrics.hits, 0);
      assert.strictEqual(metrics.misses, 0);
    });

    it('should set and get values', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      const value = cache.get('key1');

      assert.strictEqual(value, 'value1');

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 1);
      assert.strictEqual(metrics.hits, 1);
      assert.strictEqual(metrics.misses, 0);
    });

    it('should return null for missing keys', () => {
      const cache = new UnifiedCache();

      const value = cache.get('nonexistent');

      assert.strictEqual(value, null);

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.misses, 1);
    });

    it('should update existing values', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      await cache.set('key1', 'value2');
      const value = cache.get('key1');

      assert.strictEqual(value, 'value2');

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 1);
    });

    it('should handle multiple keys', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      assert.strictEqual(cache.get('key1'), 'value1');
      assert.strictEqual(cache.get('key2'), 'value2');
      assert.strictEqual(cache.get('key3'), 'value3');

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 3);
      assert.strictEqual(metrics.hits, 3);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used entry when max entries reached', async () => {
      const cache = new UnifiedCache({ maxEntries: 3, maxSize: 10000, expirationMs: 0 });

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      // This should evict key1
      await cache.set('key4', 'value4');

      assert.strictEqual(cache.get('key1'), null);
      assert.strictEqual(cache.get('key2'), 'value2');
      assert.strictEqual(cache.get('key3'), 'value3');
      assert.strictEqual(cache.get('key4'), 'value4');

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 3);
      assert.strictEqual(metrics.evictions, 1);
    });

    it('should update LRU on get', async () => {
      const cache = new UnifiedCache({ maxEntries: 3, maxSize: 10000, expirationMs: 0 });

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      // Access key1 to make it most recently used
      cache.get('key1');

      // This should evict key2 (least recently used)
      await cache.set('key4', 'value4');

      assert.strictEqual(cache.get('key1'), 'value1');
      assert.strictEqual(cache.get('key2'), null);
      assert.strictEqual(cache.get('key3'), 'value3');
      assert.strictEqual(cache.get('key4'), 'value4');
    });

    it('should evict based on size limit', async () => {
      const cache = new UnifiedCache({ maxEntries: 100, maxSize: 20, expirationMs: 0 });

      await cache.set('key1', 'val1'); // 4 bytes
      await cache.set('key2', 'val2'); // 4 bytes
      await cache.set('key3', 'val3'); // 4 bytes
      await cache.set('key4', 'val4'); // 4 bytes

      // Total is 16 bytes, adding 10 more should trigger eviction
      await cache.set('key5', 'verylong12'); // 10 bytes

      const metrics = cache.getMetrics();
      assert.ok(metrics.currentSize <= 20);
      assert.ok(metrics.evictions > 0);
    });
  });

  describe('Metrics', () => {
    it('should track hit rate correctly', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');

      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('key2'); // miss
      cache.get('key3'); // miss

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.hits, 2);
      assert.strictEqual(metrics.misses, 2);
      assert.strictEqual(metrics.hitRate, 0.5);
    });

    it('should track operation timings', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key2');

      const metrics = cache.getMetrics();
      assert.ok(metrics.averageGetTimeMs >= 0);
      assert.ok(metrics.averageSetTimeMs >= 0);
    });

    it('should track evictions and expirations separately', async () => {
      const cache = new UnifiedCache({ maxEntries: 2, maxSize: 10000, expirationMs: 0 });

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3'); // Should evict key1

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.evictions, 1);
      assert.strictEqual(metrics.expirations, 0);
    });

    it('should calculate uptime', async () => {
      const cache = new UnifiedCache();
      // Fake initialization
      (cache as any).metrics.initTimestamp = Date.now() - 5000;

      const metrics = cache.getMetrics();
      assert.ok(metrics.uptimeMs >= 4900); // Allow some variance
    });

    it('should reset metrics', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key2');

      cache.resetMetrics();

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.hits, 0);
      assert.strictEqual(metrics.misses, 0);
      assert.strictEqual(metrics.evictions, 0);
    });
  });

  describe('Clear and Stats', () => {
    it('should clear all entries', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      await cache.clear();

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 0);
      assert.strictEqual(cache.get('key1'), null);
      assert.strictEqual(cache.get('key2'), null);
      assert.strictEqual(cache.get('key3'), null);
    });

    it('should provide accurate stats', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      const stats = cache.getStats();
      assert.strictEqual(stats.entries, 2);
      assert.ok(stats.totalSize > 0);
      assert.ok(stats.oldestEntry !== null);
      assert.ok(stats.newestEntry !== null);
      assert.ok(stats.newestEntry! >= stats.oldestEntry!);
    });
  });

  describe('Size Tracking', () => {
    it('should track total size correctly', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', '12345'); // 5 bytes
      await cache.set('key2', '123456789'); // 9 bytes

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentSize, 14);
    });

    it('should update size when entry is updated', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', '12345'); // 5 bytes
      const metrics1 = cache.getMetrics();
      assert.strictEqual(metrics1.currentSize, 5);

      await cache.set('key1', '123456789'); // 9 bytes
      const metrics2 = cache.getMetrics();
      assert.strictEqual(metrics2.currentSize, 9);
    });

    it('should reject entries exceeding max size', async () => {
      const cache = new UnifiedCache({ maxEntries: 100, maxSize: 10, expirationMs: 0 });

      await cache.set('key1', '12345678901'); // 11 bytes, exceeds max

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 0);
      assert.strictEqual(cache.get('key1'), null);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string values', async () => {
      const cache = new UnifiedCache();

      await cache.set('key1', '');
      const value = cache.get('key1');

      assert.strictEqual(value, '');
    });

    it('should handle very long keys', async () => {
      const cache = new UnifiedCache();
      const longKey = 'a'.repeat(1000);

      await cache.set(longKey, 'value');
      const value = cache.get(longKey);

      assert.strictEqual(value, 'value');
    });

    it('should handle many small entries', async () => {
      const cache = new UnifiedCache({ maxEntries: 1000, maxSize: 100000, expirationMs: 0 });

      // Add 500 entries
      for (let i = 0; i < 500; i++) {
        await cache.set(`key${i}`, `value${i}`);
      }

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 500);

      // Verify first and last entries
      assert.strictEqual(cache.get('key0'), 'value0');
      assert.strictEqual(cache.get('key499'), 'value499');
    });

    it('should handle rapid get/set cycles', async () => {
      const cache = new UnifiedCache();

      for (let i = 0; i < 100; i++) {
        await cache.set('key', `value${i}`);
        const value = cache.get('key');
        assert.strictEqual(value, `value${i}`);
      }

      const metrics = cache.getMetrics();
      assert.strictEqual(metrics.currentEntries, 1);
      assert.strictEqual(metrics.hits, 100);
    });
  });
});
