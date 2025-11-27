/**
 * Unit tests for hash computation (computeHash function)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeHash } from './cache-manager.js';

describe('computeHash', () => {
  it('should generate consistent hashes for same input', async () => {
    const input = 'test string';

    const hash1 = await computeHash(input);
    const hash2 = await computeHash(input);

    assert.strictEqual(hash1, hash2);
  });

  it('should generate different hashes for different inputs', async () => {
    const hash1 = await computeHash('input1');
    const hash2 = await computeHash('input2');

    assert.notStrictEqual(hash1, hash2);
  });

  it('should handle empty strings', async () => {
    const hash = await computeHash('');

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length > 0);
  });

  it('should handle very long strings', async () => {
    const longString = 'a'.repeat(100000);

    const hash = await computeHash(longString);

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length > 0);
  });

  it('should handle special characters', async () => {
    const specialChars = '!@#$%^&*()_+-={}[]|\\:";\'<>?,./\n\r\t';

    const hash = await computeHash(specialChars);

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length > 0);
  });

  it('should handle unicode characters', async () => {
    const unicode = '你好世界 🚀 مرحبا العالم';

    const hash = await computeHash(unicode);

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length > 0);
  });

  it('should be deterministic across multiple calls', async () => {
    const input = 'deterministic test';
    const hashes: string[] = [];

    // Generate hash 10 times
    for (let i = 0; i < 10; i++) {
      hashes.push(await computeHash(input));
    }

    // All hashes should be identical
    const firstHash = hashes[0];
    for (const hash of hashes) {
      assert.strictEqual(hash, firstHash);
    }
  });

  it('should produce different hashes for similar inputs', async () => {
    const hash1 = await computeHash('test');
    const hash2 = await computeHash('Test');
    const hash3 = await computeHash('test ');
    const hash4 = await computeHash(' test');

    // All should be different
    assert.notStrictEqual(hash1, hash2);
    assert.notStrictEqual(hash1, hash3);
    assert.notStrictEqual(hash1, hash4);
    assert.notStrictEqual(hash2, hash3);
    assert.notStrictEqual(hash2, hash4);
    assert.notStrictEqual(hash3, hash4);
  });

  it('should handle newlines and whitespace', async () => {
    const hash1 = await computeHash('line1\nline2\nline3');
    const hash2 = await computeHash('line1 line2 line3');

    assert.notStrictEqual(hash1, hash2);
  });

  it('should handle JSON strings', async () => {
    const json = JSON.stringify({
      key1: 'value1',
      key2: 'value2',
      nested: { key3: 'value3' },
    });

    const hash = await computeHash(json);

    assert.ok(typeof hash === 'string');
    assert.ok(hash.length > 0);
  });

  it('should be sensitive to order in JSON-like strings', async () => {
    const json1 = JSON.stringify({ a: 1, b: 2 });
    const json2 = JSON.stringify({ b: 2, a: 1 });

    const hash1 = await computeHash(json1);
    const hash2 = await computeHash(json2);

    // Hashes should be different because JSON.stringify order differs
    assert.notStrictEqual(hash1, hash2);
  });

  it('should produce hex string output', async () => {
    const hash = await computeHash('test');

    // Check if hash is a valid hex string
    assert.ok(/^[0-9a-f]+$/i.test(hash));
  });

  it('should have consistent length for different inputs', async () => {
    const hash1 = await computeHash('short');
    const hash2 = await computeHash('a'.repeat(10000));

    // Hash implementation uses full SHA-256 (64 hex characters = 256 bits)
    assert.strictEqual(hash1.length, hash2.length);
    assert.strictEqual(hash1.length, 64); // Full SHA-256 hash length
  });
});
