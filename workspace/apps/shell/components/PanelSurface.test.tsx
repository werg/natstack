// @vitest-environment jsdom

import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelSurface } from "./PanelSurface";

const shellClient = vi.hoisted(() => ({
  bindNativePanelSlot: vi.fn(() => Promise.resolve()),
  updateNativePanelSlot: vi.fn(() => Promise.resolve()),
  clearNativePanelSlot: vi.fn(() => Promise.resolve()),
}));

vi.mock("../shell/client", () => ({
  view: {
    bindNativePanelSlot: shellClient.bindNativePanelSlot,
    updateNativePanelSlot: shellClient.updateNativePanelSlot,
    clearNativePanelSlot: shellClient.clearNativePanelSlot,
  },
}));

describe("PanelSurface", () => {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    vi.useFakeTimers();
    shellClient.bindNativePanelSlot.mockReset();
    shellClient.bindNativePanelSlot.mockResolvedValue(undefined);
    shellClient.updateNativePanelSlot.mockReset();
    shellClient.updateNativePanelSlot.mockResolvedValue(undefined);
    shellClient.clearNativePanelSlot.mockReset();
    shellClient.clearNativePanelSlot.mockResolvedValue(undefined);
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 420,
      bottom: 330,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    })) as typeof HTMLElement.prototype.getBoundingClientRect;
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(Date.now()), 0);
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn((id: number) => {
      window.clearTimeout(id);
    }) as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    vi.useRealTimers();
  });

  it("retries binding when the panel WebContentsView is not ready yet", async () => {
    shellClient.bindNativePanelSlot
      .mockRejectedValueOnce(new Error("Native panel slot target is not a panel view: panel-1"))
      .mockResolvedValueOnce(undefined);

    render(<PanelSurface nativeSlotId="slot-1" panelId="panel-1" focused />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(shellClient.bindNativePanelSlot).toHaveBeenCalledTimes(2);
    expect(shellClient.bindNativePanelSlot).toHaveBeenLastCalledWith({
      nativeSlotId: "slot-1",
      panelId: "panel-1",
      focused: true,
      bounds: { x: 20, y: 30, width: 400, height: 300 },
    });
  });
});
