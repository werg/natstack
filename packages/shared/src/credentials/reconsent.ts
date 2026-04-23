import type { Credential } from "./types.js";

export interface ReconsentDeps {
  requestReconsent: (
    providerId: string,
    connectionId: string,
    reason: string,
  ) => Promise<Credential>;
}

export class ReconsentHandler {
  private readonly pending = new Map<string, Promise<Credential>>();

  constructor(private readonly deps: ReconsentDeps) {}

  handleRefreshFailure(providerId: string, connectionId: string): Promise<Credential> {
    const key = `${providerId}:${connectionId}`;
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.deps
      .requestReconsent(providerId, connectionId, "refresh_failed")
      .finally(() => {
        this.pending.delete(key);
      });

    this.pending.set(key, pending);
    return pending;
  }
}
