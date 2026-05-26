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
});
