import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshScheduler } from "./refresh.js";
import type { Credential } from "./types.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    providerId: "github",
    connectionId: "conn-1",
    connectionLabel: "GitHub",
    accountIdentity: {
      providerUserId: "user-1",
    },
    accessToken: "access-token",
    refreshToken: "refresh-token",
    scopes: ["repo"],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("RefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules proactive refresh based on expiry minus buffer", async () => {
    const credential = makeCredential({ expiresAt: Date.now() + 60_000 });
    const refreshed = makeCredential({
      accessToken: "new-access-token",
      expiresAt: Date.now() + 120_000,
    });
    const deps = {
      loadCredential: vi.fn().mockResolvedValue(credential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
      executeRefresh: vi.fn().mockResolvedValue(refreshed),
      getRefreshBuffer: vi.fn().mockReturnValue(10),
    };
    const scheduler = new RefreshScheduler(deps);

    await scheduler.schedule("github", "conn-1");

    await vi.advanceTimersByTimeAsync(49_999);
    expect(deps.executeRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(deps.loadCredential).toHaveBeenCalledTimes(2);
    expect(deps.executeRefresh).toHaveBeenCalledTimes(1);
    expect(deps.executeRefresh).toHaveBeenCalledWith(credential);
    expect(deps.saveCredential).toHaveBeenCalledWith(refreshed);
  });

  it("cancel prevents a scheduled refresh", async () => {
    const credential = makeCredential({ expiresAt: Date.now() + 60_000 });
    const deps = {
      loadCredential: vi.fn().mockResolvedValue(credential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
      executeRefresh: vi.fn().mockResolvedValue(credential),
      getRefreshBuffer: vi.fn().mockReturnValue(10),
    };
    const scheduler = new RefreshScheduler(deps);

    await scheduler.schedule("github", "conn-1");
    scheduler.cancel("github", "conn-1");

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.executeRefresh).not.toHaveBeenCalled();
    expect(deps.saveCredential).not.toHaveBeenCalled();
  });

  it("cancelAll prevents all scheduled refreshes", async () => {
    const firstCredential = makeCredential({
      providerId: "github",
      connectionId: "conn-1",
      expiresAt: Date.now() + 60_000,
    });
    const secondCredential = makeCredential({
      providerId: "google",
      connectionId: "conn-2",
      expiresAt: Date.now() + 90_000,
    });
    const deps = {
      loadCredential: vi
        .fn()
        .mockResolvedValueOnce(firstCredential)
        .mockResolvedValueOnce(secondCredential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
      executeRefresh: vi.fn().mockResolvedValue(firstCredential),
      getRefreshBuffer: vi.fn().mockReturnValue(10),
    };
    const scheduler = new RefreshScheduler(deps);

    await scheduler.schedule("github", "conn-1");
    await scheduler.schedule("google", "conn-2");
    scheduler.cancelAll();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(deps.executeRefresh).not.toHaveBeenCalled();
    expect(deps.saveCredential).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshNow calls for the same connection", async () => {
    const credential = makeCredential();
    const refresh = deferred<Credential>();
    const refreshed = makeCredential({ accessToken: "new-access-token" });
    const deps = {
      loadCredential: vi.fn().mockResolvedValue(credential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
      executeRefresh: vi.fn(() => refresh.promise),
      getRefreshBuffer: vi.fn().mockReturnValue(10),
    };
    const scheduler = new RefreshScheduler(deps);

    const first = scheduler.refreshNow("github", "conn-1");
    const second = scheduler.refreshNow("github", "conn-1");
    await Promise.resolve();

    expect(first).toBe(second);
    expect(deps.loadCredential).toHaveBeenCalledTimes(1);
    expect(deps.executeRefresh).toHaveBeenCalledTimes(1);

    refresh.resolve(refreshed);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(refreshed);
    expect(secondResult).toBe(refreshed);
    expect(deps.saveCredential).toHaveBeenCalledTimes(1);
    expect(deps.saveCredential).toHaveBeenCalledWith(refreshed);
  });

  it("propagates refreshNow failures to the caller", async () => {
    const credential = makeCredential();
    const error = new Error("refresh failed");
    const deps = {
      loadCredential: vi.fn().mockResolvedValue(credential),
      saveCredential: vi.fn().mockResolvedValue(undefined),
      executeRefresh: vi.fn().mockRejectedValue(error),
      getRefreshBuffer: vi.fn().mockReturnValue(10),
    };
    const scheduler = new RefreshScheduler(deps);

    await expect(scheduler.refreshNow("github", "conn-1")).rejects.toThrow("refresh failed");
    expect(deps.saveCredential).not.toHaveBeenCalled();
  });
});
