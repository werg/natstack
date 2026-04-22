import { describe, it, expect, vi } from "vitest";

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

import {
  TurnDispatcher,
  type TurnDispatcherProjector,
  type TurnDispatcherRunner,
} from "./turn-dispatcher.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** Deferred Promise — lets tests drive runTurnMessage's resolution timing. */
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
  /** Active runTurnMessage calls in order. Each entry exposes the msg and a
   *  deferred that the test resolves/rejects to simulate pi-core completion. */
  runTurnCalls: Array<{
    msg: AgentMessage;
    deferred: ReturnType<typeof deferred<void>>;
  }>;
  continueCalls: Array<ReturnType<typeof deferred<void>>>;
  steerCalls: AgentMessage[];
  clearSteerCount: number;
  unsubscribed: boolean;
}

function makeRunner(): FakeRunnerState {
  let listener: ((event: AgentEvent) => void) | null = null;
  const state: FakeRunnerState = {
    runTurnCalls: [],
    continueCalls: [],
    steerCalls: [],
    clearSteerCount: 0,
    unsubscribed: false,
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
    runTurnMessage(msg) {
      const d = deferred<void>();
      state.runTurnCalls.push({ msg, deferred: d });
      return d.promise;
    },
    continueAgent() {
      const d = deferred<void>();
      state.continueCalls.push(d);
      return d.promise;
    },
    steerMessage(msg) {
      state.steerCalls.push(msg);
    },
    clearSteeringQueue() {
      state.clearSteerCount++;
    },
  };
  return state;
}

function makeProjector(): TurnDispatcherProjector & { closeAllCount: number } {
  const projector = {
    closeAllCount: 0,
    async closeAll() {
      projector.closeAllCount++;
    },
  };
  return projector;
}

function makeMsg(tag: string): AgentMessage {
  return {
    role: "user",
    content: tag,
    timestamp: Date.now(),
  } as AgentMessage;
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
  it("routes an idle submit to runTurnMessage with the exact AgentMessage", async () => {
    const runner = makeRunner();
    const projector = makeProjector();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector,
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
    const projector = makeProjector();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector,
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

  it("processes multiple idle submits serially", async () => {
    const runner = makeRunner();
    const projector = makeProjector();
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector,
      notifyTyping: () => {},
    });

    const a = makeMsg("a");
    const b = makeMsg("b");
    const c = makeMsg("c");
    d.submit(a);
    d.submit(b);
    d.submit(c);
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
  it("routes a submit during an active run to steerMessage", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
});

describe("TurnDispatcher — self-healing sweep", () => {
  it("sweeps a stranded steer into pending and runs it as a fresh turn", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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

  it("sweeps multiple stranded steers in order", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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
      projector: makeProjector(),
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
    const projector = makeProjector();
    const log = { warn: vi.fn(), error: vi.fn() };
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector,
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

    expect(projector.closeAllCount).toBe(1);
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
      projector: makeProjector(),
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

describe("TurnDispatcher — reset", () => {
  it("clears pending and pendingSteered, broadcasts typing off, clears pi queue", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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
      projector: makeProjector(),
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
});

describe("TurnDispatcher — dispose", () => {
  it("unsubscribes from the runner and ignores subsequent submits", async () => {
    const runner = makeRunner();
    const typing: boolean[] = [];
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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
      projector: makeProjector(),
      notifyTyping: () => {},
    });

    d.submit(makeMsg("a"));
    d.submit(makeMsg("b"));
    await flush();
    // drainLoop is now awaiting runTurnMessage(a); b is in pending.

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
      projector: makeProjector(),
      notifyTyping: () => { typingCalls++; },
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
      projector: makeProjector(),
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
});

describe("TurnDispatcher — race scenarios", () => {
  it("submit during the agent_end sweep goes to pending, not steer", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
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

    // Finish the first turn so drainLoop can pick up `mid` and `afterEnd`.
    runner.runTurnCalls[0]!.deferred.resolve();
    await flush();

    // `mid` is now in-flight as a fresh turn; finish it so drain picks afterEnd.
    expect(runner.runTurnCalls[1]!.msg).toBe(mid);
    emitRunLifecycle(runner, [mid]);
    runner.runTurnCalls[1]!.deferred.resolve();
    await flush();

    // Both the swept `mid` and the new `afterEnd` ran as fresh turns.
    expect(runner.runTurnCalls.slice(1).map((c) => c.msg)).toEqual([mid, afterEnd]);
    // `afterEnd` was NOT steered (it arrived post-agent_end).
    expect(runner.steerCalls).toEqual([mid]);
  });

  it("rapid-fire submits stay serialized (no concurrent runTurns)", async () => {
    const runner = makeRunner();
    const d = new TurnDispatcher({
      runner: runner.runner,
      projector: makeProjector(),
      notifyTyping: () => {},
    });

    for (let i = 0; i < 5; i++) d.submit(makeMsg(`m${i}`));
    await flush();

    expect(runner.runTurnCalls).toHaveLength(1);
  });
});
