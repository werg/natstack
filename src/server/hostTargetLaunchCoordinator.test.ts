import { describe, expect, it, vi } from "vitest";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
import type { HostTargetLaunchResult } from "@natstack/shared/hostTargets";
import { HostTargetLaunchCoordinator } from "./hostTargetLaunchCoordinator.js";
import type { AppHost } from "./appHost.js";

const mobileApproval: PendingUnitBatchApproval = {
  approvalId: "approval-mobile",
  kind: "unit-batch",
  callerId: "system:units",
  callerKind: "system",
  repoPath: "meta",
  effectiveVersion: "",
  trigger: "startup",
  title: "Approve workspace units",
  description: "Approve before launch",
  units: [
    {
      unitKind: "app",
      unitName: "@workspace-apps/mobile",
      displayName: "Mobile",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      ev: "ev-mobile",
      capabilities: [],
      dependencyEvs: {},
      externalDeps: {},
    },
  ],
  configWrite: null,
  requestedAt: 1,
};

function makeCoordinator(opts: {
  pending?: PendingUnitBatchApproval[];
  launch?: HostTargetLaunchResult;
  trustedUnits?: Array<{ kind: string; name: string; source: string; status: string }>;
}) {
  const emit = vi.fn();
  const publishPending = vi.fn();
  let pending = opts.pending ?? [];
  const resolve = vi.fn((approvalId: string) => {
    pending = pending.filter((approval) => approval.approvalId !== approvalId);
  });
  const launchHostTarget = vi.fn(async () =>
    opts.launch
      ? opts.launch
      : ({
          status: "unavailable",
          launched: false,
          target: "electron",
          reason: "No app",
          details: [],
        } satisfies HostTargetLaunchResult)
  );
  const coordinator = new HostTargetLaunchCoordinator({
    approvalQueue: {
      listPending: () => pending,
      resolve,
    },
    eventService: { emit },
    startupApprovals: { publishPending },
    getAppHost: () => ({ launchHostTarget }) as unknown as AppHost,
    getTrustedUnitHosts: () => [
      {
        listWorkspaceUnits: () => opts.trustedUnits ?? [],
      },
    ],
  });
  return { coordinator, emit, publishPending, launchHostTarget, resolve };
}

describe("HostTargetLaunchCoordinator", () => {
  it("returns pending startup approvals before touching the app host without self-notifying", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({
      pending: [mobileApproval],
    });

    const result = await coordinator.launch("react-native");

    expect(result.status).toBe("approval-required");
    expect(launchHostTarget).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("turns provider-inactive React Native startup into preparing while trusted units build without self-notifying", async () => {
    const { coordinator, emit, publishPending } = makeCoordinator({
      launch: {
        status: "unavailable",
        launched: false,
        target: "react-native",
        reason: "React Native build provider is not active",
        details: ["Last failure phase: build"],
      },
      trustedUnits: [
        {
          kind: "extension",
          name: "@workspace-extensions/react-native",
          source: "extensions/react-native",
          status: "building",
        },
      ],
    });

    const result = await coordinator.launch("react-native");

    expect(result).toEqual({
      status: "preparing",
      launched: false,
      target: "react-native",
      reason: "React Native workspace startup is preparing",
      details: [
        "Last failure phase: build",
        "@workspace-extensions/react-native (extensions/react-native) status: building",
      ],
    });
    expect(publishPending).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns ready launch state without self-notifying", async () => {
    const { coordinator, emit } = makeCoordinator({
      launch: {
        status: "ready",
        launched: true,
        target: "terminal",
        source: "apps/terminal",
        appId: "@workspace-apps/terminal",
        buildKey: "build-1",
      },
    });

    const result = await coordinator.launch("terminal");

    expect(result.status).toBe("ready");
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns a starting session promptly while launch resolution continues", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({});
    let resolveLaunch!: (value: HostTargetLaunchResult) => void;
    const launch = new Promise<HostTargetLaunchResult>((resolve) => {
      resolveLaunch = resolve;
    });
    launchHostTarget.mockImplementationOnce(async () => await launch);
    vi.useFakeTimers();
    try {
      const pending = coordinator.beginLaunch("react-native");

      await vi.advanceTimersByTimeAsync(300);
      const session = await pending;

      expect(session).toMatchObject({
        target: "react-native",
        status: "starting",
        settled: false,
      });
      expect(emit).not.toHaveBeenCalled();

      resolveLaunch({
        status: "ready",
        launched: true,
        target: "react-native",
        source: "apps/mobile",
        appId: "@workspace-apps/mobile",
        buildKey: "build-mobile",
      });
      await vi.runAllTimersAsync();

      expect(coordinator.getLaunchSession(session.sessionId)).toMatchObject({
        status: "ready",
        settled: true,
        launch: expect.objectContaining({
          status: "ready",
          appId: "@workspace-apps/mobile",
        }),
      });
      expect(emit).toHaveBeenCalledWith(
        "host-target-launch:session-changed",
        expect.objectContaining({
          sessionId: session.sessionId,
          target: "react-native",
          status: "ready",
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits explicit target change notifications for underlying state changes", () => {
    const { coordinator, emit } = makeCoordinator({});

    coordinator.notifyTargetChanged("terminal", "app-status");

    expect(emit).toHaveBeenCalledWith(
      "host-targets:changed",
      expect.objectContaining({
        target: "terminal",
        status: "unknown",
        reason: "app-status",
        revision: 1,
      })
    );
  });

  it("begins a launch session and emits approval-required session state", async () => {
    const { coordinator, emit, launchHostTarget } = makeCoordinator({
      pending: [mobileApproval],
    });

    const session = await coordinator.beginLaunch("react-native");

    expect(session).toMatchObject({
      target: "react-native",
      status: "approval-required",
      currentPhase: "review-trust",
      approvals: [mobileApproval],
      approvalViews: [
        expect.objectContaining({
          approvalId: "approval-mobile",
          title: expect.any(String),
        }),
      ],
      settled: false,
    });
    expect(launchHostTarget).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      "host-target-launch:session-changed",
      expect.objectContaining({
        sessionId: session.sessionId,
        target: "react-native",
        status: "approval-required",
      })
    );
  });

  it("reuses an unresolved launch session for the same target", async () => {
    const { coordinator } = makeCoordinator({
      pending: [mobileApproval],
    });

    const first = await coordinator.beginLaunch("react-native");
    const second = await coordinator.beginLaunch("react-native");

    expect(second.sessionId).toBe(first.sessionId);
  });

  it("resolves session approvals and advances to the ready launch", async () => {
    const { coordinator, resolve } = makeCoordinator({
      pending: [mobileApproval],
      launch: {
        status: "ready",
        launched: true,
        target: "react-native",
        source: "apps/mobile",
        appId: "@workspace-apps/mobile",
        buildKey: "build-mobile",
      },
    });
    const session = await coordinator.beginLaunch("react-native");

    const ready = await coordinator.resolveLaunchSessionApproval(session.sessionId, "once");

    expect(resolve).toHaveBeenCalledWith("approval-mobile", "once");
    expect(ready).toMatchObject({
      sessionId: session.sessionId,
      status: "ready",
      approvalsResolved: 1,
      settled: true,
      launch: expect.objectContaining({
        status: "ready",
        appId: "@workspace-apps/mobile",
      }),
    });
  });
});
