import type { RetryConfig } from './types.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_IDEMPOTENT_ONLY = true;
const DEFAULT_TRIP_THRESHOLD = 20;
const DEFAULT_TRIP_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 30_000;

type CircuitBreakerConfig = RetryConfig & {
  tripThreshold?: number;
  tripWindowMs?: number;
  cooldownMs?: number;
};

export class CircuitBreaker {
  private readonly tripThreshold: number;
  private readonly tripWindowMs: number;
  private readonly cooldownMs: number;

  private currentState: BreakerState = 'closed';
  private failureTimestamps: number[] = [];
  private openedAtMs = 0;
  private readonly listeners = new Set<(state: BreakerState) => void>();

  constructor(config: CircuitBreakerConfig = {}) {
    this.tripThreshold = normalizePositiveInteger(config.tripThreshold, DEFAULT_TRIP_THRESHOLD);
    this.tripWindowMs = normalizePositiveInteger(config.tripWindowMs, DEFAULT_TRIP_WINDOW_MS);
    this.cooldownMs = normalizePositiveInteger(config.cooldownMs, DEFAULT_COOLDOWN_MS);
  }

  get state(): BreakerState {
    if (
      this.currentState === 'open' &&
      Date.now() >= this.openedAtMs + this.cooldownMs
    ) {
      this.transitionTo('half-open');
    }

    return this.currentState;
  }

  recordSuccess(): void {
    if (this.currentState === 'half-open') {
      this.reset();
      return;
    }

    if (this.currentState === 'closed') {
      this.pruneFailures(Date.now());
    }
  }

  recordFailure(): void {
    const now = Date.now();

    if (this.state === 'half-open') {
      this.open(now);
      return;
    }

    if (this.currentState === 'open') {
      this.open(now);
      return;
    }

    this.pruneFailures(now);
    this.failureTimestamps.push(now);

    if (this.failureTimestamps.length >= this.tripThreshold) {
      this.open(now);
    }
  }

  isAllowed(): boolean {
    return this.state !== 'open';
  }

  reset(): void {
    this.failureTimestamps = [];
    this.openedAtMs = 0;
    this.transitionTo('closed');
  }

  onStateChange(cb: (state: BreakerState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private open(now: number): void {
    this.failureTimestamps = [];
    this.openedAtMs = now;
    this.transitionTo('open');
  }

  private pruneFailures(now: number): void {
    const cutoff = now - this.tripWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => timestamp >= cutoff);
  }

  private transitionTo(nextState: BreakerState): void {
    if (this.currentState === nextState) {
      return;
    }

    this.currentState = nextState;
    for (const listener of this.listeners) {
      listener(nextState);
    }
  }
}

export function calculateBackoff(attempt: number, config: RetryConfig = {}): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const initialDelayMs = normalizePositiveInteger(
    config.initialDelayMs,
    DEFAULT_INITIAL_DELAY_MS,
  );
  const maxDelayMs = normalizePositiveInteger(config.maxDelayMs, DEFAULT_MAX_DELAY_MS);

  const delay = initialDelayMs * 2 ** (normalizedAttempt - 1);
  return Math.min(delay, maxDelayMs);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS,
  idempotentOnly: DEFAULT_IDEMPOTENT_ONLY,
};
