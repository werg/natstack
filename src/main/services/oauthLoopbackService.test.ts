import { describe, expect, it } from "vitest";

import { createOAuthLoopbackService } from "./oauthLoopbackService.js";

const ctx = { callerId: "panel:test", callerKind: "panel" as const };

describe("oauthLoopbackService", () => {
  it("routes shared listener callbacks by expected OAuth state", async () => {
    const service = createOAuthLoopbackService();
    const first = await service.handler!(ctx, "createLoopbackCallback", [{
      host: "127.0.0.1",
      port: 0,
      callbackPath: "/auth/callback",
    }]) as { callbackId: string; redirectUri: string };
    const second = await service.handler!(ctx, "createLoopbackCallback", [{
      host: "127.0.0.1",
      port: 0,
      callbackPath: "/auth/callback",
    }]) as { callbackId: string; redirectUri: string };

    expect(second.redirectUri).toBe(first.redirectUri);

    await service.handler!(ctx, "expectLoopbackCallbackState", [{ callbackId: first.callbackId, state: "state-1" }]);
    await service.handler!(ctx, "expectLoopbackCallbackState", [{ callbackId: second.callbackId, state: "state-2" }]);

    const firstWait = service.handler!(ctx, "waitForLoopbackCallback", [first.callbackId]);
    const secondWait = service.handler!(ctx, "waitForLoopbackCallback", [second.callbackId]);

    await fetch(`${second.redirectUri}?code=second-code&state=state-2`);

    await expect(secondWait).resolves.toMatchObject({
      code: "second-code",
      state: "state-2",
    });
    await expect(Promise.race([
      firstWait.then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ])).resolves.toBe("pending");

    await fetch(`${first.redirectUri}?code=first-code&state=state-1`);
    await expect(firstWait).resolves.toMatchObject({
      code: "first-code",
      state: "state-1",
    });
  });
});
