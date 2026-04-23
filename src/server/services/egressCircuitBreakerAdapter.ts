import { CircuitBreaker as SharedCircuitBreaker } from "../../../packages/shared/src/credentials/retry.js";
import type { ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import type { CircuitBreaker } from "./egressProxy.js";

export class EgressCircuitBreakerAdapter implements CircuitBreaker {
  private readonly breakers = new Map<string, SharedCircuitBreaker>();

  canRequest(key: string, provider?: ProviderManifest): boolean {
    return this.getBreaker(key, provider).isAllowed();
  }

  recordSuccess(key: string, provider?: ProviderManifest): void {
    this.getBreaker(key, provider).recordSuccess();
  }

  recordFailure(key: string, _error?: unknown, provider?: ProviderManifest): void {
    this.getBreaker(key, provider).recordFailure();
  }

  getState(key: string, provider?: ProviderManifest) {
    return this.getBreaker(key, provider).state;
  }

  private getBreaker(key: string, provider?: ProviderManifest): SharedCircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new SharedCircuitBreaker(provider?.retry);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
