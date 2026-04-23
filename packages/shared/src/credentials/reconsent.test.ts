import { describe, expect, it, vi } from "vitest";
import { ReconsentHandler } from "./reconsent.js";
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
    scopes: ["repo"],
    ...overrides,
  };
}

describe("ReconsentHandler", () => {
  it("coalesces concurrent re-consent requests for the same connection", async () => {
    const request = deferred<Credential>();
    const credential = makeCredential();
    const deps = {
      requestReconsent: vi.fn(() => request.promise),
    };
    const handler = new ReconsentHandler(deps);

    const first = handler.handleRefreshFailure("github", "conn-1");
    const second = handler.handleRefreshFailure("github", "conn-1");

    expect(first).toBe(second);
    expect(deps.requestReconsent).toHaveBeenCalledTimes(1);
    expect(deps.requestReconsent).toHaveBeenCalledWith("github", "conn-1", "refresh_failed");

    request.resolve(credential);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(credential);
    expect(secondResult).toBe(credential);
  });
});
