import type { Credential } from "./types.js";

export interface RefreshDeps {
  loadCredential: (providerId: string, connectionId: string) => Promise<Credential>;
  saveCredential: (credential: Credential) => Promise<void>;
  executeRefresh: (credential: Credential) => Promise<Credential>;
  getRefreshBuffer: (providerId: string) => number;
}

export class RefreshScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingRefreshes = new Map<string, Promise<Credential>>();
  private readonly scheduleVersions = new Map<string, number>();

  constructor(private readonly deps: RefreshDeps) {}

  async schedule(providerId: string, connectionId: string): Promise<void> {
    const key = this.makeKey(providerId, connectionId);
    const version = this.bumpScheduleVersion(key);

    this.clearTimer(key);

    const credential = await this.deps.loadCredential(providerId, connectionId);
    if (this.scheduleVersions.get(key) !== version || credential.expiresAt === undefined) {
      return;
    }

    const bufferSeconds = this.deps.getRefreshBuffer(providerId);
    const delayMs = Math.max(0, credential.expiresAt - Date.now() - bufferSeconds * 1000);

    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.refreshNow(providerId, connectionId).catch(() => {});
    }, delayMs);

    this.timers.set(key, timer);
  }

  cancel(providerId: string, connectionId: string): void {
    const key = this.makeKey(providerId, connectionId);
    this.bumpScheduleVersion(key);
    this.clearTimer(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }

    for (const key of this.scheduleVersions.keys()) {
      this.bumpScheduleVersion(key);
    }

    this.timers.clear();
  }

  refreshNow(providerId: string, connectionId: string): Promise<Credential> {
    const key = this.makeKey(providerId, connectionId);
    const existing = this.pendingRefreshes.get(key);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const credential = await this.deps.loadCredential(providerId, connectionId);
      const refreshed = await this.deps.executeRefresh(credential);
      await this.deps.saveCredential(refreshed);
      return refreshed;
    })().finally(() => {
      this.pendingRefreshes.delete(key);
    });

    this.pendingRefreshes.set(key, pending);
    return pending;
  }

  private makeKey(providerId: string, connectionId: string): string {
    return `${providerId}:${connectionId}`;
  }

  private bumpScheduleVersion(key: string): number {
    const nextVersion = (this.scheduleVersions.get(key) ?? 0) + 1;
    this.scheduleVersions.set(key, nextVersion);
    return nextVersion;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.timers.delete(key);
  }
}
