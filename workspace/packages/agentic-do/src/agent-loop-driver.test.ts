import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../../workers/gad-store/index.js";
import {
  ids,
  type AgentLoopConfig,
  type EffectDescriptor,
  type EffectOutcome,
  type StepPolicy,
} from "@workspace/agent-loop";
import { AgentLoopDriver, type DriverDeps } from "./agent-loop-driver.js";
import type { ChannelCallPort, EffectExecutor, EphemeralEmit } from "./effect-executors/index.js";
import { CREDENTIAL_CONNECT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import { summarizeTurn } from "./agent-vessel.js";

const CHANNEL = "chan-d1";
const LOG_ID = ids.logIdForChannel(CHANNEL);

const config: AgentLoopConfig = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
};

interface Script {
  /** queued model outcomes, consumed per model_call dispatch. */
  model: EffectOutcome[];
  /** queued tool outcomes. */
  tool: EffectOutcome[];
}

async function makeHarness(opts: {
  script: Script;
  policies?: StepPolicy[];
  ephemeral?: EphemeralEmit;
  executorOverride?: DriverDeps["executorOverride"];
  runBackground?: DriverDeps["runBackground"];
  killPoint?: (point: string) => void;
  selfRefFor?: DriverDeps["selfRefFor"];
  gad?: Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
  driverSql?: Awaited<ReturnType<typeof createTestDO<GadWorkspaceDO>>>;
  compaction?: { minEntries?: number; triggerBytes?: number };
  /** Optional gate to inject a TRANSIENT store-load failure: return an Error to
   *  make the gad call throw (and record nothing). Used to verify the driver
   *  never silently drops an outcome on a transient store error (F3). */
  gadFault?: (method: string) => Error | null;
}) {
  const gad = opts.gad ?? (await createTestDO(GadWorkspaceDO, { __objectKey: "gad" }));
  const driverHost =
    opts.driverSql ?? (await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" }));
  const ephemerals: EphemeralEmit[] = [];
  const broadcasts: Array<{ channelId: string; envelopeIds: string[] }> = [];
  const channelPublishes: Array<Parameters<ChannelCallPort["publish"]>[0]> = [];
  const alarms: number[] = [];
  let now = 1_750_000_000_000;
  const setNow = (value: number) => {
    now = value;
  };

  const fakeExecutor = (kind: EffectDescriptor["kind"], queue: EffectOutcome[]): EffectExecutor =>
    ({
      kind,
      async execute({ onEphemeral }) {
        if (opts.ephemeral) onEphemeral(opts.ephemeral);
        const next = queue.shift();
        if (!next) throw new Error(`script exhausted for ${kind}`);
        return next;
      },
    }) as EffectExecutor;

  const blobs = new Map<string, string>();
  const deps: DriverDeps = {
    sql: driverHost.sql as never,
    gad: {
      // The driver runs INSIDE the agent DO, so its gad-store calls are attributed
      // as a "do" — gad write methods (appendLogEvent/…) are `@rpc({ callers: ["do"] })`.
      call: <T,>(method: string, args: Record<string, unknown>) => {
        const fault = opts.gadFault?.(method);
        if (fault) return Promise.reject(fault);
        return gad.callAs<T>("do", method, args);
      },
    },
    executorDeps: {
      blobstore: {
        getText: async (digest: string) => blobs.get(digest) ?? null,
        putText: async (value: string) => {
          const digest = `blob-${blobs.size + 1}`;
          blobs.set(digest, value);
          return { digest, size: value.length };
        },
      },
      channel: {
        callMethod: async () => {},
        publish: async (input: Parameters<ChannelCallPort["publish"]>[0]) => {
          channelPublishes.push(input);
        },
        sendSignalEvent: async () => {},
      },
      credentials: {
        getApiKey: async () => ({ apiKey: "test-key" }),
        registerCredentialInterest: async () => {},
      },
    } as never, // fakes only touch blobstore
    selfRefFor:
      opts.selfRefFor ?? (() => ({ kind: "agent", id: "agent:self", participantId: "agent:self" })),
    configFor: () => config,
    policiesFor: () => opts.policies ?? [],
    onEphemeral: (emit) => ephemerals.push(emit),
    broadcastStoredEnvelopes: async (channelId, envelopeIds) => {
      broadcasts.push({ channelId, envelopeIds });
    },
    now: () => (now += 7),
    scheduleAlarm: (at) => alarms.push(at),
    ...(opts.runBackground ? { runBackground: opts.runBackground } : {}),
    executorOverride: (descriptor) => {
      const override = opts.executorOverride?.(descriptor);
      if (override) return override;
      if (descriptor.kind === "model_call") return fakeExecutor("model_call", opts.script.model);
      if (descriptor.kind === "local_tool") return fakeExecutor("local_tool", opts.script.tool);
      return null;
    },
    ...(opts.compaction ? { compaction: opts.compaction } : {}),
    ...(opts.killPoint ? { killPoint: opts.killPoint } : {}),
  };
  const driver = new AgentLoopDriver(deps);
  return { driver, gad, driverHost, ephemerals, alarms, broadcasts, channelPublishes, setNow };
}

/** Drain the alarm pump until the outbox is quiet (the driver executes
 *  effects ONLY in alarm context — hibernation-first discipline). */
async function settle(driver: AgentLoopDriver, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await driver.alarm().catch(() => {});
    if (driver.outbox.all().length === 0) break;
  }
}

function promptIncoming(envelopeId = "env-1", content = "hello") {
  return {
    type: "command" as const,
    command: {
      kind: "prompt" as const,
      channelId: CHANNEL,
      source: { envelopeId },
      content,
      senderRef: { kind: "user" as const, id: "panel:user", participantId: "panel:user" },
    },
  };
}

async function logKinds(gad: { call: <T>(m: string, ...a: unknown[]) => Promise<T> }) {
  const rows = await gad.call<{ rows: Array<{ payload_kind: string }> }>(
    "query",
    `SELECT payload_kind FROM log_events WHERE log_id = '${LOG_ID}' ORDER BY seq`,
    []
  );
  return rows.rows.map((row) => row.payload_kind);
}

const textReply = (text: string): EffectOutcome => ({
  kind: "model",
  blocks: [{ type: "text", content: text }],
  stopReason: "completed",
});

const toolCallReply = (id: string): EffectOutcome => ({
  kind: "model",
  blocks: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
  stopReason: "completed",
});

const toolOk: EffectOutcome = { kind: "tool", result: null, isError: false };

function rawUsageLimitError(): string {
  return `Codex error: ${JSON.stringify({
    type: "error",
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      resets_at: 1781548501,
    },
    headers: {
      "X-Codex-Bengalfox-Limit-Name": "GPT-5.3 Codex-Spark",
    },
  })}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AgentLoopDriver", () => {
  it("publishes a read-ack EAGERLY at step time, not behind the (pending) model call", async () => {
    // Regression for the steer-read-ack delay: a fire-and-forget publish_envelope
    // (read-ack) co-emitted with a long model_call used to wait in the effect
    // pump until the model finished. Hang the model call and DON'T drain the
    // alarm — the read-ack must already be on the channel (eager step-time
    // publish), proving it no longer queues behind the model dispatch.
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              execute: () => new Promise<EffectOutcome>(() => {}), // never resolves
            } as EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: CHANNEL,
        source: { envelopeId: "env-1" },
        sourceMessageId: "u1",
        content: "hi",
        senderRef: { kind: "user", id: "panel:user", participantId: "panel:user" },
      },
    });
    const reads = harness.channelPublishes.filter(
      (p) => (p.payload as { kind?: string } | undefined)?.kind === "message.read"
    );
    expect(
      reads.some(
        (r) =>
          (r.payload as { causality?: { messageId?: string } } | undefined)?.causality
            ?.messageId === "u1"
      )
    ).toBe(true);
  });

  it("a long model_call on one channel does NOT pin the shared pump (other channels still dispatch)", async () => {
    // Regression: dispatchDue used to `await Promise.all` every loop's due rows,
    // so one channel's minutes-long model_call head-of-line-blocked every other
    // channel. With detached dispatch, channel A's hung model must not stop
    // channel B's turn from dispatching.
    const CHANNEL_B = "chan-d2";
    const hung = deferred<EffectOutcome>();
    let bModelCalls = 0;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      runBackground: (fn) => {
        void fn(); // simulate waitUntil: run the detached dispatch in the background
      },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        if (descriptor.channelId === CHANNEL) {
          return { kind: "model_call", execute: () => hung.promise } as EffectExecutor; // hangs forever
        }
        return {
          kind: "model_call",
          async execute() {
            bModelCalls += 1;
            return textReply("hi from B");
          },
        } as EffectExecutor;
      },
    });
    // Channel A: model call hangs (detached — must not pin the pump).
    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-a"));
    // Channel B: a different channel's turn must still dispatch + complete.
    await harness.driver.handleIncoming(CHANNEL_B, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: CHANNEL_B,
        source: { envelopeId: "env-b" },
        content: "hi",
        senderRef: { kind: "user", id: "panel:user", participantId: "panel:user" },
      },
    });
    await settle(harness.driver, 6);
    // Channel B got its model call despite channel A's model hanging.
    expect(bModelCalls).toBe(1);
  });

  it("propagates detached dispatch driver failures to the background runner", async () => {
    const background: Promise<unknown>[] = [];
    let failAppends = false;
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      runBackground: (fn) => {
        const promise = fn();
        promise.catch(() => {});
        background.push(promise);
      },
      executorOverride: (descriptor) =>
        descriptor.kind === "model_call"
          ? ({
              kind: "model_call",
              async execute() {
                failAppends = true;
                return textReply("done");
              },
            } as EffectExecutor)
          : null,
      gadFault: (method) =>
        failAppends && method === "appendLogEvent" ? new Error("append down") : null,
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming("env-bg-fail"));
    await Promise.resolve();
    await Promise.resolve();

    await expect(Promise.all(background)).rejects.toThrow("append down");
    expect(harness.driver.outbox.all()[0]?.leaseExpiresAt).not.toBeNull();
  });

  it("stamps channel-specific self identity on durable turn events", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      selfRefFor: (channelId) => ({
        kind: "agent",
        id: `agent:${channelId}`,
        participantId: `agent:${channelId}`,
        displayName: "AI Chat",
        metadata: { type: "agent", name: "AI Chat", handle: "ai-chat" },
      }),
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());

    const rows = await harness.gad.call<{ rows: Array<{ actor_json: string }> }>(
      "query",
      `SELECT actor_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'turn.opened' ORDER BY seq`,
      []
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.parse(rows.rows[0]!.actor_json)).toEqual({
      kind: "agent",
      id: `agent:${CHANNEL}`,
      participantId: `agent:${CHANNEL}`,
      displayName: "AI Chat",
      metadata: { type: "agent", name: "AI Chat", handle: "ai-chat" },
    });
  });

  it("keeps equal effect ids isolated by branch", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
    });
    const effectFor = (channelId: string): EffectDescriptor => ({
      kind: "local_tool",
      effectId: ids.invocationEffect("tc-1"),
      channelId,
      idempotencyKey: "tc-1",
      invocationId: "tc-1",
      turnId: `turn:${channelId}`,
      tool: "read",
      args: {},
    });

    const otherChannel = "chan-other";
    const otherLog = ids.logIdForChannel(otherChannel);
    harness.driver.outbox.insert(LOG_ID, effectFor(CHANNEL), null);
    harness.driver.outbox.insert(otherLog, effectFor(otherChannel), null);

    expect(harness.driver.outbox.all()).toHaveLength(2);
    expect(harness.driver.outbox.get(LOG_ID, ids.invocationEffect("tc-1"))?.channelId).toBe(
      CHANNEL
    );
    expect(harness.driver.outbox.get(otherLog, ids.invocationEffect("tc-1"))?.channelId).toBe(
      otherChannel
    );
  });

  it("applies policy filters to executor-side ephemeral signals", async () => {
    const messageId = ids.messageId(ids.turnId(CHANNEL, "env-1"), 1);
    const dropEphemeral: StepPolicy = {
      name: "drop-ephemeral",
      intercept: ({ output }) => output,
      filterEphemeral: () => null,
    };
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      policies: [dropEphemeral],
      ephemeral: {
        kind: "signal-event",
        channelId: CHANNEL,
        event: {
          kind: "message.delta",
          actor: { kind: "agent", id: "agent:self", participantId: "agent:self" },
          causality: { messageId: messageId as never },
          payload: {
            protocol: "agentic.trajectory.v1",
            blockId: `${messageId}:block:0` as never,
            type: "text",
            text: "streamed",
          },
          createdAt: new Date(0).toISOString(),
        } as never,
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(harness.ephemerals).toEqual([]);
  });

  it("runs prompt → model → tool → model → close against the real gad store", async () => {
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [toolOk] },
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed", // recv user
      "turn.opened",
      "message.started",
      "message.completed", // assistant w/ tool call
      "invocation.started",
      "invocation.completed",
      "message.started",
      "message.completed", // assistant final
      "turn.closed",
    ]);
    // outbox drained; channel log got the published events
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const channelRows = await harness.gad.call<{ rows: Array<{ cnt: number }> }>(
      "query",
      `SELECT COUNT(*) AS cnt FROM log_events WHERE log_id = '${CHANNEL}'`,
      []
    );
    expect(channelRows.rows[0]!.cnt).toBeGreaterThan(0);
    expect(harness.broadcasts.length).toBeGreaterThan(0);
    expect(harness.broadcasts.every((item) => item.channelId === CHANNEL)).toBe(true);
    expect(harness.broadcasts.flatMap((item) => item.envelopeIds)).toContain(
      `pub:${ids.messageTerminal(ids.messageId(ids.turnId(CHANNEL, "env-1"), 1))}:${CHANNEL}`
    );
  });

  it("a deferred local_tool (eval) parks the row + keeps the turn open; deliverEffectOutcome completes it → next model call", async () => {
    let toolDispatches = 0;
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "local_tool") return null;
        // Mirror the agent's eval gate: a local tool that DEFERS (eval.startRun kicked off; the
        // result arrives out-of-band via onEvalComplete → deliverEffectOutcome).
        return {
          kind: "local_tool",
          async execute() {
            toolDispatches += 1;
            return { deferred: true };
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    // The deferred local_tool PARKS (row kept, not deleted) and the turn stays OPEN / non-stranded
    // — its PendingInvocation in the fold is the keep-alive (no credential-style turn.waiting needed).
    expect(toolDispatches).toBe(1);
    expect(harness.driver.outbox.all()).toEqual([expect.objectContaining({ kind: "local_tool" })]);
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).not.toBeNull();

    // Deliver the result out-of-band (exactly what the agent's onEvalComplete does).
    await harness.driver.deliverEffectOutcome(
      ids.invocationEffect("tc-1"),
      {
        kind: "tool",
        result: {
          protocolContent: [{ type: "text", text: "[eval] ok" }],
          details: { success: true },
        },
        isError: false,
      },
      { channelId: CHANNEL }
    );
    await settle(harness.driver);

    // Row drained; the invocation completed, the next model call ran, the turn closed.
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds).toContain("turn.closed");
    expect((await harness.driver.loop(CHANNEL)).state.openTurn).toBeNull();
  });

  it("a duplicate deliverEffectOutcome for a deferred eval is a harmless no-op (the push + poll-backstop both fire)", async () => {
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              async execute() {
                return { deferred: true };
              },
            } satisfies EffectExecutor)
          : null,
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    const outcome: EffectOutcome = {
      kind: "tool",
      result: { protocolContent: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    };
    await harness.driver.deliverEffectOutcome(ids.invocationEffect("tc-1"), outcome, { channelId: CHANNEL });
    await settle(harness.driver);
    const kindsAfterFirst = await logKinds(harness.gad);

    // Second delivery (the getRun poll backstop racing the onEvalComplete push) — idempotent no-op.
    await harness.driver.deliverEffectOutcome(ids.invocationEffect("tc-1"), outcome, { channelId: CHANNEL });
    await settle(harness.driver);
    expect(await logKinds(harness.gad)).toEqual(kindsAfterFirst);
  });

  it("F3: a TRANSIENT store-load error during deliverEffectOutcome must NOT silently drop the outcome", async () => {
    // Park a deferred local_tool (the eval pattern), then make the store FAIL on the next fold-load
    // (getLogHead) so deliverEffectOutcome → applyOutcome → loopForBranch hits a transient error.
    // Previously loopForBranch swallowed this as `null` and the arriving outcome was DROPPED with the
    // row left parked forever. Now the error propagates: the row stays parked and a later redelivery
    // (after the store recovers) completes the invocation.
    let faultArmed = false;
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      executorOverride: (descriptor) =>
        descriptor.kind === "local_tool"
          ? ({
              kind: "local_tool",
              async execute() {
                return { deferred: true };
              },
            } satisfies EffectExecutor)
          : null,
      // Fail ONLY the fold-load head read, and only while armed — appends still work.
      gadFault: (method) => (faultArmed && method === "getLogHead" ? new Error("store unavailable") : null),
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);
    // Parked: the deferred local_tool row is kept, the turn stays open.
    expect(harness.driver.outbox.all()).toEqual([expect.objectContaining({ kind: "local_tool" })]);

    const outcome: EffectOutcome = {
      kind: "tool",
      result: { protocolContent: [{ type: "text", text: "[eval] ok" }], details: { success: true } },
      isError: false,
    };

    // Force a fresh fold (drop the cached loop) so the next deliver MUST load via getLogHead → faults.
    harness.driver.dropLoop(CHANNEL);
    faultArmed = true;
    // The transient error PROPAGATES (no longer swallowed) — the caller's redrive/alarm retries.
    await expect(
      harness.driver.deliverEffectOutcome(ids.invocationEffect("tc-1"), outcome, { channelId: CHANNEL })
    ).rejects.toThrow(/store unavailable/);
    // Critically: the outbox row is STILL parked (the outcome was not dropped, the row not deleted).
    expect(harness.driver.outbox.all()).toEqual([expect.objectContaining({ kind: "local_tool" })]);

    // Store recovers → the redelivery (the redrive/push backstop) settles the invocation normally.
    faultArmed = false;
    await harness.driver.deliverEffectOutcome(ids.invocationEffect("tc-1"), outcome, { channelId: CHANNEL });
    await settle(harness.driver);
    expect(harness.driver.outbox.all()).toHaveLength(0);
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds).toContain("turn.closed");
  });

  it("publishes a credential-connect card when a model call suspends for credentials", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model-suspended",
            reason: "credential",
            providerId: "openai-codex",
            modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "system.event",
      "turn.waiting",
    ]);
    expect(harness.channelPublishes).toContainEqual(
      expect.objectContaining({
        channelId: CHANNEL,
        payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        payload: expect.objectContaining({
          providerId: "openai-codex",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        }),
        idempotencyKey: expect.stringContaining("credcard:"),
      })
    );
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "credential_wait" }),
    ]);
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.inFlightModelCall).toBeNull();
  });

  it("parks model auth failures behind a credential reconnect card", async () => {
    const reason = "Provided authentication token is expired. Please try signing in again.";
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model-suspended",
            reason: "credential",
            providerId: "openai-codex",
            modelBaseUrl: "https://chatgpt.com/backend-api/codex",
            waitReason: "model_credential_reconnect_required",
            diagnosticReason: reason,
            failureCode: "auth_or_credentials",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "system.event",
      "turn.waiting",
    ]);
    const failedRows = await harness.gad.call<{ rows: Array<{ payload_ref_json: string }> }>(
      "query",
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
      []
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason: "model_credential_reconnect_required",
      recoverable: true,
      code: "auth_or_credentials",
    });
    const waitingRows = await harness.gad.call<{ rows: Array<{ payload_ref_json: string }> }>(
      "query",
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'turn.waiting'`,
      []
    );
    expect(JSON.parse(waitingRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason: "model_credential_reconnect_required",
      summary: "Waiting for model credential reconnect",
    });
    expect(harness.channelPublishes).toContainEqual(
      expect.objectContaining({
        channelId: CHANNEL,
        payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
        payload: expect.objectContaining({
          providerId: "openai-codex",
          modelBaseUrl: "https://chatgpt.com/backend-api/codex",
          reason,
          failureCode: "auth_or_credentials",
        }),
      })
    );
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({ kind: "credential_wait" }),
    ]);
  });

  it("does not mark a queued model call failed when wake races the pump", async () => {
    const harness = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await harness.driver.wake(CHANNEL);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);

    await settle(harness.driver);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("closes a completed assistant turn when replay missed the terminal cascade", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" });
    let armed = true;
    const crashed = await makeHarness({
      script: { model: [textReply("done")], tool: [] },
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (armed && point === "after-outcome-append") {
          armed = false;
          throw new Error("crash after terminal append");
        }
      },
    });

    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.alarm().catch(() => {});

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
    ]);

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect((await recovered.driver.loop(CHANNEL)).state.openTurn).toBeNull();
    expect(recovered.driver.outbox.all()).toHaveLength(0);
  });

  it("parks a reset-aware model failure when replay missed the terminal cascade", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" });
    let armed = true;
    const crashed = await makeHarness({
      script: {
        model: [
          {
            kind: "model",
            blocks: [],
            stopReason: "error",
            errorReason: rawUsageLimitError(),
          },
        ],
        tool: [],
      },
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (armed && point === "after-outcome-append") {
          armed = false;
          throw new Error("crash after terminal append");
        }
      },
    });

    await crashed.driver.handleIncoming(CHANNEL, promptIncoming());
    await crashed.driver.alarm().catch(() => {});

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
    ]);

    const recovered = await makeHarness({
      script: { model: [], tool: [] },
      gad,
      driverSql: host,
    });
    await recovered.driver.wake(CHANNEL);

    expect(await logKinds(gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const loop = await recovered.driver.loop(CHANNEL);
    expect(loop.state.openTurn?.waitingCount).toBe(1);
    expect(loop.state.inFlightModelCall).toBeNull();
    expect(recovered.driver.outbox.all()).toHaveLength(0);
  });

  it("pauses usage-limit failures and resumes after a scheduled reset alarm", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "model",
            blocks: [],
            stopReason: "error",
            errorReason: rawUsageLimitError(),
          },
          textReply("resumed"),
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 3);

    expect(harness.driver.outbox.all()).toHaveLength(0);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const failedRows = await harness.gad.call<{ rows: Array<{ payload_ref_json: string }> }>(
      "query",
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
      []
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
      recoverable: false,
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });

    const messageId = ids.messageId(ids.turnId(CHANNEL, "env-1"), 0);
    await expect(
      harness.driver.scheduleResumeAtReset(CHANNEL, {
        messageId,
        resetAt: "2026-06-15T18:35:01.000Z",
      })
    ).resolves.toMatchObject({
      scheduled: true,
      wakeAt: "2026-06-15T18:35:01.000Z",
    });
    expect(harness.alarms).toContain(Date.parse("2026-06-15T18:35:01.000Z"));

    harness.setNow(Date.parse("2026-06-15T18:35:02.000Z"));
    await settle(harness.driver, 6);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
      "system.event",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("preserves reset metadata when the model executor throws a usage-limit error", async () => {
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            throw new Error(rawUsageLimitError());
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(harness.driver, 3);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.failed",
      "turn.waiting",
    ]);
    const failedRows = await harness.gad.call<{ rows: Array<{ payload_ref_json: string }> }>(
      "query",
      `SELECT payload_ref_json FROM log_events WHERE log_id = '${LOG_ID}' AND payload_kind = 'message.failed'`,
      []
    );
    expect(JSON.parse(failedRows.rows[0]!.payload_ref_json)).toMatchObject({
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });
  });

  it("reschedules retryable provider rate limits without publishing message failures", async () => {
    const harness = await makeHarness({
      script: {
        model: [
          {
            kind: "retry",
            reason: "Rate limit reached for requests.",
            retryAfterMs: 12_000,
            code: "rate_limited_retryable",
          },
        ],
        tool: [],
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await harness.driver.alarm();

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        attempts: 1,
        leaseExpiresAt: null,
        nextAttemptAt: expect.any(Number),
      }),
    ]);
  });

  it("redrives a model call after deferred credential approval resolves", async () => {
    let dispatches = 0;
    let deferredRequestId = "";
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            dispatches += 1;
            deferredRequestId = descriptor.effectId;
            return dispatches === 1 ? { deferred: true } : textReply("done");
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    await harness.driver.alarm();

    expect(dispatches).toBe(1);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        leaseExpiresAt: null,
        nextAttemptAt: expect.any(Number),
      }),
    ]);

    await harness.driver.deliverDeferredResult(deferredRequestId, { id: "cred-1" }, false);
    await harness.driver.alarm();

    expect(dispatches).toBe(2);
    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect(harness.driver.outbox.all()).toHaveLength(0);
  });

  it("does not mark a locally running model call failed when wake arrives during credential approval", async () => {
    const started = deferred<void>();
    const released = deferred<EffectOutcome>();
    const harness = await makeHarness({
      script: { model: [], tool: [] },
      executorOverride: (descriptor) => {
        if (descriptor.kind !== "model_call") return null;
        return {
          kind: "model_call",
          async execute() {
            started.resolve();
            return released.promise;
          },
        } satisfies EffectExecutor;
      },
    });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    const alarm = harness.driver.alarm();
    await started.promise;
    expect(harness.driver.outbox.all()).toEqual([
      expect.objectContaining({
        kind: "model_call",
        leaseExpiresAt: expect.any(Number),
      }),
    ]);

    await harness.driver.wake(CHANNEL);

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
    ]);

    released.resolve(textReply("done"));
    await alarm;

    expect(await logKinds(harness.gad)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
  });

  it("converges after a crash at every kill point (crash-injection harness)", async () => {
    // Reference run
    const reference = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [toolOk] },
    });
    await reference.driver.handleIncoming(CHANNEL, promptIncoming());
    await settle(reference.driver);
    const referenceKinds = await logKinds(reference.gad);

    for (const point of [
      "after-append",
      "after-fold-cache",
      "after-outbox-insert",
      "after-outcome-append",
      "after-outbox-delete",
    ]) {
      const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
      const host = await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" });
      const script: Script = {
        model: [toolCallReply("tc-1"), textReply("done")],
        tool: [toolOk],
      };
      let armed = true;
      const crashed = await makeHarness({
        script,
        gad,
        driverSql: host,
        killPoint: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Error(`crash at ${point}`);
          }
        },
      });
      await crashed.driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
      // one pump round, then the "process dies" mid-flight
      await crashed.driver.alarm().catch(() => {});

      // restart: fresh driver on the same sql + gad; wake + pump until quiescent
      const recovered = await makeHarness({ script, gad, driverSql: host });
      for (let i = 0; i < 6; i += 1) {
        await recovered.driver.wake(CHANNEL);
        await settle(recovered.driver, 2);
        if (recovered.driver.outbox.all().length === 0) break;
      }

      const kinds = await logKinds(gad);
      // allow benign extra message.failed{recoverable} + retry pairs
      const essential = kinds.filter(
        (kind) => kind !== "message.failed" && kind !== "message.started"
      );
      const referenceEssential = referenceKinds.filter(
        (kind) => kind !== "message.failed" && kind !== "message.started"
      );
      expect(essential, `kill point ${point}`).toEqual(referenceEssential);
      expect(recovered.driver.outbox.all(), `kill point ${point}`).toHaveLength(0);
      const integrity = await gad.call<{ ok: boolean }>("checkLogIntegrity", {});
      expect(integrity.ok, `kill point ${point}`).toBe(true);
    }
  }, 30_000);

  it("survives total cache amnesia mid-run (P3)", async () => {
    const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "gad" });
    const host = await createTestDO(GadWorkspaceDO, { __objectKey: "driver-host" });
    const script: Script = {
      model: [toolCallReply("tc-1"), textReply("done")],
      tool: [toolOk],
    };
    // run only the first model call, then crash before the tool dispatch
    let calls = 0;
    const first = await makeHarness({
      script,
      gad,
      driverSql: host,
      killPoint: (point) => {
        if (point === "after-outbox-insert") {
          calls += 1;
          if (calls === 2) throw new Error("simulated crash"); // after tool row insert
        }
      },
    });
    await first.driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
    await first.driver.alarm().catch(() => {});

    // cache amnesia: wipe BOTH caches
    host.sql.exec(`DELETE FROM effect_outbox`);
    host.sql.exec(`DELETE FROM fold_cache`);

    const recovered = await makeHarness({ script, gad, driverSql: host });
    for (let i = 0; i < 6; i += 1) {
      await recovered.driver.wake(CHANNEL);
      await settle(recovered.driver, 2);
      if (recovered.driver.outbox.all().length === 0) break;
    }
    const kinds = await logKinds(gad);
    expect(kinds).toContain("invocation.completed");
    expect(kinds[kinds.length - 1]).toBe("turn.closed");
    expect(recovered.driver.outbox.all()).toHaveLength(0);
    expect((await gad.call<{ ok: boolean }>("checkLogIntegrity", {})).ok).toBe(true);
  });

  it("treats duplicate deliverEffectOutcome as a no-op (deterministic terminals)", async () => {
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
    });
    // make the tool a deferred channel-style settle: override executor to defer
    harness.driver["deps" as never]; // (no-op; keep TS quiet about unused)
    const driver = harness.driver;
    // run up to the pending local_tool dispatch — script.tool is empty so the
    // dispatch fails once and backs off; instead deliver the outcome out-of-band
    await driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
    await driver.alarm().catch(() => {});
    const effectId = ids.invocationEffect("tc-1");
    await driver.deliverEffectOutcome(effectId, toolOk);
    const kindsAfterFirst = await logKinds(harness.gad);
    await driver.deliverEffectOutcome(effectId, toolOk); // duplicate
    expect(await logKinds(harness.gad)).toEqual(kindsAfterFirst);
    const terminals = await harness.gad.call<{ rows: Array<{ cnt: number }> }>(
      "query",
      `SELECT COUNT(*) AS cnt FROM log_events WHERE envelope_id = '${ids.invocationTerminal("tc-1")}'`,
      []
    );
    expect(terminals.rows[0]!.cnt).toBe(1);
  });

  it("compacts at idle AFTER a turn closes once the threshold is exceeded", async () => {
    const TURNS = 6;
    const harness = await makeHarness({
      // one plain text reply per turn (no tool calls)
      script: { model: Array.from({ length: TURNS }, (_, i) => textReply(`reply-${i}`)), tool: [] },
      // low thresholds so a handful of turns trips compaction; the vessel sizes
      // these to the model context window in production.
      compaction: { minEntries: 6, triggerBytes: 1 },
    });

    for (let i = 0; i < TURNS; i += 1) {
      await harness.driver.handleIncoming(CHANNEL, promptIncoming(`env-${i}`, `msg-${i}`));
      await settle(harness.driver);
    }

    // Compaction is journaled as system.compaction_recorded — and it fires
    // during the active prompt→reply session (each turn opens AND closes a
    // turn inside handleIncoming+settle), not only on a post-hibernation wake.
    const kinds = await logKinds(harness.gad);
    expect(kinds).toContain("system.compaction_recorded");

    // The fold actually shrank: the live loop keeps only the compaction's
    // retained tail (slice(-8)) plus whatever the last turn(s) appended —
    // bounded well below 2*TURNS entries.
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.entries.length).toBeLessThanOrEqual(10);
    expect(loop.state.openTurn).toBeNull();
  });

  it("never compacts while a turn is open (mid-turn context preserved)", async () => {
    const harness = await makeHarness({
      // a tool call keeps the turn OPEN across the model terminal; the tool
      // outcome is delivered out of band so the turn stays open mid-settle.
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
      compaction: { minEntries: 1, triggerBytes: 1 },
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
    await harness.driver.alarm().catch(() => {});
    // Turn is open (awaiting the tool). No compaction event yet.
    expect(await logKinds(harness.gad)).not.toContain("system.compaction_recorded");
    const loop = await harness.driver.loop(CHANNEL);
    expect(loop.state.openTurn).not.toBeNull();
  });
});

// Integration: agent.describe()'s `turn` block is `summarizeTurn(loop.state)`.
// Drive REAL turns through a GAD-backed loop and assert the summary over the
// state re-folded from the persisted log (not the in-memory cache).
describe("summarizeTurn over a real GAD-backed loop (agent.describe turn block)", () => {
  it("reports an in-flight turn after a prompt, then idle once it settles", async () => {
    const harness = await makeHarness({ script: { model: [textReply("done")], tool: [] } });

    await harness.driver.handleIncoming(CHANNEL, promptIncoming());
    harness.driver.dropLoop(CHANNEL); // force a fresh fold from the log
    const open = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(open.status).not.toBe("idle");
    expect(["starting", "running_model"]).toContain(open.status);
    expect(open.lastSeq).toBeGreaterThan(0);

    await settle(harness.driver);
    harness.driver.dropLoop(CHANNEL);
    const settled = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(settled.status).toBe("idle");
    expect(settled.lastSeq).toBeGreaterThan(open.lastSeq);
    expect(settled.pendingInvocations).toBe(0);
  });

  it("reports a pending tool invocation as waiting_external with a live count", async () => {
    // model emits a tool call but the tool outcome is never delivered (tool: []),
    // so the invocation stays pending in the fold.
    const harness = await makeHarness({
      script: { model: [toolCallReply("tc-1"), textReply("done")], tool: [] },
    });
    await harness.driver.handleIncoming(CHANNEL, promptIncoming()).catch(() => {});
    await harness.driver.alarm().catch(() => {}); // model emits the tool call

    harness.driver.dropLoop(CHANNEL);
    const s = summarizeTurn((await harness.driver.loop(CHANNEL)).state);
    expect(s.status).toBe("waiting_external");
    expect(s.pendingInvocations).toBeGreaterThanOrEqual(1);
  });
});
