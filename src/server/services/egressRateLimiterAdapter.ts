import { RateLimiter } from "../../../packages/shared/src/credentials/rateLimit.js";
import type { ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import type { EgressRateLimiter } from "./egressProxy.js";

/**
 * No-op limiter for providers that don't specify rate limits in their
 * manifest. The egress proxy's purpose is credential injection, not
 * gatekeeping — providers that want rate limiting opt in by declaring
 * `rateLimits` in their manifest.
 */
const NOOP_LIMITER: Pick<RateLimiter, "tryConsume" | "recordRetryAfter"> = {
  tryConsume: () => ({ allowed: true }),
  recordRetryAfter: () => {},
};

function hasExplicitRateLimits(provider?: ProviderManifest): boolean {
  const config = provider?.rateLimits;
  if (!config) return false;
  return (
    typeof config.requestsPerSecond === "number" ||
    typeof config.burstSize === "number" ||
    typeof config.strategy === "string"
  );
}

export class EgressRateLimiterAdapter implements EgressRateLimiter {
  private readonly limiters = new Map<string, RateLimiter>();

  getLimiter(
    key: string,
    provider?: ProviderManifest,
    connectionId?: string,
  ): Pick<RateLimiter, "tryConsume" | "recordRetryAfter"> {
    if (!hasExplicitRateLimits(provider)) {
      return NOOP_LIMITER;
    }
    const limiterKey = provider
      ? `${key}:${provider.id}:${connectionId ?? "default"}`
      : key;
    let limiter = this.limiters.get(limiterKey);
    if (!limiter) {
      limiter = new RateLimiter(provider?.rateLimits);
      this.limiters.set(limiterKey, limiter);
    }
    return limiter;
  }
}
