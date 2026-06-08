import { describe, it, expect, vi } from "vitest";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { TurnSuspensionSignal } from "@workspace/harness";

import { TurnDispatcher, type TurnDispatcherRunner } from "./turn-dispatcher.js";
import type { RunnerTurnInput } from "@workspace/harness";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** Deferred Promise — lets tests drive prompt's resolution timing. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeRunnerState {
  runner: TurnDispatcherRunner;
  emit: (event: AgentEvent) => void;
  /** Active prompt calls in order. Each entry exposes the input and a
   *  deferred that the test resolves/rejects to simulate harness completion. */
  runTurnCalls: Array<{
    msg: AgentMessage & RunnerTurnInput;
    deferred: ReturnType<typeof deferred<void>>;
  }>;
  continueCalls: Array<ReturnType<typeof deferred<void>>>;
  steerCalls: Array<AgentMessage & RunnerTurnInput>;
  clearSteerCount: number;
  unsubscribed: boolean;
  /** The runner's "open turn" — drives steer-vs-fresh-prompt. Tests set it to
   *  simulate a parked/suspended (or hibernation-restored) open turn. */
  currentTurnId: string | null;
}

function makeRunner(): FakeRunnerState {
  let listener: ((event: AgentEvent) => void) | null = null;
  const state: FakeRunnerState = {
    runTurnCalls: [],
    continueCalls: [],
    steerCalls: [],
    clearSteerCount: 0,
    unsubscribed: false,
    currentTurnId: null,
    runner: null as unknown as TurnDispatcherRunner,
    emit: (event) => listener?.(event),
  };
  state.runner = {
    subscribe(fn) {
      listener = fn;
      return () => {
        state.unsubscribed = true;
        listener = null;
      };
    },
    buildUserMessage(input) {
      return input as AgentMessage;
    },
    prompt(msg) {
      const d = deferred<void>();
      state.runTurnCalls.push({ msg: msg as AgentMessage & RunnerTurnInput, deferred: d });
      return d.promise;
    },
    continueAgent() {
      const d = deferred<void>();
      state.continueCalls.push(d);
      return d.promise;
    },
    steerMessage(msg) {
      state.steerCalls.push(msg as AgentMessage & RunnerTurnInput);
      return Promise.resolve();
    },
    clearSteeringQueue() {
      state.clearSteerCount++;
      return Promise.resolve();
    },
    getCurrentTurnId() {
      return state.currentTurnId;
    },
  };
  return state;
}

function makeMsg(tag: string): AgentMessage & RunnerTurnInput {
  return {
    role: "user",
    content: tag,
    timestamp: Date.now(),
  } as AgentMessage & RunnerTurnInput;
}

function agentStart(): AgentEvent {
  return { type: "agent_start" } as AgentEvent;
}

function agentEnd(): AgentEvent {
  return { type: "agent_end", messages: [] } as unknown as AgentEvent;
}

function messageStart(msg: AgentMessage): AgentEvent {
  return { type: "message_start", message: msg } as unknown as AgentEvent;
}

/** Happy-path finish: message_start(for msg), agent_end. Simulates what
 *  pi-core would emit when it processes a queued user message. */
function emitRunLifecycle(state: FakeRunnerState, absorbed: AgentMessage[]): void {
  state.emit(agentStart());
  for (const m of absorbed) state.emit(messageStart(m));
  state.emit(agentEnd());
}

/** Wait for all pending microtasks to drain. */
async function flush(): Promise<void> {
  // Two ticks covers: await microtask → drainLoop's while check → next microtask.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TurnDispatcher — idle submission", () => {
  it("routes an idle submit to prompt with the exact RunnerTurnInput", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    const msg = makeMsg("hello");
    d.submit(msg);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.runTurnCalls[0]!.msg).toBe(msg);
    expect(runner.steerCalls).toHaveLength(0);
    expect(typing).toEqual([true]);
  });

  it("broadcasts typing false after the turn ends and queue drains", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    const msg = makeMsg("hi");
    d.submit(msg);
    await flush();

    // Simulate pi-core's run lifecycle.
    emitRunLifecycle(runner, [msg]);
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(typing).toEqual([true, false]);
  });

  it("steers auto submits that arrive behind a queued prompt before it starts", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const a = makeMsg("a");
    const b = makeMsg("b");
    const c = makeMsg("c");
    d.submit(a);
    d.submit(b);
    d.submit(c);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.runTurnCalls[0]!.msg).toBe(a);
    expect(runner.steerCalls).toEqual([b, c]);
  });

  it("processes multiple explicit sequential submits serially", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const a = makeMsg("a");
    const b = makeMsg("b");
    const c = makeMsg("c");
    d.submit(a, { mode: "sequential" });
    d.submit(b, { mode: "sequential" });
    d.submit(c, { mode: "sequential" });
    await flush();

    // Only one runTurn in flight.
    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.runTurnCalls[0]!.msg).toBe(a);

    emitRunLifecycle(runner, [a]);
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(b);

    emitRunLifecycle(runner, [b]);
    runner.runTurnCalls[1]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(3);
    expect(runner.runTurnCalls[2]!.msg).toBe(c);
  });
});

describe("TurnDispatcher — mid-run steer", () => {
  it("routes a submit during an active run to steer", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const followup = makeMsg("followup");
    d.submit(followup);

    expect(runner.steerCalls).toEqual([followup]);
    expect(runner.runTurnCalls).toHaveLength(1); // no second runTurn
  });

  it("does not broadcast typing again when steering (already busy)", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    d.submit(makeMsg("a"));
    await flush();
    runner.emit(agentStart());
    d.submit(makeMsg("b"));

    // Only the initial true; no duplicate true.
    expect(typing).toEqual([true]);
  });

  it("removes an absorbed steer from pendingSteered on message_start", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const steered = makeMsg("steered");
    d.submit(steered);

    // Pi picks it up — emits message_start with our exact reference.
    runner.emit(messageStart(steered));
    runner.emit(messageStart(first));
    runner.emit(agentEnd());

    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // Sweep should NOT have re-routed the absorbed steer.
    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.clearSteerCount).toBe(0);
  });

  it("reports durable steers as observed when the runner consumes them", async () => {
    const runner = makeRunner();
    const observed = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      onSteeredMessageObserved: observed,
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const steered = makeMsg("durable");
    d.steerIntoActiveTurn(steered, { steeringId: "steer-1" });
    runner.emit(messageStart(steered));
    await flush();

    expect(observed).toHaveBeenCalledWith("steer-1");
  });

  it("reports a durable steer as observed only after fallback prompt admission", async () => {
    const runner = makeRunner();
    const observed = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      onSteeredMessageObserved: observed,
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const steered = makeMsg("durable-fallback");
    d.steerIntoActiveTurn(steered, { steeringId: "steer-fallback" });

    runner.emit(messageStart(first));
    runner.emit(agentEnd());
    await flush();

    expect(observed).not.toHaveBeenCalled();
    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(steered);

    runner.emit(agentStart());
    runner.emit(messageStart(steered));
    await flush();

    expect(observed).toHaveBeenCalledWith("steer-fallback");
  });

  it("reports a durable fresh prompt as observed when the prompt message starts", async () => {
    const runner = makeRunner();
    const observed = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      onSteeredMessageObserved: observed,
    });

    const replayed = makeMsg("replayed");
    d.submit(replayed, { mode: "sequential", steeringId: "steer-replayed" });
    await flush();

    runner.emit(agentStart());
    runner.emit(messageStart(replayed));
    await flush();

    expect(observed).toHaveBeenCalledWith("steer-replayed");
  });

  it("ignores duplicate durable steering ids already queued in memory", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("first"), { mode: "sequential", steeringId: "same-steer" });
    d.submit(makeMsg("duplicate"), { mode: "sequential", steeringId: "same-steer" });
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.runTurnCalls[0]!.msg.content).toBe("first");
  });

  it("does not treat a different user message with the same text as the absorbed steer", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const steered = makeMsg("duplicate");
    d.submit(steered);

    runner.emit(messageStart(makeMsg("duplicate")));
    runner.emit(messageStart(first));
    runner.emit(agentEnd());
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(steered);
    expect(runner.clearSteerCount).toBe(1);
  });
});

describe("TurnDispatcher — self-healing sweep", () => {
  it("continues after agent_end even when the runner promise never settles", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    const second = makeMsg("second");
    d.submit(first);
    d.submit(second);
    await flush();

    emitRunLifecycle(runner, [first]);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(second);
  });

  it("sweeps a stranded steer into pending and runs it as a fresh turn", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const stranded = makeMsg("stranded");
    d.submit(stranded);

    // Pi finishes without ever emitting message_start for `stranded`.
    runner.emit(messageStart(first));
    runner.emit(agentEnd());
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // Sweep re-ran it as a fresh turn.
    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(stranded);
    // Pi-core's internal steering queue was cleared so it can't double-
    // ingest the same message on the next line-80 drain.
    expect(runner.clearSteerCount).toBe(1);
    // Typing stayed on the whole time — no flicker between turns.
    expect(typing.filter((b) => !b)).toHaveLength(0);
  });

  it("sweeps stranded steers after agent_end even when the runner promise never settles", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const stranded = makeMsg("stranded");
    d.submit(stranded);

    runner.emit(messageStart(first));
    runner.emit(agentEnd());
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(stranded);
    expect(runner.clearSteerCount).toBe(1);
  });

  it("sweeps multiple stranded steers in order", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const a = makeMsg("a");
    const b = makeMsg("b");
    d.submit(a);
    d.submit(b);

    // Only `first` absorbed; both steers stranded.
    runner.emit(messageStart(first));
    runner.emit(agentEnd());
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls[1]!.msg).toBe(a);
    // Now run b's turn.
    emitRunLifecycle(runner, [a]);
    runner.runTurnCalls[1]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(3);
    expect(runner.runTurnCalls[2]!.msg).toBe(b);
  });

  it("partial absorption: absorbed steer stays absorbed, stranded one swept", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    const absorbed = makeMsg("absorbed");
    const stranded = makeMsg("stranded");
    d.submit(absorbed);
    d.submit(stranded);

    runner.emit(messageStart(first));
    runner.emit(messageStart(absorbed));
    runner.emit(agentEnd());
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(stranded);
    // Absorbed one is NOT re-run.
  });
});

describe("TurnDispatcher — runTurn failure", () => {
  it("continues draining the queue after a runTurn rejects (steered msg swept)", async () => {
    const runner = makeRunner();
    const log = { warn: vi.fn(), error: vi.fn() };
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      log,
    });

    const a = makeMsg("fails");
    const b = makeMsg("steered-into-failing-run");
    d.submit(a);
    await flush();
    // Once `a` started, drainLoop flipped running=true pre-await, so `b`
    // routes to steer — into the run that's about to fail.
    runner.emit(agentStart());
    d.submit(b);

    // First turn rejects without pi-core ever emitting agent_end. Our catch
    // block's defensive sweep should re-route the stranded steer.
    runner.runTurnCalls[0]!.deferred.reject(new Error("boom"));
    await flush();
    await flush();
    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(b);
    expect(runner.clearSteerCount).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("broadcasts typing off if the queue is empty after a failure", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const log = { warn: vi.fn(), error: vi.fn() };
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
      log,
    });

    d.submit(makeMsg("fails"));
    await flush();
    runner.runTurnCalls[0]!.deferred.reject(new Error("boom"));
    await flush();

    expect(typing).toEqual([true, false]);
  });
});

describe("TurnDispatcher — external aborts", () => {
  it("turns typing off and allows continue after an intentional dispatch abort", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    d.submit(makeMsg("dispatches a participant method"));
    await flush();
    expect(runner.runTurnCalls).toHaveLength(1);

    d.markCurrentTurnAborted();
    expect(typing).toEqual([true, false]);

    d.submitContinue();
    await flush();

    expect(runner.continueCalls).toHaveLength(1);
    expect(typing).toEqual([true, false, true]);
  });

  it("clears active debug state on abort even if the runner promise never settles", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("dispatches a participant method"));
    await flush();
    expect(d.getDebugState()["activeWork"]).toMatchObject({ kind: "prompt" });

    d.markCurrentTurnAborted();

    expect(d.getDebugState()).toMatchObject({
      activeWork: null,
      running: false,
      draining: false,
      busy: false,
    });
  });

  it("ignores a stale prompt resolution after a replacement drain starts", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("first"));
    await flush();
    d.markCurrentTurnAborted();
    d.submitContinue();
    await flush();

    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.continueCalls).toHaveLength(1);
  });

  it("reports an invariant when continuation completes without runner lifecycle events", async () => {
    const runner = makeRunner();
    const log = { warn: vi.fn(), error: vi.fn() };
    const onInvariantViolation = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      onInvariantViolation,
      log,
    });

    d.submitContinue();
    await flush();
    runner.continueCalls[0]!.resolve();
    await flush();

    expect(onInvariantViolation).toHaveBeenCalledWith("runner_completed_without_agent_start", {
      workKind: "continue",
      turnId: null,
    });
  });
});

describe("TurnDispatcher — reset", () => {
  it("clears pending and pendingSteered, broadcasts typing off, clears pi queue", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());
    d.submit(makeMsg("steered"));

    typing.length = 0;
    d.reset();

    expect(runner.clearSteerCount).toBe(1);
    expect(typing).toEqual([false]);
  });

  it("after reset, a subsequent agent_end doesn't re-run cleared steers", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("first"));
    await flush();
    runner.emit(agentStart());
    d.submit(makeMsg("wipe me"));

    d.reset();

    runner.emit(agentEnd());
    // Resolve the outstanding runTurn so drainLoop can exit.
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1); // no re-run
  });

  it("recovers deterministically after reset when the old runner promise never settles", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const wedged = makeMsg("wedged");
    d.submit(wedged);
    await flush();
    expect(runner.runTurnCalls[0]!.msg).toBe(wedged);

    d.reset();
    expect(d.getDebugState()).toMatchObject({
      activeWork: null,
      running: false,
      draining: false,
      busy: false,
    });

    const next = makeMsg("next");
    d.submit(next);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(next);
  });

  it("ignores an agent_end from before reset if the replacement work has not started", async () => {
    const runner = makeRunner();
    const log = { warn: vi.fn(), error: vi.fn() };
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      log,
    });

    d.submit(makeMsg("old"));
    await flush();
    d.reset();

    const next = makeMsg("next");
    d.submit(next);
    await flush();
    runner.emit(agentEnd());
    await flush();

    expect(d.getDebugState()).toMatchObject({
      activeWork: {
        kind: "prompt",
        sawAgentStart: false,
        sawAgentEnd: false,
      },
      running: true,
      draining: true,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[TurnDispatcher] invariant violation: runner_lifecycle_agent_end_before_agent_start",
      { activeTurnId: null }
    );
  });
});

describe("TurnDispatcher — dispose", () => {
  it("unsubscribes from the runner and ignores subsequent submits", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    d.dispose();
    expect(runner.unsubscribed).toBe(true);

    d.submit(makeMsg("ignored"));
    await flush();
    expect(runner.runTurnCalls).toHaveLength(0);
    expect(runner.steerCalls).toHaveLength(0);
  });

  it("exits cleanly when dispose fires while drainLoop is awaiting", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("a"));
    d.submit(makeMsg("b"));
    await flush();
    // drainLoop is now awaiting prompt(a); b is in pending.

    d.dispose();
    // Pretend pi-core eventually finishes (post-dispose). drainLoop's
    // while check sees `disposed=true` and exits without running b.
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
  });

  it("is idempotent — second dispose is a no-op", async () => {
    const runner = makeRunner();
    let typingCalls = 0;
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {
        typingCalls++;
      },
    });

    d.submit(makeMsg("x"));
    await flush();
    const callsBeforeDispose = typingCalls;

    d.dispose();
    const callsAfterFirstDispose = typingCalls;
    d.dispose();
    const callsAfterSecondDispose = typingCalls;

    // First dispose broadcasts typing off (busy was true); second must not
    // broadcast again (busy already false, no transition).
    expect(callsAfterFirstDispose).toBe(callsBeforeDispose + 1);
    expect(callsAfterSecondDispose).toBe(callsAfterFirstDispose);
  });
});

describe("TurnDispatcher — reset edge paths", () => {
  it("reset called twice in succession does not double-clear pi's steering queue unnecessarily", () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.reset();
    d.reset();
    // Each reset calls clearSteeringQueue unconditionally — that's fine,
    // the operation is idempotent, but this test documents the behavior.
    expect(runner.clearSteerCount).toBe(2);
  });

  it("dispose after reset leaves state stable", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    d.submit(makeMsg("x"));
    await flush();
    d.reset();
    d.dispose();

    // reset broadcasts typing=false (transition). dispose sees busy already
    // false → no second broadcast.
    expect(typing).toEqual([true, false]);
    expect(runner.unsubscribed).toBe(true);
  });
});

describe("TurnDispatcher — sequential mode", () => {
  it("sequential submit during an active run goes to pending, not steer", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    d.submit(makeMsg("first"));
    await flush();
    // first is mid-run; normally a follow-up would steer.

    const replayMsg = makeMsg("replayed");
    d.submit(replayMsg, { mode: "sequential" });

    expect(runner.steerCalls).toHaveLength(0);
    // `replayMsg` is now in pending, waiting for first to finish.

    emitRunLifecycle(runner, [runner.runTurnCalls[0]!.msg]);
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.runTurnCalls[1]!.msg).toBe(replayMsg);
  });

  it("a burst of sequential submits runs as independent fresh turns", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    // Simulate replay: three queued events processed in sequence, each
    // with mode=sequential. None should collapse into steering.
    const msgs = [makeMsg("r1"), makeMsg("r2"), makeMsg("r3")];
    for (const m of msgs) d.submit(m, { mode: "sequential" });
    await flush();

    for (let i = 0; i < 3; i++) {
      expect(runner.runTurnCalls[i]!.msg).toBe(msgs[i]);
      emitRunLifecycle(runner, [msgs[i]!]);
      runner.runTurnCalls[i]!.deferred.resolve();
      await flush();
    }

    expect(runner.steerCalls).toHaveLength(0);
    expect(runner.runTurnCalls).toHaveLength(3);
  });
});

describe("TurnDispatcher — typing transitions", () => {
  it("emits only on state changes, never duplicate", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
    });

    // 3 idle submits — only one true broadcast.
    const a = makeMsg("a");
    const b = makeMsg("b");
    const c = makeMsg("c");
    d.submit(a);
    d.submit(b);
    d.submit(c);
    await flush();

    expect(typing).toEqual([true]);

    // Finish all three; only one false at the end.
    for (let i = 0; i < 3; i++) {
      runner.emit(agentStart());
      runner.emit(messageStart([a, b, c][i]!));
      runner.emit(agentEnd());
      runner.runTurnCalls[i]!.deferred.resolve();
      await flush();
    }

    expect(typing).toEqual([true, false]);
  });

  it("notifyTyping throwing does not break the state machine", async () => {
    const runner = makeRunner();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const typing: boolean[] = [];
    let throwNext = false;
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => {
        typing.push(busy);
        if (throwNext) throw new Error("notify boom");
      },
    });

    throwNext = true;
    d.submit(makeMsg("x"));
    await flush();

    // The submit still reached the runner despite the thrown notify.
    expect(runner.runTurnCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it("clears typing and reports runner prompt failure", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const failures: Array<{ kind: string; message: string; turnId?: string }> = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: (busy) => typing.push(busy),
      onWorkStart: async () => "turn-failed",
      onWorkFailure: async (work, error, turnId) => {
        failures.push({
          kind: work.kind,
          message: error instanceof Error ? error.message : String(error),
          turnId,
        });
      },
    });

    d.submit(makeMsg("fails"));
    await flush();
    runner.runTurnCalls[0]!.deferred.reject(new Error("eval result persistence failed"));
    await flush();
    await flush();
    expect(typing).toEqual([true, false]);
    expect(failures).toEqual([
      { kind: "prompt", message: "eval result persistence failed", turnId: "turn-failed" },
    ]);
    expect(d.getDebugState()).toMatchObject({ busy: false, running: false });
  });
});

describe("TurnDispatcher — race scenarios", () => {
  it("submit during the agent_end sweep goes to pending, not steer", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    const first = makeMsg("first");
    d.submit(first);
    await flush();
    runner.emit(agentStart());

    // We steer `mid` but pi will strand it.
    const mid = makeMsg("mid");
    d.submit(mid);

    // Simulate agent_end WITHOUT message_start for mid. Our handler runs
    // synchronously during emit: sweeps mid into pending, flips running
    // to false, kicks drain.
    runner.emit(messageStart(first));
    runner.emit(agentEnd());

    // Now — synchronously, before drainLoop's microtask runs — a new
    // submit arrives. `running` is already false post-sweep.
    const afterEnd = makeMsg("afterEnd");
    d.submit(afterEnd);

    // Finish the first turn so drainLoop can pick up `mid`.
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // `mid` is now in-flight as a fresh turn. The later `afterEnd` submit was
    // steered behind it, so pi-core consumes it during this run rather than
    // letting it become a competing third prompt.
    expect(runner.runTurnCalls[1]!.msg).toBe(mid);
    emitRunLifecycle(runner, [mid, afterEnd]);
    runner.runTurnCalls[1]!.deferred.resolve();
    await flush();

    expect(runner.runTurnCalls.slice(1).map((c) => c.msg)).toEqual([mid]);
    expect(runner.steerCalls).toEqual([mid, afterEnd]);
  });

  it("rapid-fire submits stay serialized (no concurrent runTurns)", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
    });

    for (let i = 0; i < 5; i++) d.submit(makeMsg(`m${i}`));
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
  });
});

describe("TurnDispatcher — interrupt gating", () => {
  it("drops auto-continuations after an interrupt so a stopped agent stays stopped", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    // User pressed stop. A suspension result / recovery pass that resolves
    // afterwards must NOT restart the agent loop.
    d.interrupt();
    d.submitContinue({ turnId: "turn-1" });
    await flush();

    expect(runner.continueCalls).toHaveLength(0);
    expect(runner.runTurnCalls).toHaveLength(0);
  });

  it("re-engages on the next user message and resumes normal continues", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    d.interrupt();
    d.submitContinue({ turnId: "stale" });
    await flush();
    expect(runner.continueCalls).toHaveLength(0);

    // A fresh user message clears the interrupt gate and runs.
    const msg = makeMsg("continue please");
    d.submit(msg);
    await flush();
    expect(runner.runTurnCalls).toHaveLength(1);

    // Finish the turn; a subsequent continue now flows normally again.
    emitRunLifecycle(runner, [msg]);
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    d.submitContinue({ turnId: "turn-2" });
    await flush();
    expect(runner.continueCalls).toHaveLength(1);
  });
});

describe("TurnDispatcher — open (parked/suspended) turn steering", () => {
  it("keeps steered input attached to a turn that parks during the same run", async () => {
    const runner = makeRunner();
    const warn = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      log: { warn, error: vi.fn() },
    });

    const first = makeMsg("onboard me");
    d.submit(first);
    await flush();
    expect(runner.runTurnCalls).toHaveLength(1);

    runner.emit(agentStart());
    runner.currentTurnId = "turn-parked";
    const second = makeMsg("also read the skill");
    d.submit(second);
    await flush();
    expect(runner.steerCalls).toHaveLength(1);

    runner.emit(agentEnd());
    runner.runTurnCalls[0]!.deferred.reject(
      new TurnSuspensionSignal({
        reason: "credential",
        message: "Waiting for model credential approval",
      })
    );
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.clearSteerCount).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("prompt failed"),
      expect.anything()
    );
  });

  it("treats a suspension rejection without agent_end as a parked turn, not a work failure", async () => {
    const runner = makeRunner();
    const warn = vi.fn();
    const onWorkFailure = vi.fn();
    const d = new TurnDispatcher({
      runner: runner.runner,
      notifyTyping: () => {},
      onWorkFailure,
      log: { warn, error: vi.fn() },
    });

    const first = makeMsg("onboard me");
    d.submit(first);
    await flush();
    runner.currentTurnId = "turn-parked";
    runner.runTurnCalls[0]!.deferred.reject(
      new TurnSuspensionSignal({
        reason: "credential",
        message: "Waiting for model credential approval",
      })
    );
    await flush();

    expect(onWorkFailure).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("prompt failed"),
      expect.anything()
    );
  });

  it("converts an already queued prompt into a steer when the prior turn parks open", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    const first = makeMsg("first startup prompt");
    const second = makeMsg("second startup prompt");
    d.submit(first, { mode: "sequential" });
    d.submit(second, { mode: "sequential" });
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.runTurnCalls[0]!.msg).toBe(first);

    runner.currentTurnId = "turn-parked";
    runner.runTurnCalls[0]!.deferred.reject(
      new TurnSuspensionSignal({
        reason: "credential",
        message: "Waiting for model credential approval",
      })
    );
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
    expect(runner.steerCalls).toEqual([second]);
  });

  it("steers a concurrent message into an open turn instead of starting a fresh prompt", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    // Turn parks at model-init (e.g. deferred credential approval): the work
    // item RESOLVES (the model error is captured as the assistant message) but
    // the turn stays OPEN in the runner — getCurrentTurnId() reports it.
    const first = makeMsg("onboard me");
    d.submit(first);
    await flush();
    expect(runner.runTurnCalls).toHaveLength(1);
    emitRunLifecycle(runner, [first]);
    runner.currentTurnId = "turn-parked"; // runner still holds the open turn
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // A second message must NOT open a competing turn (which would collide on
    // adoptTurnId) — it steers into the open turn.
    const second = makeMsg("also read the skill");
    d.submit(second);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1); // no fresh prompt
    expect(runner.steerCalls).toHaveLength(1);
    expect(runner.steerCalls[0]!.content).toBe("also read the skill");
  });

  it("steers into a hibernation-restored open turn even on a fresh dispatcher (P0-2)", async () => {
    // After hibernation, a brand-new dispatcher is created whose runner has
    // restored its open turn from durable trajectory. There is no in-memory park
    // flag to rely on — the steer decision comes purely from getCurrentTurnId().
    const runner = makeRunner();
    runner.currentTurnId = "turn-restored";
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    const msg = makeMsg("second onboarding message");
    d.submit(msg);
    await flush();

    expect(runner.runTurnCalls).toHaveLength(0); // never a colliding fresh prompt
    expect(runner.steerCalls).toHaveLength(1);
    expect(runner.steerCalls[0]!.content).toBe("second onboarding message");
  });

  it("resumes the open turn via submitContinue; once it closes, new input is a fresh prompt", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({ runner: runner.runner, notifyTyping: () => {} });

    const first = makeMsg("onboard me");
    d.submit(first);
    await flush();
    emitRunLifecycle(runner, [first]);
    runner.currentTurnId = "turn-parked";
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // Credential approved → resume continues the same open turn.
    d.submitContinue({ turnId: "turn-parked" });
    await flush();
    expect(runner.continueCalls).toHaveLength(1);

    // The resumed turn finishes and the runner closes it (currentTurnId → null);
    // a later idle submit is a fresh prompt again (not a steer).
    emitRunLifecycle(runner, []);
    runner.continueCalls[0]!.resolve();
    runner.currentTurnId = null;
    await flush();

    const next = makeMsg("new request");
    d.submit(next);
    await flush();
    expect(runner.runTurnCalls).toHaveLength(2);
    expect(runner.steerCalls).toHaveLength(0);
  });
});
