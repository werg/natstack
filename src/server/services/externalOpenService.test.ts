import {
  createVerifiedCaller,
  DEFERRED_RESULT,
  isDeferredResult,
} from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventService } from "@natstack/shared/eventsService";
import { ELECTRON_LOCAL_SERVICE_NAMES } from "@natstack/rpc";
import { createExternalOpenService } from "./externalOpenService.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";

describe("externalOpenService", () => {
  it("is routed to the server by default from panel RPC", () => {
    expect((ELECTRON_LOCAL_SERVICE_NAMES as readonly string[]).includes("externalOpen")).toBe(
      false
    );
  });

  function tempStatePath(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-external-open-"));
  }

  function createApprovalQueueMock(): ApprovalQueue {
    return {
      request: vi.fn(async () => "session" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
      presentDeviceCode: vi.fn(() => ({
        approvalId: "device-code-test",
        cancelled: new AbortController().signal,
        dispose: vi.fn(),
      })),
      resolve: vi.fn(),
      resolveUserland: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
      cancelForCaller: vi.fn(),
    };
  }

  const panelCaller = () =>
    createVerifiedCaller("panel-1", "panel", {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "version-1",
    });

  const workerCaller = () =>
    createVerifiedCaller("worker-1", "worker", {
      callerId: "worker-1",
      callerKind: "worker",
      repoPath: "workers/example",
      effectiveVersion: "version-1",
    });

  const doCaller = () =>
    createVerifiedCaller("do:workers/example:ExampleDO:agent-1", "do", {
      callerId: "do:workers/example:ExampleDO:agent-1",
      callerKind: "do",
      repoPath: "workers/example",
      effectiveVersion: "version-1",
    });

  it("requests approval for DO opens", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await expect(
      service.handler({ caller: doCaller() }, "openExternal", ["https://example.com/path"])
    ).resolves.toEqual({ approvalDecision: "session" });
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "do:workers/example:ExampleDO:agent-1",
        callerKind: "do",
        repoPath: "workers/example",
      })
    );
  });

  it("requests approval for panel opens and emits approved browser events", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const approvalQueue = createApprovalQueueMock();
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore,
    });

    const result = await service.handler({ caller: panelCaller() }, "openExternal", [
      "https://example.com/path?q=1#fragment",
    ]);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "external-browser-open",
        resource: {
          type: "url-origin",
          label: "Origin",
          value: "https://example.com",
        },
      })
    );
    expect(emit).toHaveBeenCalledWith("external-open:open", {
      url: "https://example.com/path?q=1",
      callerId: "panel-1",
      callerKind: "panel",
    });
    expect(result).toEqual({ approvalDecision: "session" });
  });

  it("defers the open for a deferrable DO caller and opens only after approval", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const approvalQueue = createApprovalQueueMock();
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const service = createExternalOpenService({ eventService, approvalQueue, grantStore });

    let capturedWork: ((signal: AbortSignal) => Promise<unknown>) | null = null;
    const ctx = {
      caller: doCaller(),
      requestId: "req-open-1",
      deferral: {
        canDefer: true,
        run: (work: (signal: AbortSignal) => Promise<unknown>) => {
          capturedWork = work;
          return { [DEFERRED_RESULT]: true as const, requestId: "req-open-1" };
        },
      },
    };

    const outcome = await service.handler(ctx, "openExternal", ["https://example.com/x"]);
    // Acked as deferred; no approval prompt and no browser open happened inline.
    expect(isDeferredResult(outcome)).toBe(true);
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("external-open:open", expect.anything());
    expect(capturedWork).toBeTypeOf("function");

    // Running the deferred work approves, then opens the browser.
    const result = await capturedWork!(new AbortController().signal);
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "external-open:open",
      expect.objectContaining({ url: "https://example.com/x" })
    );
    expect(result).toEqual({ approvalDecision: "session" });
  });

  it("runs inline (no deferral) when a grant already exists for a deferrable caller", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const service = createExternalOpenService({ eventService, approvalQueue, grantStore });

    // First open establishes a session grant for this DO caller.
    await service.handler({ caller: doCaller() }, "openExternal", ["https://example.com/a"]);
    approvalQueue.request = vi.fn(async () => "session" as const) as never;

    const run = vi.fn();
    const ctx = {
      caller: doCaller(),
      requestId: "req-open-2",
      deferral: { canDefer: true, run },
    };
    // Same origin is already granted → fast path runs inline, never defers.
    const result = await service.handler(ctx, "openExternal", ["https://example.com/b"]);
    expect(run).not.toHaveBeenCalled();
    expect(isDeferredResult(result)).toBe(false);
  });

  it("reuses grants for the same origin", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await service.handler({ caller: workerCaller() }, "openExternal", ["https://example.com/a"]);
    await service.handler({ caller: workerCaller() }, "openExternal", ["https://example.com/b"]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("does not reuse allow-once browser approvals", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    vi.mocked(approvalQueue.request).mockResolvedValue("once");
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });

    await service.handler({ caller: workerCaller() }, "openExternal", ["https://example.com/a"]);
    await service.handler({ caller: workerCaller() }, "openExternal", ["https://example.com/b"]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("rejects non-browser schemes", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });

    await expect(
      service.handler({ caller: panelCaller() }, "openExternal", ["file:///etc/passwd"])
    ).rejects.toThrow("openExternal only supports http(s) and mailto URLs");
  });

  it("validates OAuth authorize URLs when an expected redirect URI is supplied", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    });
    const authorizeUrl = new URL("https://login.example.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "client-1");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("code_challenge", "challenge-1");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    await expect(
      service.handler({ caller: panelCaller() }, "openExternal", [
        authorizeUrl.toString(),
        { expectedRedirectUri: "http://localhost:1456/auth/callback" },
      ])
    ).rejects.toThrow("redirect_uri does not match");

    await service.handler({ caller: panelCaller() }, "openExternal", [
      authorizeUrl.toString(),
      { expectedRedirectUri: "http://localhost:1455/auth/callback" },
    ]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });
});
