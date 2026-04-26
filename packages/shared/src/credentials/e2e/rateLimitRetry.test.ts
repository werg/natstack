import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter } from '../rateLimit.js';
import { CircuitBreaker, calculateBackoff } from '../retry.js';
import { MockProvider } from '../test-utils/mockProvider.js';

describe('credentials e2e: rate limiting and retries', () => {
  describe('RateLimiter', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('consumes tokens until exhausted and reports retryAfterMs', () => {
      const limiter = new RateLimiter({ requestsPerSecond: 2, burstSize: 2 });

      expect(limiter.tryConsume()).toEqual({ allowed: true });
      expect(limiter.tryConsume()).toEqual({ allowed: true });
      expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 500 });

      vi.advanceTimersByTime(500);

      expect(limiter.tryConsume()).toEqual({ allowed: true });
    });
  });

  describe('CircuitBreaker', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('transitions from closed to open, then half-open, then closed on success', () => {
      const breaker = new CircuitBreaker({
        tripThreshold: 2,
        tripWindowMs: 1000,
        cooldownMs: 250,
      });
      const states: string[] = [];

      breaker.onStateChange((state) => states.push(state));

      breaker.recordFailure();
      expect(breaker.state).toBe('closed');
      expect(breaker.isAllowed()).toBe(true);

      breaker.recordFailure();
      expect(breaker.state).toBe('open');
      expect(breaker.isAllowed()).toBe(false);

      vi.advanceTimersByTime(249);
      expect(breaker.state).toBe('open');
      expect(breaker.isAllowed()).toBe(false);

      vi.advanceTimersByTime(1);
      expect(breaker.state).toBe('half-open');
      expect(breaker.isAllowed()).toBe(true);

      breaker.recordSuccess();
      expect(breaker.state).toBe('closed');
      expect(breaker.isAllowed()).toBe(true);
      expect(states).toEqual(['open', 'half-open', 'closed']);
    });
  });

  describe('calculateBackoff', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns deterministic exponential backoff values and respects the max delay cap', () => {
      // Current implementation is deterministic exponential backoff with no jitter.
      expect(calculateBackoff(1, { initialDelayMs: 100, maxDelayMs: 1_000 })).toBe(100);
      expect(calculateBackoff(2, { initialDelayMs: 100, maxDelayMs: 1_000 })).toBe(200);
      expect(calculateBackoff(3, { initialDelayMs: 100, maxDelayMs: 1_000 })).toBe(400);
      expect(calculateBackoff(4, { initialDelayMs: 100, maxDelayMs: 1_000 })).toBe(800);
      expect(calculateBackoff(5, { initialDelayMs: 100, maxDelayMs: 1_000 })).toBe(1_000);
    });
  });

  describe('MockProvider integration', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('applies Retry-After from a 429 response to the rate limiter without waiting in real time', async () => {
      const provider = await MockProvider.start({
        fixtures: {
          '/throttled': {
            status: 429,
            headers: { 'Retry-After': '3' },
            body: { error: 'rate_limited' },
          },
        },
      });

      try {
        const response = await fetch(`${provider.baseUrl}/throttled`);
        const retryAfterHeader = response.headers.get('Retry-After');

        expect(response.status).toBe(429);
        expect(retryAfterHeader).toBe('3');
        expect(provider.requests).toHaveLength(1);
        expect(provider.requests[0]?.path).toBe('/throttled');

        const now = Date.parse('2026-01-01T00:00:00.000Z');
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
        const limiter = new RateLimiter({ requestsPerSecond: 1, burstSize: 1 });

        limiter.recordRetryAfter(Number(retryAfterHeader));
        expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 3000 });

        nowSpy.mockReturnValue(now + 2500);
        expect(limiter.tryConsume()).toEqual({ allowed: false, retryAfterMs: 500 });

        nowSpy.mockReturnValue(now + 3000);
        expect(limiter.tryConsume()).toEqual({ allowed: true });
      } finally {
        await provider.stop();
      }
    });
  });
});
