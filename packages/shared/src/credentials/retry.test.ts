import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, calculateBackoff } from './retry.js';

describe('calculateBackoff', () => {
  it('calculates exponential backoff from the initial delay', () => {
    expect(calculateBackoff(1, { initialDelayMs: 100 })).toBe(100);
    expect(calculateBackoff(2, { initialDelayMs: 100 })).toBe(200);
    expect(calculateBackoff(3, { initialDelayMs: 100 })).toBe(400);
  });

  it('caps backoff at the configured maximum delay', () => {
    expect(calculateBackoff(5, { initialDelayMs: 1000, maxDelayMs: 5000 })).toBe(5000);
  });
});

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trips open after the configured number of failures', () => {
    const breaker = new CircuitBreaker({ tripThreshold: 2, tripWindowMs: 1000, cooldownMs: 5000 });

    breaker.recordFailure();
    expect(breaker.state).toBe('closed');

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.isAllowed()).toBe(false);
  });

  it('moves to half-open after cooldown and closes on success', () => {
    const breaker = new CircuitBreaker({ tripThreshold: 1, cooldownMs: 2000 });

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.isAllowed()).toBe(false);

    vi.advanceTimersByTime(2000);

    expect(breaker.state).toBe('half-open');
    expect(breaker.isAllowed()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('reopens from half-open on failure', () => {
    const breaker = new CircuitBreaker({ tripThreshold: 1, cooldownMs: 1000 });

    breaker.recordFailure();
    vi.advanceTimersByTime(1000);

    expect(breaker.state).toBe('half-open');

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });

  it('resets to the closed state', () => {
    const breaker = new CircuitBreaker({ tripThreshold: 1 });

    breaker.recordFailure();
    expect(breaker.state).toBe('open');

    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.isAllowed()).toBe(true);
  });

  it('emits state change events and supports unsubscribe', () => {
    const breaker = new CircuitBreaker({ tripThreshold: 1, cooldownMs: 1000 });
    const listener = vi.fn();
    const unsubscribe = breaker.onStateChange(listener);

    breaker.recordFailure();
    vi.advanceTimersByTime(1000);
    expect(breaker.state).toBe('half-open');

    unsubscribe();
    breaker.recordSuccess();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, 'open');
    expect(listener).toHaveBeenNthCalledWith(2, 'half-open');
  });
});
