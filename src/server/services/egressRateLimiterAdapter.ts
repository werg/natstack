import { RateLimiter } from "../../../packages/shared/src/credentials/rateLimit.js";
import type { ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import type { EgressRateLimiter } from "./egressProxy.js";

export class EgressRateLimiterAdapter implements EgressRateLimiter {
  private readonly limiters = new Map<string, RateLimiter>();

  getLimiter(
    key: string,
    provider?: ProviderManifest,
    connectionId?: string,
  ): Pick<RateLimiter, "tryConsume" | "recordRetryAfter"> {
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
