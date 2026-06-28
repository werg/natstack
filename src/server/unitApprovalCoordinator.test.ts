import { describe, expect, it, vi } from "vitest";

import type { UnitBatchEntry } from "@natstack/shared/approvals";
import { ServerUnitApprovalCoordinator } from "./unitApprovalCoordinator.js";

function unit(kind: "extension" | "app", name: string): UnitBatchEntry {
  return {
    unitKind: kind,
    unitName: name,
    displayName: name,
    target: kind === "app" ? "electron" : null,
    source: {
      kind: "workspace-repo",
      repo: `${kind === "app" ? "apps" : "extensions"}/${name}`,
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

  it("applies approved extensions before approved apps", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 1 });
    const order: string[] = [];
    let releaseExtension!: () => void;
    const extensionApplied = new Promise<void>((resolve) => {
      releaseExtension = resolve;
    });
    const applyExtension = vi.fn(async () => {
      order.push("extension:start");
      await extensionApplied;
      order.push("extension:done");
    });
    const applyApp = vi.fn(async () => {
      order.push("app:start");
    });

    const pending = Promise.all([
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("app", "shell")],
        applyApproved: applyApp,
        applyDenied: vi.fn(),
      }),
      coordinator.enqueue({
        trigger: "startup",
        entries: [unit("extension", "react-native")],
        applyApproved: applyExtension,
        applyDenied: vi.fn(),
      }),
    ]);

    coordinator.publishPending("startup");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["extension:start"]);
    expect(applyApp).not.toHaveBeenCalled();

    releaseExtension();
    await pending;

    expect(order).toEqual(["extension:start", "extension:done", "app:start"]);
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

  it("auto-approves startup unit batches when explicitly enabled", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    };
    const coordinator = new ServerUnitApprovalCoordinator({
      approvalQueue,
      delayMs: 1,
      autoApproveStartupUnits: true,
    });
    const applyApp = vi.fn(async () => undefined);
    const denyApp = vi.fn();

    await coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "shell")],
      applyApproved: applyApp,
      applyDenied: denyApp,
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(applyApp).toHaveBeenCalledOnce();
    expect(denyApp).not.toHaveBeenCalled();
  });

  it("can publish a queued batch before the timer fires", async () => {
    let resolveDecision!: (decision: "once") => void;
    const approvalQueue = {
      request: vi.fn(
        () =>
          new Promise<"once">((resolve) => {
            resolveDecision = resolve;
          })
      ),
    };
    const coordinator = new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 10_000 });
    const applyApp = vi.fn(async () => undefined);

    const pending = coordinator.enqueue({
      trigger: "startup",
      entries: [unit("app", "remote-cli")],
      applyApproved: applyApp,
      applyDenied: vi.fn(),
    });

    expect(approvalQueue.request).not.toHaveBeenCalled();
    coordinator.publishPending("startup");
    expect(approvalQueue.request).toHaveBeenCalledOnce();
    expect(applyApp).not.toHaveBeenCalled();

    resolveDecision("once");
    await pending;
    expect(applyApp).toHaveBeenCalledOnce();
  });
});
