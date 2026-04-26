import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from './rateLimit.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumes available tokens until the bucket is exhausted', () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1, burstSize: 2 });

    expect(limiter.tryConsume()).toEqual({ allowed: true });
    expect(limiter.tryConsume()).toEqual({ allowed: true });
  });

  it('returns retry information when the bucket is exhausted', () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1, burstSize: 1 });

    expect(limiter.tryConsume()).toEqual({ allowed: true });
    expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  it('refills tokens over time', () => {
    const limiter = new RateLimiter({ requestsPerSecond: 2, burstSize: 2 });

    expect(limiter.tryConsume()).toEqual({ allowed: true });
    expect(limiter.tryConsume()).toEqual({ allowed: true });
    expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 500 });

    vi.advanceTimersByTime(500);

    expect(limiter.tryConsume()).toEqual({ allowed: true });
  });

  it('honors Retry-After delays', () => {
    const limiter = new RateLimiter({ requestsPerSecond: 10, burstSize: 20 });

    limiter.recordRetryAfter(2);

    expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 2000 });

    vi.advanceTimersByTime(1500);
    expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 500 });

    vi.advanceTimersByTime(500);
    expect(limiter.tryConsume()).toEqual({ allowed: true });
  });
});
