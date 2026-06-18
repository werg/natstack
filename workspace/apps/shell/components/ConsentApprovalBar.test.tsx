// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingCapabilityApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "@natstack/shared/approvals";

type ListPendingFn = () => Promise<unknown[]>;
const shellClient = vi.hoisted(() => ({
  heartbeat: vi.fn(() => Promise.resolve()),
  listPending: vi.fn<ListPendingFn>(() => Promise.resolve([])),
  resolve: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
  onRpcEvent: vi.fn((_event: string, _listener: (event: { payload: unknown }) => void) => () => {}),
}));

vi.mock("../shell/client", () => ({
  shellApproval: {
    listPending: shellClient.listPending,
    resolve: shellClient.resolve,
    resolveUserland: vi.fn(() => Promise.resolve()),
    submitClientConfig: vi.fn(() => Promise.resolve()),
    submitCredentialInput: vi.fn(() => Promise.resolve()),
  },
  shellPresence: {
    heartbeat: shellClient.heartbeat,
  },
  view: {
    updateLayout: vi.fn(() => Promise.resolve()),
  },
  events: {
    subscribe: shellClient.subscribe,
    unsubscribe: shellClient.unsubscribe,
  },
  onRpcEvent: shellClient.onRpcEvent,
}));

vi.mock("./NavigationContext", () => ({
  useNavigation: () => ({
    navigateToId: vi.fn(),
    registerNavigateToId: vi.fn(),
    addressBarVisible: false,
    setAddressBarVisible: vi.fn(),
  }),
}));

import { ConsentApprovalBar } from "./ConsentApprovalBar";

describe("ConsentApprovalBar shell presence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    shellClient.heartbeat.mockClear();
    shellClient.listPending.mockClear();
    shellClient.resolve.mockClear();
    shellClient.resolve.mockImplementation(() => Promise.resolve());
    shellClient.subscribe.mockClear();
    shellClient.unsubscribe.mockClear();
    shellClient.onRpcEvent.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a heartbeat while mounted even when no approvals are pending", async () => {
    const { unmount } = render(React.createElement(ConsentApprovalBar));

    expect(shellClient.heartbeat).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(shellClient.listPending).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(2);
    expect(shellClient.listPending).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(3);
    expect(shellClient.listPending).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(3);
    expect(shellClient.listPending).toHaveBeenCalledTimes(1);
  });
});

function userlandApproval(
  partial: Partial<PendingUserlandApproval> & { approvalId: string; title: string }
): PendingUserlandApproval {
  return {
    kind: "userland",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    callerTitle: partial.callerTitle,
    subject: partial.subject ?? { id: "sub-1", label: "Subject" },
    title: partial.title,
    summary: partial.summary,
    promptOptions: partial.promptOptions ?? "choices",
    options: partial.options ?? [{ value: "ok", label: "OK", tone: "primary" }],
    approvalId: partial.approvalId,
  };
}

function capabilityApproval(
  partial: Partial<PendingCapabilityApproval> & { approvalId: string; title: string }
): PendingCapabilityApproval {
  return {
    kind: "capability",
    callerId: partial.callerId ?? `panel:${partial.approvalId}`,
    callerKind: partial.callerKind ?? "panel",
    repoPath: partial.repoPath ?? "panels/test",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    capability: partial.capability ?? "panel.automate",
    severity: partial.severity,
    title: partial.title,
    description: partial.description,
    resource: partial.resource ?? {
      type: "panel",
      label: "Panel",
      value: "Shell",
    },
    grantResourceKey: partial.grantResourceKey,
    details: partial.details,
    approvalId: partial.approvalId,
  };
}

function unitBatchApproval(
  partial: Partial<PendingUnitBatchApproval> & { approvalId: string }
): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    trigger: partial.trigger ?? "source-change",
    callerId: partial.callerId ?? "system:units",
    callerKind: partial.callerKind ?? "system",
    repoPath: partial.repoPath ?? "meta",
    effectiveVersion: partial.effectiveVersion ?? "ev",
    requestedAt: partial.requestedAt ?? Date.now(),
    title: partial.title ?? "Approve workspace extensions",
    description: partial.description ?? "This workspace declares extensions.",
    approvalId: partial.approvalId,
    units:
      partial.units ??
      Array.from({ length: 2 }, (_, index) => ({
        unitKind: "extension" as const,
        unitName: `@workspace-extensions/ext-${index + 1}`,
        displayName: `Extension ${index + 1}`,
        version: "0.1.0",
        source: {
          kind: "workspace-repo" as const,
          repo: `extensions/ext-${index + 1}`,
          ref: "main",
        },
        ev: `ev-${index + 1}`,
        capabilities: ["node:fs", "node:process"],
      })),
  };
}

describe("ConsentApprovalBar queue browsing", () => {
  beforeEach(() => {
    shellClient.heartbeat.mockClear();
    shellClient.listPending.mockClear();
    shellClient.resolve.mockClear();
    shellClient.resolve.mockImplementation(() => Promise.resolve());
    shellClient.onRpcEvent.mockClear();
  });

  it("shows a queue navigator when multiple approvals are pending and steps through them", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "a1", title: "First approval", callerTitle: "Chat A" }),
      userlandApproval({ approvalId: "a2", title: "Second approval", callerTitle: "Chat B" }),
      userlandApproval({ approvalId: "a3", title: "Third approval", callerTitle: "Chat C" }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    // Wait for the initial listPending to resolve and the first approval to
    // render. We assert on the title text so we know we're looking at the
    // active item, not just any approval payload.
    await waitFor(() => {
      expect(screen.getByText("First approval")).toBeTruthy();
    });
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // Step forward.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Next approval"));
    });
    expect(screen.getByText("Second approval")).toBeTruthy();
    expect(screen.getByText("2 / 3")).toBeTruthy();

    // Step backward.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Previous approval"));
    });
    expect(screen.getByText("First approval")).toBeTruthy();
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("does not render startup privileged-unit approvals in the runtime consent bar", async () => {
    const runtimeApproval = userlandApproval({
      approvalId: "runtime-approval",
      title: "Runtime approval",
    });
    shellClient.listPending.mockResolvedValueOnce([
      unitBatchApproval({
        approvalId: "desktop-app-startup",
        title: "Approve desktop app",
        trigger: "startup",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            displayName: "Shell",
            version: "0.1.0",
            target: "electron",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
            ev: "ev-shell",
            capabilities: ["panel-hosting"],
          },
        ],
      }),
      unitBatchApproval({
        approvalId: "mobile-app-startup",
        title: "Approve mobile app",
        trigger: "startup",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "Mobile",
            version: "0.1.0",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
            ev: "ev-mobile",
            capabilities: [],
          },
        ],
      }),
      unitBatchApproval({
        approvalId: "extension-startup",
        title: "Approve native extension",
        trigger: "startup",
      }),
      runtimeApproval,
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Runtime approval")).toBeTruthy();
    });
    expect(screen.queryByText("Approve desktop app")).toBeNull();
    expect(screen.queryByText("Approve mobile app")).toBeNull();
    expect(screen.queryByText("Approve native extension")).toBeNull();
    expect(screen.queryByText("1 / 4")).toBeNull();
  });

  it("does not render a navigator for a single pending approval", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "solo", title: "Lonely approval" }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Lonely approval")).toBeTruthy();
    });
    expect(screen.queryByLabelText("Next approval")).toBeNull();
    expect(screen.queryByLabelText("Previous approval")).toBeNull();
  });

  it("renders severe panel capability approvals with danger-tone trust action", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      capabilityApproval({
        approvalId: "cap-severe",
        title: "Drive privileged panel",
        severity: "severe",
      }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Drive privileged panel")).toBeTruthy();
    });
    const bar = screen
      .getByText("Drive privileged panel")
      .closest(".approval-bar") as HTMLElement | null;
    expect(bar?.style.getPropertyValue("--app-approval-stripe")).toBe(
      "var(--app-approval-red-stripe)"
    );
    const trustButton = screen.getByText("Trust and drive").closest("button");
    expect(trustButton).toBeTruthy();
    expect(trustButton?.getAttribute("data-accent-color")).toBe("red");
  });

  it("keeps unit-batch entries collapsed inside the approval bar by default", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      unitBatchApproval({ approvalId: "extensions" }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Extension 1 · v0.1.0")).toBeTruthy();
    });

    const firstUnitDetails = screen
      .getByText("Extension 1 · v0.1.0")
      .closest("details") as HTMLDetailsElement | null;
    const secondUnitDetails = screen
      .getByText("Extension 2 · v0.1.0")
      .closest("details") as HTMLDetailsElement | null;

    expect(firstUnitDetails?.open).toBe(false);
    expect(secondUnitDetails?.open).toBe(false);
  });

  it("removes a unit-batch approval immediately when approving or denying", async () => {
    shellClient.resolve.mockImplementation(() => new Promise(() => undefined));
    shellClient.listPending.mockResolvedValueOnce([
      unitBatchApproval({
        approvalId: "apps-approval",
        title: "Approve workspace apps",
        trigger: "source-change",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "NatStack Mobile",
            version: "0.1.0",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
            ev: "ev-app",
            capabilities: ["clipboard", "keychain", "notifications", "open-external"],
          },
        ],
      }),
      unitBatchApproval({
        approvalId: "extensions-approval",
        title: "Approve workspace extensions",
      }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Approve workspace apps")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Approve change"));
    await waitFor(() => {
      expect(screen.queryByText("Approve workspace apps")).toBeNull();
      expect(screen.getByText("Approve workspace extensions")).toBeTruthy();
    });
    expect(shellClient.resolve).toHaveBeenCalledWith("apps-approval", "once");

    fireEvent.click(screen.getByText("Deny"));
    await waitFor(() => {
      expect(screen.queryByText("Approve workspace extensions")).toBeNull();
    });
    expect(shellClient.resolve).toHaveBeenCalledWith("extensions-approval", "deny");
  });

  it("restores a unit-batch approval with visible feedback when resolve fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    shellClient.resolve.mockRejectedValueOnce(new Error("resolve blocked"));
    shellClient.listPending.mockResolvedValueOnce([
      unitBatchApproval({
        approvalId: "apps-approval",
        title: "Approve workspace apps",
        trigger: "source-change",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/mobile",
            displayName: "NatStack Mobile",
            version: "0.1.0",
            target: "react-native",
            source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
            ev: "ev-app",
            capabilities: ["clipboard", "keychain", "notifications", "open-external"],
          },
        ],
      }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Approve workspace apps")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Approve change"));
    await waitFor(() => {
      expect(screen.getByText("Approval action failed: resolve blocked")).toBeTruthy();
    });
    expect(screen.getByText("Approve workspace apps")).toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith(
      "[ConsentApprovalBar] resolve failed:",
      expect.any(Error)
    );
    errorSpy.mockRestore();
  });

  it("uses distinct approval tones for app and extension source changes", async () => {
    const appApproval = unitBatchApproval({
      approvalId: "app-source",
      title: "Shell app source change",
      trigger: "source-change",
      units: [
        {
          unitKind: "app",
          unitName: "@workspace-apps/shell",
          displayName: "Shell",
          version: "0.1.0",
          target: "electron",
          source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
          ev: "ev-app",
          capabilities: ["notifications"],
        },
      ],
    });
    const extensionApproval = unitBatchApproval({
      approvalId: "extension-source",
      title: "Extension source change",
      trigger: "source-change",
    });

    shellClient.listPending.mockResolvedValueOnce([appApproval, extensionApproval]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("Shell app source change")).toBeTruthy();
    });
    expect(
      (
        screen.getByText("Shell app source change").closest(".approval-bar") as HTMLElement | null
      )?.style.getPropertyValue("--app-approval-stripe")
    ).toBe("var(--app-approval-amber-stripe)");

    fireEvent.click(screen.getByLabelText("Next approval"));
    await waitFor(() => {
      expect(screen.getByText("Extension source change")).toBeTruthy();
    });
    expect(
      (
        screen.getByText("Extension source change").closest(".approval-bar") as HTMLElement | null
      )?.style.getPropertyValue("--app-approval-stripe")
    ).toBe("var(--app-approval-red-stripe)");
  });

  it("renders pending approvals directly from event payloads", async () => {
    shellClient.listPending.mockResolvedValueOnce([
      userlandApproval({ approvalId: "a1", title: "First approval" }),
    ]);

    render(
      <Theme>
        <ConsentApprovalBar />
      </Theme>
    );

    await waitFor(() => {
      expect(screen.getByText("First approval")).toBeTruthy();
    });

    const eventCallback = shellClient.onRpcEvent.mock.calls.find(
      ([event]) => event === "event:shell-approval:pending-changed"
    )?.[1];
    expect(eventCallback).toBeTruthy();

    await act(async () => {
      eventCallback?.({
        payload: {
          pending: [
            userlandApproval({ approvalId: "a1", title: "First approval" }),
            userlandApproval({ approvalId: "a2", title: "Event approval" }),
          ],
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("First approval")).toBeTruthy();
      expect(screen.getByText("1 / 2")).toBeTruthy();
    });
    expect(screen.queryByText("Event approval")).toBeNull();
    expect(shellClient.listPending).toHaveBeenCalledTimes(1);
  });
});
