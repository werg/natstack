import type { RateLimitConfig } from './types.js';

const DEFAULT_REQUESTS_PER_SECOND = 10;
const DEFAULT_BURST_SIZE = 20;
const DEFAULT_STRATEGY = 'delay' as const;

export class RateLimiter {
  private readonly requestsPerSecond: number;
  private readonly burstSize: number;
  private readonly strategy: NonNullable<RateLimitConfig['strategy']>;

  private tokens: number;
  private lastRefillMs: number;
  private blockedUntilMs = 0;

  constructor(config: RateLimitConfig = {}) {
    this.requestsPerSecond = normalizePositiveNumber(
      config.requestsPerSecond,
      DEFAULT_REQUESTS_PER_SECOND,
    );
    this.burstSize = normalizePositiveNumber(config.burstSize, DEFAULT_BURST_SIZE);
    this.strategy = config.strategy ?? DEFAULT_STRATEGY;
    this.tokens = this.burstSize;
    this.lastRefillMs = Date.now();
  }

  tryConsume(): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();

    if (now < this.blockedUntilMs) {
      return {
        allowed: false,
        retryAfterMs: this.blockedUntilMs - now,
      };
    }

    this.refill(now);

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }

    const retryAfterMs = Math.ceil(((1 - this.tokens) / this.requestsPerSecond) * 1000);

    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1),
    };
  }

  recordRetryAfter(seconds: number): void {
    const retryAfterMs = Math.max(0, seconds) * 1000;
    this.blockedUntilMs = Math.max(this.blockedUntilMs, Date.now() + retryAfterMs);
  }

  reset(): void {
    this.tokens = this.burstSize;
    this.lastRefillMs = Date.now();
    this.blockedUntilMs = 0;
  }

  private refill(now: number): void {
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }

    const replenishedTokens = (elapsedMs / 1000) * this.requestsPerSecond;
    this.tokens = Math.min(this.burstSize, this.tokens + replenishedTokens);
    this.lastRefillMs = now;

    if (this.strategy === 'fail-fast' && this.tokens > this.burstSize) {
      this.tokens = this.burstSize;
    }
  }
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
}
