// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingUserlandApproval } from "@natstack/shared/approvals";

type ListPendingFn = () => Promise<unknown[]>;
const shellClient = vi.hoisted(() => ({
  heartbeat: vi.fn(() => Promise.resolve()),
  listPending: vi.fn<ListPendingFn>(() => Promise.resolve([])),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
}));

vi.mock("../shell/client", () => ({
  shellApproval: {
    listPending: shellClient.listPending,
    resolve: vi.fn(() => Promise.resolve()),
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
  onRpcEvent: vi.fn(() => () => {}),
}));

vi.mock("../shell/useShellEvent", () => ({
  useShellEvent: vi.fn(),
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
    shellClient.subscribe.mockClear();
    shellClient.unsubscribe.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a heartbeat while mounted even when no approvals are pending", async () => {
    const { unmount } = render(React.createElement(ConsentApprovalBar));

    expect(shellClient.heartbeat).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(3);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(shellClient.heartbeat).toHaveBeenCalledTimes(3);
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

describe("ConsentApprovalBar queue browsing", () => {
  beforeEach(() => {
    shellClient.heartbeat.mockClear();
    shellClient.listPending.mockClear();
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
});
