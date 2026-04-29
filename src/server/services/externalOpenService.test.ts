import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventService } from "@natstack/shared/eventsService";
import { createExternalOpenService } from "./externalOpenService.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";

describe("externalOpenService", () => {
  function tempStatePath(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-external-open-"));
  }

  it("requests approval for panel opens and emits approved browser events", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
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
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
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

  it("rejects non-browser schemes", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });

    await expect(service.handler(
      { callerId: "panel-1", callerKind: "panel" },
      "openExternal",
      ["file:///etc/passwd"],
    )).rejects.toThrow("openExternal only supports http(s) and mailto URLs");
  });
});
