/**
 * chatOp — the agent-side proxy for an EvalDO sandbox `chat` binding.
 *
 * Server-side `eval` runs in a per-channel EvalDO that has no channel identity,
 * so its `chat` binding forwards every op here via
 * `rpc.callTarget(agentId, "chatOp", [channelId, op, args])`. The agent performs
 * the op AS itself (correct @agent attribution) using its own channel
 * machinery, and relays the result. These tests cover the auth gate, the card
 * dispatch, message-type publishing, and the result-awaiting callMethod relay.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { ids } from "@workspace/agent-loop";
import type { DeferrableRpcClient } from "@natstack/rpc";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  sha256Hex,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import type { ChannelEvent, ParticipantDescriptor } from "@workspace/harness";
import { AgentVesselBase } from "./agent-vessel.js";
import type { ChannelClient } from "./channel-client.js";
import type { AgentLoopDriver } from "./agent-loop-driver.js";

/** Wait until the relay has issued its channel call (auth uses an async sha256,
 *  so the call is enqueued a few microtasks after chatOp is invoked). */
async function waitForCall(vessel: TestVessel): Promise<{ callId: string; method: string }> {
  for (let i = 0; i < 100; i++) {
    const call = vessel.channelStub.calls[0];
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("relay never issued a channel call");
}

const AGENT_ID = "do:test:TestAgent:agent-key";
const CHANNEL = "chan-1";

const WEATHER_TYPE = {
  typeId: "weather",
  displayMode: "row" as const,
  stateSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** A test vessel that lets us drive chatOp directly: it pins the agent's
 *  participant id, lets the test set the verified caller id, and swaps the
 *  ChannelClient for an in-memory stub whose callMethod we settle by feeding a
 *  terminal back through processChannelEvent (mirroring the live broadcast). */
class TestVessel extends AgentVesselBase {
  callerIdForTest: string | null = null;
  callerKindForTest: string | null = null;
  readonly channelStub = {
    published: [] as Array<{ event: AgenticEvent; idempotencyKey?: string }>,
    messageTypes: new Map<string, Record<string, unknown>>(),
    calls: [] as Array<{ callId: string; targetPid: string; method: string; args: unknown }>,
    participants: [] as Array<{ participantId: string; metadata: Record<string, unknown> }>,
  };

  protected override get rpcCallerId(): string | null {
    return this.callerIdForTest;
  }

  protected override get rpcCallerKind(): string | null {
    return this.callerKindForTest;
  }

  protected override participantId(): string {
    return AGENT_ID;
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return { type: "agent", name: "TestAgent", handle: "testagent" } as ParticipantDescriptor;
  }

  protected override createChannelClient(_channelId: string): ChannelClient {
    return this.makeChannelStub() as unknown as ChannelClient;
  }

  /** Register a subscription row (so getParticipantId returns a non-null
   *  participant id for the card publish path) WITHOUT running the heavy
   *  post-subscribe machinery (prompt artifacts, driver wake) that needs a live
   *  gateway/GAD. */
  async registerSubscriptionForTest(): Promise<void> {
    await this.subscriptions.subscribe({
      channelId: CHANNEL,
      contextId: "ctx-1",
      descriptor: this.getParticipantInfo(),
      replay: false,
    });
  }

  private makeChannelStub() {
    const stub = this.channelStub;
    return {
      publishAgenticEvent: vi.fn(
        async (_pid: string, event: AgenticEvent, opts?: { idempotencyKey?: string }) => {
          stub.published.push({ event, idempotencyKey: opts?.idempotencyKey });
          return { id: stub.published.length };
        }
      ),
      getMessageType: vi.fn(async (typeId: string) => stub.messageTypes.get(typeId) ?? null),
      getMessageTypes: vi.fn(async () => [...stub.messageTypes.values()]),
      getParticipants: vi.fn(async () => stub.participants),
      callMethod: vi.fn(
        async (
          _callerPid: string,
          targetPid: string,
          callId: string,
          method: string,
          args: unknown
        ) => {
          stub.calls.push({ callId, targetPid, method, args });
        }
      ),
      send: vi.fn(async () => undefined),
      subscribe: vi.fn(async (participantId: string) => ({
        ok: true,
        channelConfig: {},
        envelope: { logEvents: [], ready: { totalCount: 0 } },
        participantId,
      })),
      unsubscribe: vi.fn(async () => undefined),
      getConfig: vi.fn(async () => ({})),
    };
  }

  /** Feed a terminal event the way the live channel broadcast would, to settle
   *  a pending relay call. */
  async deliverTerminal(
    transportCallId: string,
    kind:
      | "invocation.completed"
      | "invocation.failed"
      | "invocation.cancelled"
      | "invocation.abandoned",
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: ChannelEvent = {
      id: 1,
      messageId: transportCallId,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind,
        actor: { kind: "agent", id: AGENT_ID },
        causality: { invocationId: transportCallId, transportCallId },
        payload,
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: AGENT_ID,
      ts: Date.now(),
    };
    await this.processChannelEvent(CHANNEL, event);
  }
}

class PromptEventProbe extends TestVessel {
  readonly handleIncomingSpy = vi.fn(async (_channelId: string, _incoming: unknown) => {});

  protected override async shouldRespond(): Promise<boolean> {
    return true;
  }

  protected override async ensurePromptArtifacts(): Promise<void> {}

  protected override get driver(): AgentLoopDriver {
    return {
      handleIncoming: this.handleIncomingSpy,
    } as unknown as AgentLoopDriver;
  }

  markEmptyRosterFresh(channelId: string): void {
    this.setStateValue(`agent:roster:${channelId}`, "[]");
  }
}

async function makeVessel(): Promise<TestVessel> {
  const { instance } = await createTestDO(TestVessel, { __objectKey: "agent-key" });
  // Register a subscription row so the card path has a participant id, without
  // booting the driver/prompt machinery.
  await instance.registerSubscriptionForTest();
  return instance;
}

async function makePromptProbe(): Promise<PromptEventProbe> {
  const { instance } = await createTestDO(PromptEventProbe, { __objectKey: "agent-key" });
  await instance.registerSubscriptionForTest();
  instance.markEmptyRosterFresh(CHANNEL);
  return instance;
}

/** The EvalDO objectKey the eval service derives, and the caller id chatOp
 *  expects: sha256(`${agentRuntimeId}\0${channelId}`) hex, first 40. */
async function expectedEvalCaller(): Promise<string> {
  const key = (await sha256Hex(`${AGENT_ID}\0${CHANNEL}`)).slice(0, 40);
  return `do:natstack/internal:EvalDO:${key}`;
}

describe("AgentVesselBase.chatOp", () => {
  it("rejects a caller that is not this agent's own EvalDO", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:natstack/internal:EvalDO:someoneelse";
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(
      /only this agent's own EvalDO/
    );
  });

  it("rejects when there is no verified caller", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = null;
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(/refusing caller/);
  });

  it("accepts the agent's own EvalDO (key matches the eval service formula)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const types = await vessel.chatOp(CHANNEL, "getMessageTypes", []);
    expect(Array.isArray(types)).toBe(true);
    expect((types as unknown[]).length).toBe(1);
  });

  it("configureAgent + describeSelf expose per-agent config to the eval `agent` binding", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    const updated = (await vessel.chatOp(CHANNEL, "configureAgent", [
      { model: "openai:gpt-5.3", thinkingLevel: "high" },
    ])) as { model: string; thinkingLevel: string };
    expect(updated.model).toBe("openai:gpt-5.3");
    expect(updated.thinkingLevel).toBe("high");

    const snapshot = (await vessel.chatOp(CHANNEL, "describeSelf", [])) as {
      identity: { id: string };
      config: { model: string };
      channels: Array<{ channelId: string }>;
    };
    expect(snapshot.identity.id).toBe(AGENT_ID);
    // Per-agent: the model set above is what describeSelf reports.
    expect(snapshot.config.model).toBe("openai:gpt-5.3");
    expect(snapshot.channels.some((c) => c.channelId === CHANNEL)).toBe(true);
  });

  it("configureAgent validates its patch (rejects an empty model)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(vessel.chatOp(CHANNEL, "configureAgent", [{ model: "" }])).rejects.toThrow(/model/);
  });

  it("registerMessageType publishes messageType.registered AS the agent", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.chatOp(CHANNEL, "registerMessageType", [
      {
        typeId: "weather",
        displayMode: "row",
        source: { type: "file", path: "renderers/weather.tsx" },
        stateSchema: WEATHER_TYPE.stateSchema,
      },
    ]);
    const published = vessel.channelStub.published;
    expect(published).toHaveLength(1);
    expect(published[0]!.event.kind).toBe("messageType.registered");
    expect(published[0]!.event.actor.kind).toBe("agent");
    expect(published[0]!.event.actor.id).toBe(AGENT_ID);
  });

  it("publishCustomMessage routes through the card manager and returns { messageId, pubsubId }", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const result = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string; pubsubId: number | undefined };
    expect(typeof result.messageId).toBe("string");
    // The stub returns { id: published.length }; the first publish is id 1, and
    // the handle must surface it (harmonized with the panel client).
    expect(result.pubsubId).toBe(1);
    const started = vessel.channelStub.published.find((p) => p.event.kind === "custom.started");
    expect(started).toBeDefined();
    expect(started!.event.actor.kind).toBe("agent");
  });

  it("updateCustomMessage publishes custom.updated AS the agent and returns its pubsubId", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const created = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string };
    const pubsubId = await vessel.chatOp(CHANNEL, "updateCustomMessage", [
      created.messageId,
      { city: "Paris" },
    ]);
    // Second publish on this channel → stub id 2.
    expect(pubsubId).toBe(2);
    const updated = vessel.channelStub.published.find((p) => p.event.kind === "custom.updated");
    expect(updated).toBeDefined();
    expect(updated!.event.actor.kind).toBe("agent");
  });

  it("focusMessage is panel-only and resolves false", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(vessel.chatOp(CHANNEL, "focusMessage", ["msg-1"])).resolves.toBe(false);
  });

  it("callMethod initiates a channel call and resolves with the delivered content", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", ["panel-pid", "doThing", { x: 1 }]);
    const call = await waitForCall(vessel);
    expect(call.method).toBe("doThing");
    await vessel.deliverTerminal(call.callId, "invocation.completed", { result: { ok: 42 } });
    await expect(promise).resolves.toEqual({ ok: 42 });
  });

  it("callMethodResult resolves with the full ChatMethodResult envelope", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethodResult", ["panel-pid", "doThing", {}]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.completed", { result: "hello" });
    await expect(promise).resolves.toEqual({ content: "hello" });
  });

  it("callMethod rejects when the channel terminal is an error", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", ["panel-pid", "boom", {}]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.failed", { error: "kaboom" });
    await expect(promise).rejects.toThrow(/kaboom/);
  });
});

describe("AgentVesselBase.processChannelEvent", () => {
  it("forwards message metadata into the loop command", async () => {
    const vessel = await makePromptProbe();
    const event: ChannelEvent = {
      id: 1,
      messageId: "env-after-turn",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        actor: { kind: "user", id: "panel:user", participantId: "panel:user" },
        causality: { messageId: "msg-after-turn" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ type: "text", content: "next please" }],
          outcome: "completed",
          metadata: { deliverAfterTurn: true },
        },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "panel:user",
      ts: Date.now(),
    };

    await vessel.processChannelEvent(CHANNEL, event);

    expect(vessel.handleIncomingSpy).toHaveBeenCalledTimes(1);
    expect(vessel.handleIncomingSpy.mock.calls[0]?.[1]).toMatchObject({
      type: "command",
      command: {
        kind: "prompt",
        source: { envelopeId: "env-after-turn" },
        sourceMessageId: "msg-after-turn",
        metadata: { deliverAfterTurn: true },
      },
    });
  });
});

describe("AgentVesselBase.onEvalComplete (deferred-eval resume)", () => {
  /** Replace the lazily-built driver with a spy so we can assert the delivered outcome. */
  function stubDriver(vessel: TestVessel): ReturnType<typeof vi.fn> {
    const deliverSpy = vi.fn(async () => {});
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: deliverSpy,
      connectSpecProvider: undefined, // the driver getter sets this each access
    };
    return deliverSpy;
  }

  it("delivers the formatted result to the parked invocation effect (runId IS the invocationId)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";

    await vessel.onEvalComplete({
      runId: "inv-77",
      result: { success: true, console: "out", returnValue: 7, scopeKeys: ["a"] },
      channelId: CHANNEL,
    });

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [effectId, outcome, address] = deliverSpy.mock.calls[0]!;
    expect(effectId).toBe(ids.invocationEffect("inv-77"));
    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      // The formatted protocol content + the raw result on details (for the harness).
      result: { details: { success: true } },
    });
    expect(address).toEqual({ channelId: CHANNEL });
  });

  it("marks the outcome isError for a failed eval", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";
    await vessel.onEvalComplete({
      runId: "inv-78",
      result: { success: false, console: "", error: "boom" },
      channelId: CHANNEL,
    });
    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({ kind: "tool", isError: true });
  });

  it("is a no-op without a channelId or result (can't route the resume)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";
    await vessel.onEvalComplete({ runId: "inv-79", result: { success: true, console: "" } });
    await vessel.onEvalComplete({ runId: "inv-79", channelId: CHANNEL });
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-server caller (open relay; only the server settles an eval)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do"; // another DO trying to forge a completion
    await expect(
      vessel.onEvalComplete({
        runId: "inv-80",
        result: { success: true, console: "" },
        channelId: CHANNEL,
      })
    ).rejects.toThrow(/server-only/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("deliverEffectOutcome accepts server + the agent's PubSubChannel DO, refuses other DOs", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    const outcome = { kind: "tool", result: "ok", isError: false } as never;

    vessel.callerKindForTest = "server";
    await vessel.deliverEffectOutcome("eff-1", outcome);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";
    await vessel.deliverEffectOutcome("eff-2", outcome);
    expect(deliverSpy).toHaveBeenCalledTimes(2);

    vessel.callerIdForTest = "do:agents/evil:EvilAgent:x"; // a foreign agent forging
    await expect(vessel.deliverEffectOutcome("eff-3", outcome)).rejects.toThrow(/refusing caller/);
    expect(deliverSpy).toHaveBeenCalledTimes(2);
  });

  it("onDeferredResult refuses a non-server caller", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "panel";
    await expect(vessel.onDeferredResult({ requestId: "req-1", result: "x" })).rejects.toThrow(
      /server-only/
    );
  });
});

/** Vessel whose `rpc.call` is a recording stub, so we can drive `runDeferredEval` (the eval gate). */
class EvalGateProbe extends TestVessel {
  rpcCalls: Array<{ method: string; args: unknown[] }> = [];
  getRunStatus: { status: string; result?: unknown } = { status: "pending" };
  /** When set, `eval.getRun` REJECTS with this error (a transient store/RPC hiccup). */
  getRunError: Error | null = null;
  /** When set, `eval.startRun` REJECTS with this error (the kick-off itself failed). */
  startRunError: Error | null = null;
  /** When set, `eval.cancel`/`eval.forceReset` REJECT with this error. */
  cancelError: Error | null = null;
  protected override get rpc(): DeferrableRpcClient {
    return {
      call: async (_target: string, method: string, args: unknown[]) => {
        this.rpcCalls.push({ method, args });
        if (method === "eval.getRun") {
          if (this.getRunError) throw this.getRunError;
          return this.getRunStatus;
        }
        if (method === "eval.startRun" && this.startRunError) throw this.startRunError;
        if (method === "eval.cancel" || method === "eval.forceReset") {
          if (this.cancelError) throw this.cancelError;
          return { ok: true };
        }
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      },
    } as unknown as DeferrableRpcClient;
  }
  callGate(channelId: string, invocationId: string, args: unknown) {
    return this.runDeferredEval(channelId, invocationId, args);
  }
  /** Drive a channel-callable agent method (cancelEval / pause / …) directly. */
  callAgentMethod(channelId: string, methodName: string, args: unknown) {
    return this.handleStandardAgentMethodCall(channelId, methodName, args);
  }
  /** Replace the lazily-built driver with a spy so `pause` doesn't boot the real
   *  driver (which needs a live gateway/GAD). `inFlight` models whether a model
   *  call was running when the flush hit (drives the conditional-abort path). */
  stubDriverForPause(
    opts: { inFlight?: boolean } = {}
  ): { abortChannel: ReturnType<typeof vi.fn>; handleIncoming: ReturnType<typeof vi.fn> } {
    const abortChannel = vi.fn();
    const handleIncoming = vi.fn(async () => {});
    const loop = vi.fn(async () => ({
      state: { inFlightModelCall: opts.inFlight ? { messageId: "m" } : null },
    }));
    (this as unknown as { _driver: unknown })._driver = { abortChannel, handleIncoming, loop };
    return { abortChannel, handleIncoming };
  }
}

async function makeGateProbe(): Promise<EvalGateProbe> {
  const { instance } = await createTestDO(EvalGateProbe, { __objectKey: "agent-key" });
  return instance;
}

describe("AgentVesselBase.runDeferredEval (the agent's eval-tool deferral gate)", () => {
  it("kicks off eval.startRun with runId===invocationId (subKey=channelId) and defers while pending", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    const out = await probe.callGate(CHANNEL, "inv-1", { code: "1+1" });

    expect(out).toEqual({ deferred: true });
    const start = probe.rpcCalls.find((c) => c.method === "eval.startRun");
    expect(start?.args[0]).toMatchObject({
      runId: "inv-1",
      channelId: CHANNEL,
      subKey: CHANNEL,
      code: "1+1",
    });
    // The poll backstop check happened even on the first dispatch.
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(true);
  });

  it("completes INLINE when getRun already reports done (the lost-push poll backstop)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: { success: true, console: "out", returnValue: 5 },
    };

    const out = await probe.callGate(CHANNEL, "inv-2", { code: "5" });

    expect((out as { deferred?: boolean }).deferred).toBeUndefined();
    expect(out).toMatchObject({ isError: false });
    expect((out as { result: { details: unknown } }).result).toMatchObject({
      details: { success: true },
    });
  });

  it("returns a terminal error when getRun reports cancelled (reset)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "cancelled" };
    const out = await probe.callGate(CHANNEL, "inv-3", { code: "x" });
    expect(out).toMatchObject({ isError: true, result: expect.stringContaining("cancelled") });
  });

  it("rejects both-code-and-path (or neither) WITHOUT dispatching a run", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callGate(CHANNEL, "inv-4", { code: "x", path: "y" });
    expect(out).toMatchObject({ isError: true });
    expect(probe.rpcCalls).toHaveLength(0);
  });

  it("F4: PARKS (deferred) when the getRun poll throws AFTER startRun succeeded — never a spurious error", async () => {
    // The run is already in flight server-side (startRun returned). A transient getRun hiccup must
    // NOT surface as the tool result (that would settle the invocation with a fake error AND drop the
    // real eval result when the held run later completes). It parks for the push / deferRedrive.
    const probe = await makeGateProbe();
    probe.getRunError = new Error("transient store load failed");

    const out = await probe.callGate(CHANNEL, "inv-park", { code: "1+1" });

    // Parked, not errored.
    expect(out).toEqual({ deferred: true });
    expect((out as { isError?: boolean }).isError).toBeUndefined();
    // startRun still kicked off the run (so the result can arrive out-of-band).
    expect(probe.rpcCalls.find((c) => c.method === "eval.startRun")?.args[0]).toMatchObject({
      runId: "inv-park",
      channelId: CHANNEL,
    });
    // The poll WAS attempted (and threw).
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(true);
  });

  it("F4: a startRun failure still propagates (the run was never kicked off — fail fast)", async () => {
    // startRun throwing means the eval never started; there's nothing parked to settle later, so the
    // error must propagate to the tool executor (which renders it as the tool outcome). We only park
    // for a getRun hiccup AFTER a successful startRun.
    const probe = await makeGateProbe();
    probe.startRunError = new Error("startRun dispatch failed");
    await expect(probe.callGate(CHANNEL, "inv-fail", { code: "1+1" })).rejects.toThrow(
      /startRun dispatch failed/
    );
    // The getRun poll was never reached.
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(false);
  });
});

describe("AgentVesselBase.cancelEval (pill cancel → server-side eval run)", () => {
  it("routes to eval.cancel for ITSELF (subKey=channelId) with the run id", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", { runId: "inv-9" });
    expect(out).toEqual({ result: { ok: true } });
    const cancel = probe.rpcCalls.find((c) => c.method === "eval.cancel");
    expect(cancel?.args[0]).toEqual({ subKey: CHANNEL, runId: "inv-9" });
  });

  it("rejects a missing/empty runId WITHOUT dispatching a cancel", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", {});
    expect(out).toMatchObject({ isError: true });
    expect(probe.rpcCalls.some((c) => c.method === "eval.cancel")).toBe(false);
  });

  it("surfaces an eval.cancel failure as an error result (without throwing)", async () => {
    const probe = await makeGateProbe();
    probe.cancelError = new Error("cancel dispatch failed");
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", { runId: "inv-10" });
    expect(out).toMatchObject({ isError: true, result: { error: "cancel dispatch failed" } });
  });
});

describe("AgentVesselBase pause (clears a wedged EvalDO)", () => {
  it("invokes eval.forceReset for ITSELF (subKey=channelId) after aborting the channel", async () => {
    const probe = await makeGateProbe();
    const { abortChannel, handleIncoming } = probe.stubDriverForPause();

    const out = await probe.callAgentMethod(CHANNEL, "pause", {});

    expect(out).toEqual({ result: { paused: true } });
    expect(abortChannel).toHaveBeenCalledWith(CHANNEL);
    expect(handleIncoming).toHaveBeenCalled();
    const forceReset = probe.rpcCalls.find((c) => c.method === "eval.forceReset");
    expect(forceReset?.args[0]).toEqual({ subKey: CHANNEL });
  });

  it("does NOT fail the pause when eval.forceReset throws (best-effort)", async () => {
    const probe = await makeGateProbe();
    probe.stubDriverForPause();
    probe.cancelError = new Error("forceReset hiccup");
    const out = await probe.callAgentMethod(CHANNEL, "pause", {});
    expect(out).toEqual({ result: { paused: true } });
    // It still ATTEMPTED the forceReset.
    expect(probe.rpcCalls.some((c) => c.method === "eval.forceReset")).toBe(true);
  });

  it("flushDeferred WITH a model call in flight aborts (soft flush re-runs with steers)", async () => {
    const probe = await makeGateProbe();
    const { abortChannel } = probe.stubDriverForPause({ inFlight: true });
    await probe.callAgentMethod(CHANNEL, "pause", { flushDeferred: true });
    expect(abortChannel).toHaveBeenCalledWith(CHANNEL);
  });

  it("flushDeferred with NO model call in flight does NOT abort (else it kills the fresh steer turn)", async () => {
    const probe = await makeGateProbe();
    const { abortChannel, handleIncoming } = probe.stubDriverForPause({ inFlight: false });
    await probe.callAgentMethod(CHANNEL, "pause", { flushDeferred: true });
    // The loop's flush opens a fresh turn whose model call delivers the steers;
    // aborting here would kill it. So: interrupt delivered, but no abort.
    expect(handleIncoming).toHaveBeenCalled();
    expect(abortChannel).not.toHaveBeenCalled();
  });
});

describe("AgentVesselBase.onEvalProgress (live eval console streaming)", () => {
  it("publishes an invocation.output event keyed to the eval invocation (runId)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    await vessel.onEvalProgress({ runId: "inv-5", channelId: CHANNEL, output: "hello\nworld" });

    const published = vessel.channelStub.published.find((p) => p.event.kind === "invocation.output");
    expect(published?.event).toMatchObject({
      kind: "invocation.output",
      causality: { invocationId: "inv-5" },
      payload: { output: "hello\nworld", channel: "stdout" },
    });
  });

  it("refuses a caller that is not the agent's own EvalDO (same gate as chatOp)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:natstack/internal:EvalDO:someoneelse";
    await expect(
      vessel.onEvalProgress({ runId: "inv-6", channelId: CHANNEL, output: "x" })
    ).rejects.toThrow(/only this agent's own EvalDO/);
  });

  it("is a no-op for empty output (no event published)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalProgress({ runId: "inv-7", channelId: CHANNEL, output: "" });
    expect(vessel.channelStub.published.some((p) => p.event.kind === "invocation.output")).toBe(
      false
    );
  });
});
