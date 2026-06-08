import { describe, expect, it, vi } from "vitest";
import { TurnDispatcher, type TurnDispatcherRunner } from "./turn-dispatcher.js";
import type { RunnerEvent, RunnerTurnInput } from "@workspace/harness";

// Minimal runner fake: prompt() stays pending until resolvePrompt() is called,
// mirroring a turn that settles on a later (cross-request) harness event.
function createFakeRunner(): TurnDispatcherRunner & { resolvePrompt: () => void } {
  let pendingResolve: (() => void) | null = null;
  const runner: TurnDispatcherRunner & { resolvePrompt: () => void } = {
    subscribe() {
      return () => {};
    },
    buildUserMessage(input) {
      return { role: "user", content: [{ type: "text", text: String(input) }] } as never;
    },
    prompt() {
      return new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    },
    continueAgent() {
      return new Promise<void>((resolve) => {
        pendingResolve = resolve;
      });
    },
    steerMessage() {
      return Promise.resolve();
    },
    clearSteeringQueue() {
      return Promise.resolve();
    },
    getCurrentTurnId() {
      return null;
    },
    resolvePrompt() {
      pendingResolve?.();
    },
  };
  return runner;
}

describe("TurnDispatcher keepAlive", () => {
  it("registers the detached drain promise with keepAlive on submit", () => {
    const runner = createFakeRunner();
    const keepAlive = vi.fn<(p: Promise<unknown>) => void>();
    const dispatcher = new TurnDispatcher({
      runner,
      notifyTyping: vi.fn(),
      keepAlive,
    });

    dispatcher.submit("hello" as unknown as RunnerTurnInput);

    // The drain is started fire-and-forget; its promise must be handed to
    // keepAlive (ctx.waitUntil) so workerd does not cancel the cross-request
    // continuations once the originating request returns.
    expect(keepAlive).toHaveBeenCalledTimes(1);
    expect(keepAlive.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });

  it("does not throw when keepAlive is omitted", () => {
    const runner = createFakeRunner();
    const dispatcher = new TurnDispatcher({ runner, notifyTyping: vi.fn() });
    expect(() => dispatcher.submit("hello" as unknown as RunnerTurnInput)).not.toThrow();
  });

  it("registers a fresh drain promise per drain cycle", async () => {
    const runner = createFakeRunner();
    const keepAlive = vi.fn<(p: Promise<unknown>) => void>();
    const dispatcher = new TurnDispatcher({
      runner,
      notifyTyping: vi.fn(),
      keepAlive,
    });

    dispatcher.submit("first" as unknown as RunnerTurnInput);
    expect(keepAlive).toHaveBeenCalledTimes(1);

    // Settle the in-flight turn and let the drain loop fully wind down
    // (drain exits its while-loop and clears `draining` in the finally block).
    runner.resolvePrompt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A subsequent submit starts a new drain cycle → a new anchored promise.
    dispatcher.submit("second" as unknown as RunnerTurnInput);
    expect(keepAlive).toHaveBeenCalledTimes(2);
    expect(keepAlive.mock.calls[1]![0]).not.toBe(keepAlive.mock.calls[0]![0]);
  });
});
