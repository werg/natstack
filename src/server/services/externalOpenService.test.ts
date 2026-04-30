import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventService } from "@natstack/shared/eventsService";
import { createExternalOpenService } from "./externalOpenService.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue } from "./approvalQueue.js";

describe("externalOpenService", () => {
  function tempStatePath(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-external-open-"));
  }

  function createApprovalQueueMock(): ApprovalQueue {
    return {
      request: vi.fn(async () => "session" as const),
      requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      listPending: vi.fn(() => []),
    };
  }

  it("requests approval for panel opens and emits approved browser events", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const approvalQueue = createApprovalQueueMock();
    const grantStore = new CapabilityGrantStore({ statePath: tempStatePath() });
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore,
      codeIdentityResolver: {
        resolveByCallerId: (callerId) => ({
          callerId,
          callerKind: "panel",
          repoPath: "panels/example",
          effectiveVersion: "version-1",
        }),
      },
    });

    await service.handler(
      { callerId: "panel-1", callerKind: "panel" },
      "openExternal",
      ["https://example.com/path?q=1#fragment"],
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: "external-browser-open",
      resource: {
        type: "url-origin",
        label: "Origin",
        value: "https://example.com",
      },
    }));
    expect(emit).toHaveBeenCalledWith("external-open:open", {
      url: "https://example.com/path?q=1",
      callerId: "panel-1",
      callerKind: "panel",
    });
  });

  it("reuses grants for the same origin", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: (callerId) => ({
          callerId,
          callerKind: "worker",
          repoPath: "workers/example",
          effectiveVersion: "version-1",
        }),
      },
    });

    await service.handler({ callerId: "worker-1", callerKind: "worker" }, "openExternal", ["https://example.com/a"]);
    await service.handler({ callerId: "worker-1", callerKind: "worker" }, "openExternal", ["https://example.com/b"]);

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
      codeIdentityResolver: {
        resolveByCallerId: (callerId) => ({
          callerId,
          callerKind: "worker",
          repoPath: "workers/example",
          effectiveVersion: "version-1",
        }),
      },
    });

    await service.handler({ callerId: "worker-1", callerKind: "worker" }, "openExternal", ["https://example.com/a"]);
    await service.handler({ callerId: "worker-1", callerKind: "worker" }, "openExternal", ["https://example.com/b"]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("rejects non-browser schemes", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });

    await expect(service.handler(
      { callerId: "panel-1", callerKind: "panel" },
      "openExternal",
      ["file:///etc/passwd"],
    )).rejects.toThrow("openExternal only supports http(s) and mailto URLs");
  });

  it("validates OAuth authorize URLs when an expected redirect URI is supplied", async () => {
    const eventService = new EventService();
    const approvalQueue = createApprovalQueueMock();
    const service = createExternalOpenService({
      eventService,
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
      codeIdentityResolver: {
        resolveByCallerId: (callerId) => ({
          callerId,
          callerKind: "panel",
          repoPath: "panels/example",
          effectiveVersion: "version-1",
        }),
      },
    });
    const authorizeUrl = new URL("https://login.example.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "client-1");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("code_challenge", "challenge-1");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    await expect(service.handler(
      { callerId: "panel-1", callerKind: "panel" },
      "openExternal",
      [authorizeUrl.toString(), { expectedRedirectUri: "http://localhost:1456/auth/callback" }],
    )).rejects.toThrow("redirect_uri does not match");

    await service.handler(
      { callerId: "panel-1", callerKind: "panel" },
      "openExternal",
      [authorizeUrl.toString(), { expectedRedirectUri: "http://localhost:1455/auth/callback" }],
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });
});
