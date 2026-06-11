import { describe, expect, it, vi } from "vitest";

import { ServerUnitApprovalCoordinator } from "./unitApprovalCoordinator.js";
import type { UnitBatchEntry } from "@natstack/shared/approvals";

function unit(kind: "extension" | "app", name: string): UnitBatchEntry {
  return {
    unitKind: kind,
    unitName: name,
    displayName: name,
    target: kind === "app" ? "electron" : null,
    source: {
      kind: "internal-git",
      repo: `${kind === "app" ? "apps" : "extensions"}/@workspace/${name}`,
      ref: "main",
    },
    ev: `${name}-ev`,
    capabilities: [],
  };
}

describe("ServerUnitApprovalCoordinator", () => {
  it("combines app and extension startup approvals into one unit batch", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
    const applyExtension = vi.fn(async () => undefined);
    const applyApp = vi.fn(async () => undefined);

    const first = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("extension", "image-service")],
      applyApproved: applyExtension,
      applyDenied: vi.fn(),
    });
    const second = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "shell")],
      applyApproved: applyApp,
      applyDenied: vi.fn(),
    });

    await Promise.all([first, second]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "system:units",
        title: "Approve workspace units",
        units: [
          expect.objectContaining({ unitKind: "extension", unitName: "image-service" }),
          expect.objectContaining({ unitKind: "app", unitName: "shell" }),
        ],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("fans out a deny decision to every enqueued host request", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
    const denyExtension = vi.fn();
    const denyApp = vi.fn();
    const apply = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "image-service")],
        applyApproved: apply,
        applyDenied: denyExtension,
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: apply,
        applyDenied: denyApp,
      }),
    ]);

    expect(apply).not.toHaveBeenCalled();
    expect(denyExtension).toHaveBeenCalledOnce();
    expect(denyApp).toHaveBeenCalledOnce();
  });

  it("auto-approves startup app batches for freshly created trusted template workspaces", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      delayMs: 1,
      autoApproveStartup: true,
    });
    const apply = vi.fn(async () => undefined);
    const deny = vi.fn();

    await coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "shell")],
      applyApproved: apply,
      applyDenied: deny,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
    expect(deny).not.toHaveBeenCalled();
  });

  it("uses an interactive startup prompt before falling back to the shell approval queue", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const startupPrompt = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      startupPrompt,
      delayMs: 1,
    });
    const applyExtension = vi.fn(async () => undefined);
    const applyApp = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "image-service")],
        applyApproved: applyExtension,
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyApp,
        applyDenied: vi.fn(),
      }),
    ]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(startupPrompt.request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Approve workspace units",
        units: [
          expect.objectContaining({ unitKind: "extension", unitName: "image-service" }),
          expect.objectContaining({ unitKind: "app", unitName: "shell" }),
        ],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
    expect(applyApp).toHaveBeenCalledOnce();
  });

  it("auto-approves startup app batches before interactive startup approval", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const startupPrompt = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      startupPrompt,
      autoApproveStartup: true,
      delayMs: 1,
    });
    const apply = vi.fn(async () => undefined);

    await coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "shell")],
      applyApproved: apply,
      applyDenied: vi.fn(),
    });

    expect(startupPrompt.request).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("prompts only for unresolved startup extension batches when app startup is auto-approved", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const startupPrompt = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      startupPrompt,
      autoApproveStartup: true,
      delayMs: 1,
    });
    const applyExtension = vi.fn(async () => undefined);
    const applyApp = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "image-service")],
        applyApproved: applyExtension,
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyApp,
        applyDenied: vi.fn(),
      }),
    ]);

    expect(applyApp).toHaveBeenCalledOnce();
    expect(startupPrompt.request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Approve workspace extensions",
        units: [expect.objectContaining({ unitKind: "extension", unitName: "image-service" })],
      })
    );
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(applyExtension).toHaveBeenCalledOnce();
  });

  it("still prompts for startup extension batches when template app startup is auto-approved", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      delayMs: 1,
      autoApproveStartup: true,
    });
    const applyExtension = vi.fn(async () => undefined);
    const applyApp = vi.fn(async () => undefined);

    await Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "image-service")],
        applyApproved: applyExtension,
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyApp,
        applyDenied: vi.fn(),
      }),
    ]);

    expect(applyApp).toHaveBeenCalledOnce();
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        title: "Approve workspace extensions",
        units: [expect.objectContaining({ unitKind: "extension", unitName: "image-service" })],
      })
    );
    expect(applyExtension).toHaveBeenCalledOnce();
  });

  it("still prompts for meta-push batches when startup auto-approval is enabled", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      delayMs: 1,
      autoApproveStartup: true,
    });

    await coordinator.enqueue({
      trigger: "meta-push",
      entries: [unit("extension", "shell")],
      applyApproved: vi.fn(async () => undefined),
      applyDenied: vi.fn(),
    });

    expect(approvalQueue.request).toHaveBeenCalledOnce();
  });
});
