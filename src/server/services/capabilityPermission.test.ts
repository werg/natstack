import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCanonicalKey } from "@natstack/shared/canonicalKey";
import { CapabilityGrantStore, capabilityGrantKey } from "./capabilityGrantStore.js";
import {
  normalizeCallerKind,
  panelCapabilityResourceKey,
  requestCapabilityPermission,
} from "./capabilityPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-capability-"));
}

function createApprovalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
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
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
    cancelForCaller: vi.fn(),
  };
}

describe("capabilityPermission", () => {
  it("uses the shared canonical key shape for session grants", () => {
    expect(
      parseCanonicalKey(
        capabilityGrantKey("session", "native.notifications", "desktop", {
          callerId: "app:apps/shell:window-1",
          repoPath: "apps/shell",
          effectiveVersion: "ev-shell",
        })
      )
    ).toEqual([
      "capability-grant",
      "session",
      "native.notifications",
      "desktop",
      "app:apps/shell:window-1",
      "apps/shell",
      "",
    ]);
  });

  it("stores reusable grants with a stable resource key", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("panel-source", "panel", {
        callerId: "panel-source",
        callerKind: "panel",
        repoPath: "panels/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: {
        type: "example",
        label: "Example",
        value: "Display value",
        key: "stable-key",
      },
      title: "Example action",
      deniedReason: "Denied",
    };

    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: {
          type: "example",
          label: "Example",
          value: "Display value",
        },
      })
    );
  });

  it.each(["version", "repo"] as const)("reuses %s-scoped capability grants", async (decision) => {
    const approvalQueue = createApprovalQueueMock(decision);
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("keeps internal version grants scoped to the concrete caller identity", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const baseRequest = {
      capability: "external-browser-open",
      resource: { type: "origin", label: "Origin", value: "https://example.com" },
      title: "Open external browser",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:natstack/internal:EvalDO:one", "do", {
        callerId: "do:natstack/internal:EvalDO:one",
        callerKind: "do",
        repoPath: "natstack/internal",
        effectiveVersion: "internal",
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:natstack/internal:EvalDO:one", "do", {
        callerId: "do:natstack/internal:EvalDO:one",
        callerKind: "do",
        repoPath: "natstack/internal",
        effectiveVersion: "internal",
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:natstack/internal:EvalDO:two", "do", {
        callerId: "do:natstack/internal:EvalDO:two",
        callerKind: "do",
        repoPath: "natstack/internal",
        effectiveVersion: "internal",
      }),
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("does not reuse legacy internal version grants without a caller identity", () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      path.join(statePath, "capability-grants.json"),
      JSON.stringify({
        grants: [
          {
            capability: "external-browser-open",
            resourceKey: "https://example.com",
            scope: "version",
            repoPath: "natstack/internal",
            effectiveVersion: "internal",
            grantedAt: 1,
          },
        ],
      })
    );

    const grantStore = new CapabilityGrantStore({ statePath });

    expect(
      grantStore.hasGrant("external-browser-open", "https://example.com", {
        callerId: "do:natstack/internal:EvalDO:one",
        repoPath: "natstack/internal",
        effectiveVersion: "internal",
      })
    ).toBe(false);
  });

  it("keys session-scoped capability grants to the concrete caller identity", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const baseRequest = {
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:first", "panel", {
        callerId: "panel:first",
        callerKind: "panel",
        repoPath: "panels/source",
        effectiveVersion: "version-1",
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:second", "panel", {
        callerId: "panel:second",
        callerKind: "panel",
        repoPath: "panels/source",
        effectiveVersion: "version-1",
      }),
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("keeps session network grants scoped to the requested origin", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = createVerifiedCaller("worker:network", "worker", {
      callerId: "worker:network",
      callerKind: "worker",
      repoPath: "workers/network",
      effectiveVersion: "version-1",
    });
    const requestForOrigin = (origin: string) => ({
      caller,
      capability: "external-network-fetch",
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Connect to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(deps, requestForOrigin("https://one.example"));
    await requestCapabilityPermission(deps, requestForOrigin("https://one.example"));
    await requestCapabilityPermission(deps, requestForOrigin("https://two.example"));

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: "https://one.example",
        resourceScope: { kind: "origin", origin: "https://one.example" },
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: "https://two.example",
        resourceScope: { kind: "origin", origin: "https://two.example" },
      })
    );
  });

  it("uses trust decisions for network-wide grants per capability", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = createVerifiedCaller("worker:network", "worker", {
      callerId: "worker:network",
      callerKind: "worker",
      repoPath: "workers/network",
      effectiveVersion: "version-1",
    });
    const requestFor = (capability: string, origin: string) => ({
      caller,
      capability,
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Network access to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(
      deps,
      requestFor("external-network-fetch", "https://one.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("external-network-fetch", "https://two.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("cors-response-read", "https://two.example")
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("keeps internal network trust scoped to the concrete caller identity", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = (id: string) =>
      createVerifiedCaller(id, "do", {
        callerId: id,
        callerKind: "do",
        repoPath: "natstack/internal",
        effectiveVersion: "internal",
      });
    const requestFor = (id: string, origin: string) => ({
      caller: caller(id),
      capability: "external-network-fetch",
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Connect to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(
      deps,
      requestFor("do:natstack/internal:EvalDO:one", "https://one.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("do:natstack/internal:EvalDO:one", "https://two.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("do:natstack/internal:EvalDO:two", "https://two.example")
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("supports requester-entity scoped panel grants even for repo/version approvals", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const targetPanelId = "target-panel";
    const baseRequest = {
      capability: "context.boundary",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Target Panel",
      },
      title: "Automate panel",
      deniedReason: "Denied",
    };

    const firstCaller = createVerifiedCaller("panel:first-entity", "panel", {
      callerId: "panel:first-entity",
      callerKind: "panel",
      repoPath: "panels/source",
      effectiveVersion: "version-1",
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: firstCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      },
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: firstCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      },
    });
    const secondCaller = createVerifiedCaller("panel:second-entity", "panel", {
      callerId: "panel:second-entity",
      callerKind: "panel",
      repoPath: "panels/source",
      effectiveVersion: "version-1",
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: secondCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, secondCaller.runtime.id),
      },
    });

    // Each requester entity is scoped by its own resource key, so a version/repo
    // grant from one requester does not satisfy another's prompt.
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: panelCapabilityResourceKey(targetPanelId, secondCaller.runtime.id),
      })
    );
  });

  it("passes capability severity through to approval prompts", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    await requestCapabilityPermission(deps, {
      caller: createVerifiedCaller("panel:source", "panel", {
        callerId: "panel:source",
        callerKind: "panel",
        repoPath: "panels/source",
        effectiveVersion: "version-1",
      }),
      capability: "context.boundary",
      severity: "severe",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Shell",
        key: panelCapabilityResourceKey("shell-panel", "panel:source"),
      },
      title: "Automate privileged panel",
      deniedReason: "Denied",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "severe",
      })
    );
  });

  describe("normalizeCallerKind", () => {
    it("accepts app, panel, worker, and do caller kinds", () => {
      expect(normalizeCallerKind("app")).toBe("app");
      expect(normalizeCallerKind("panel")).toBe("panel");
      expect(normalizeCallerKind("worker")).toBe("worker");
      expect(normalizeCallerKind("do")).toBe("do");
    });

    it("rejects shell, server, and extension caller kinds", () => {
      expect(normalizeCallerKind("shell")).toBeNull();
      expect(normalizeCallerKind("server")).toBeNull();
      expect(normalizeCallerKind("extension")).toBeNull();
    });
  });

  it("does not store allow-once grants", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        effectiveVersion: "version-1",
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });
});
