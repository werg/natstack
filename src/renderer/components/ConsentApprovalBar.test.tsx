// @vitest-environment jsdom

import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shellClient = vi.hoisted(() => ({
  heartbeat: vi.fn(() => Promise.resolve()),
  listPending: vi.fn(() => Promise.resolve([])),
  subscribe: vi.fn(() => Promise.resolve()),
  unsubscribe: vi.fn(() => Promise.resolve()),
}));

vi.mock("../shell/client", () => ({
  shellApproval: {
    listPending: shellClient.listPending,
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
