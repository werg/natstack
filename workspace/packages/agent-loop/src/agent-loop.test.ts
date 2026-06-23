import { describe, expect, it } from "vitest";
import {
  createScenario,
  dispatch,
  resolveEffect,
  pendingEffectIds,
  kinds,
  applyAppend,
  type Scenario,
} from "./scenario.js";
import { initialAgentState, overlayInputConfig, type AgentLoopConfig } from "./state.js";
import { derivePendingEffects } from "./effects.js";
import { defaultPolicies, silentPolicy } from "./policies/index.js";
import { ids } from "./ids.js";
import type { StepPolicy } from "./step.js";

const baseConfig: AgentLoopConfig = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:system-prompt",
  activeToolNames: ["read", "write"],
  roster: { participants: [] },
};

function scenario(opts: {
  approvalLevel?: 0 | 1 | 2;
  policies?: StepPolicy[];
  forkSeq?: number;
  roster?: AgentLoopConfig["roster"];
  maxModelCallsPerTurn?: number | null;
} = {}): Scenario {
  return createScenario({
    state: initialAgentState({
      channelId: "chan-1",
      config: {
        ...baseConfig,
        approvalLevel: opts.approvalLevel ?? 2,
        roster: opts.roster ?? baseConfig.roster,
        ...(opts.maxModelCallsPerTurn !== undefined
          ? { maxModelCallsPerTurn: opts.maxModelCallsPerTurn }
          : {}),
      },
      forkSeq: opts.forkSeq,
    }),
    policies: opts.policies ?? defaultPolicies(),
  });
}

function prompt(s: Scenario, envelopeId = "env-1", content = "hello"): void {
  dispatch(s, {
    type: "command",
    command: {
      kind: "prompt",
      channelId: "chan-1",
      source: { envelopeId },
      content,
      senderRef: { kind: "user", id: "panel:user", participantId: "panel:user" },
    },
  });
}

const turn1 = ids.turnId("chan-1", "env-1", "agent:self");
const msg0 = ids.messageId(turn1, 0);

describe("agent-loop core lifecycle", () => {
  it("prompt opens a turn, journals before dispatch, and closes on a text-only reply", () => {
    const s = scenario();
    prompt(s);

    // journal-before-dispatch: recv + turn.opened + message.started all durable
    expect(kinds(s)).toEqual(["message.completed", "turn.opened", "message.started"]);
    expect(s.log[2]!.envelopeId).toBe(ids.messageStarted(msg0));
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg0)]);

    // the started payload fully describes the request (re-derivable, P2)
    const request = (s.log[2]!.payload as { modelRequest: Record<string, unknown> })
      .modelRequest;
    expect(request).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPromptHash: "blob:system-prompt",
      attemptId: ids.attemptId(msg0),
      contextThroughSeq: 2,
    });

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "hi there" }],
      stopReason: "completed",
    });

    expect(kinds(s)).toEqual([
      "message.completed",
      "turn.opened",
      "message.started",
      "message.completed",
      "turn.closed",
    ]);
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    expect(s.state.entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
  });

  it("runs the tool loop: model tool-call → local_tool effect → result → next model call", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } }],
      stopReason: "completed",
    });

    // invocation journaled with full transport; effect pending
    const started = s.log.find((row) => row.envelopeId === ids.invocationStart("tc-1"))!;
    expect(started.payload).toMatchObject({
      name: "read",
      transport: { kind: "local", awaiterId: "tc-1" },
    });
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);

    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: { protocol: "natstack.blob-ref.v1", digest: "d1", size: 3, encoding: "json", originalBytes: 3 },
      isError: false,
    });

    // E-invocation-terminal: last invocation settled → next model call
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(s.state.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "assistant",
      "tool-result",
    ]);

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("stamps tier secondary on tool-call (intermediate) messages and primary on the final answer", () => {
    const s = scenario();
    prompt(s);
    // First model output carries a tool call → the turn continues → tier 2.
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } }],
      stopReason: "completed",
    });
    const intermediate = s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))!;
    expect((intermediate.payload as { tier?: string }).tier).toBe("secondary");

    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: "file contents",
      isError: false,
    });
    const msg1 = ids.messageId(turn1, 1);
    // Final model output is text-only → turn closes → tier 1.
    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    const final = s.log.find((row) => row.envelopeId === ids.messageTerminal(msg1))!;
    expect((final.payload as { tier?: string }).tier).toBe("primary");
  });

  it("stamps tier primary on a direct text-only answer", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "hi there" }],
      stopReason: "completed",
    });
    const completed = s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))!;
    expect((completed.payload as { tier?: string }).tier).toBe("primary");
  });

  it("uses a configured per-turn model-call budget", () => {
    const s = scenario({ maxModelCallsPerTurn: 1 });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "a.ts" } }],
      stopReason: "completed",
    });
    resolveEffect(s, ids.invocationEffect("tc-1"), {
      kind: "tool",
      result: "file contents",
      isError: false,
    });

    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
    const diagnostic = s.log.find(
      (row) => row.envelopeId === `diag:${turn1}:max-model-calls-per-turn`
    );
    expect(diagnostic?.payload).toMatchObject({
      blocks: [
        {
          metadata: {
            code: "max_model_calls_per_turn",
            severity: "error",
            configKey: "maxModelCallsPerTurn",
            limit: 1,
            modelCallCount: 1,
            turnId: turn1,
          },
        },
      ],
    });
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({ reason: "max_model_calls_per_turn" });
  });

  it("does not cap model calls by default", () => {
    const s = scenario();
    prompt(s);

    for (let i = 0; i < 35; i += 1) {
      const messageId = ids.messageId(turn1, i);
      const toolCallId = `tc-${i}`;
      expect(pendingEffectIds(s)).toEqual([ids.modelEffect(messageId)]);
      resolveEffect(s, ids.modelEffect(messageId), {
        kind: "model",
        blocks: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }],
        stopReason: "completed",
      });
      resolveEffect(s, ids.invocationEffect(toolCallId), {
        kind: "tool",
        result: `file contents ${i}`,
        isError: false,
      });
    }

    const msg35 = ids.messageId(turn1, 35);
    expect(s.state.openTurn?.modelCallCount).toBe(36);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg35)]);
    expect(
      s.log.some((row) => row.envelopeId === `diag:${turn1}:max-model-calls-per-turn`)
    ).toBe(false);

    resolveEffect(s, ids.modelEffect(msg35), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("queues steering and consumes it with the next model call", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        content: "also do this",
        senderRef: { kind: "user", id: "panel:user" },
      },
    });
    // model call in flight: steer only journals the user message
    expect(s.state.steeringQueue).toHaveLength(1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg0)]);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "first answer" }],
      stopReason: "completed",
    });

    // steering pending → next model call instead of close
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    // the new snapshot covers the steered message → queue drained
    expect(s.state.steeringQueue).toHaveLength(0);

    resolveEffect(s, ids.modelEffect(msg1), {
      kind: "model",
      blocks: [{ type: "text", content: "both done" }],
      stopReason: "completed",
    });
    expect(s.state.openTurn).toBeNull();
  });

  it("interrupt mid-model-call settles pendings and closes the turn after the interrupted terminal", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, { type: "command", command: { kind: "interrupt" } });
    // marker journaled; model executor abort is the driver's job
    expect(kinds(s)).toContain("system.event");
    expect(s.state.openTurn?.interrupted).toBe(true);

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "partial" }],
      stopReason: "aborted",
    });
    expect(s.state.openTurn).toBeNull();
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({ reason: "user_interrupted" });
    expect(pendingEffectIds(s)).toEqual([]);
  });

  it("classifies empty and tool_calls_only outcomes", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "completed",
    });
    const completed = s.log.filter((row) => row.payloadKind === "message.completed");
    expect(completed[completed.length - 1]!.payload).toMatchObject({ outcome: "empty" });
  });

  it("multi-attempt: recoverable model failure retries with a fresh messageId", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      errorReason: "overloaded",
    });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(s.log.some((row) => row.payloadKind === "message.failed")).toBe(true);
    // fresh attempt id
    const started = s.log.filter((row) => row.payloadKind === "message.started");
    expect(started).toHaveLength(2);
  });

  it("pauses terminal model usage-limit failures until the reset time", () => {
    const s = scenario();
    prompt(s);
    const rawUsageLimit = `Codex error: ${JSON.stringify({
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

    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [],
      stopReason: "error",
      errorReason: rawUsageLimit,
    });

    expect(pendingEffectIds(s)).toEqual([]);
    expect(s.state.openTurn).not.toBeNull();
    expect(s.log.filter((row) => row.payloadKind === "message.started")).toHaveLength(1);
    const failed = s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))!;
    expect(failed.payload).toMatchObject({
      reason:
        "The usage limit has been reached for GPT-5.3 Codex-Spark. Try again after Jun 15, 2026 at 6:35 PM UTC.",
      recoverable: false,
      code: "usage_limit_terminal",
      resetAt: "2026-06-15T18:35:01.000Z",
    });
    const waiting = s.log.find((row) => row.payloadKind === "turn.waiting")!;
    expect(waiting.payload).toMatchObject({
      reason: "model_usage_limit_reset",
      summary: "Waiting for model usage limit reset",
    });
    expect(s.log.some((row) => row.payloadKind === "turn.closed")).toBe(false);

    s.ctx.now = "2026-06-15T18:35:02.000Z";
    dispatch(s, {
      type: "command",
      command: {
        kind: "resumeAfterReset",
        messageId: msg0,
        resetAt: "2026-06-15T18:35:01.000Z",
      },
    });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
    expect(s.log.filter((row) => row.payloadKind === "message.started")).toHaveLength(2);
  });

  it("effect-failed (model, attempts exhausted) closes the turn with a published diagnostic", () => {
    const s = scenario();
    prompt(s);
    dispatch(s, {
      type: "effect-failed",
      effectId: ids.modelEffect(msg0),
      kind: "model_call",
      error: { message: "provider exploded" },
      attempts: 3,
    });
    expect(s.state.openTurn).toBeNull();
    const closed = s.log.find((row) => row.payloadKind === "turn.closed")!;
    expect(closed.payload).toMatchObject({ reason: "work_failed" });
    const failed = s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))!;
    expect(failed.payloadKind).toBe("message.failed");
    expect(failed.publish).toBe(true);
    const diagnostic = s.log.find(
      (row) => row.payloadKind === "message.completed" && String(row.envelopeId).startsWith("diag:")
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.publish).toBe(true);
  });
});

describe("approval gate (approvalLevel < 2)", () => {
  it("gates unsafe tools, keeps safe tools auto at level 1, and resumes on grant", () => {
    const s = scenario({ approvalLevel: 1 });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        { type: "toolCall", id: "tc-r", name: "read", arguments: {} },
        { type: "toolCall", id: "tc-w", name: "write", arguments: { path: "x" } },
      ],
      stopReason: "completed",
    });

    const approvalId = ids.approvalId("tc-w");
    // read dispatches immediately; write is gated behind the approval form
    expect(pendingEffectIds(s)).toEqual(
      [ids.approvalFormEffect(approvalId), ids.invocationEffect("tc-r")].sort()
    );
    expect(
      s.log.find((row) => row.envelopeId === ids.approvalRequested(approvalId))!.payload
    ).toMatchObject({
      question: "Allow tool call?",
      details: { toolName: "write" },
    });

    resolveEffect(s, ids.invocationEffect("tc-r"), { kind: "tool", result: null, isError: false });
    // still waiting on approval — no model call yet
    expect(pendingEffectIds(s)).toEqual([ids.approvalFormEffect(approvalId)]);

    resolveEffect(s, ids.approvalFormEffect(approvalId), {
      kind: "approval",
      granted: true,
      resolvedBy: { kind: "user", id: "panel:user" },
    });
    // grant → the gated tool's dispatch effect becomes derivable
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-w")]);

    resolveEffect(s, ids.invocationEffect("tc-w"), { kind: "tool", result: null, isError: false });
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("denial appends invocation.failed (approval denied)", () => {
    const s = scenario({ approvalLevel: 0 });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-w", name: "write", arguments: {} }],
      stopReason: "completed",
    });
    const approvalId = ids.approvalId("tc-w");
    resolveEffect(s, ids.approvalFormEffect(approvalId), {
      kind: "approval",
      granted: false,
      resolvedBy: { kind: "user", id: "panel:user" },
      reason: "nope",
    });
    const terminal = s.log.find((row) => row.envelopeId === ids.invocationTerminal("tc-w"))!;
    expect(terminal.payloadKind).toBe("invocation.failed");
    expect(terminal.payload).toMatchObject({ reason: "approval denied" });
    // denial settles the invocation → loop continues with a fresh model call
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("a failed approval-form effect resolves the approval (no infinite reconcile loop, AL-7)", () => {
    const s = scenario({ approvalLevel: 0 });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-w", name: "write", arguments: {} }],
      stopReason: "completed",
    });
    const approvalId = ids.approvalId("tc-w");
    expect(pendingEffectIds(s)).toEqual([ids.approvalFormEffect(approvalId)]);

    // The approval-form delivery permanently fails (no `confirm` method / the
    // user participant is gone). effectFailedStep maps the `form:` effect id —
    // the bug was that it only stripped `inv:`, returned EMPTY, and the
    // approval stayed pending so reconcile re-derived the form effect forever.
    dispatch(s, {
      type: "effect-failed",
      effectId: ids.approvalFormEffect(approvalId),
      kind: "channel_call",
      error: { message: "confirm not registered" },
      attempts: 5,
    });

    // The approval is resolved fail-closed and is NO LONGER pending.
    const resolved = s.log.find((row) => row.envelopeId === ids.approvalResolved(approvalId))!;
    expect(resolved.payloadKind).toBe("approval.resolved");
    expect(resolved.payload).toMatchObject({ granted: false });
    expect(s.state.pendingApprovals[approvalId]).toBeUndefined();

    // The loop converges: the denied invocation settles and a fresh model call
    // is the only pending effect — the approval form is gone for good.
    expect(pendingEffectIds(s)).not.toContain(ids.approvalFormEffect(approvalId));
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });
});

describe("ask user policy", () => {
  it("rewrites multi-select ask_user calls to multi-select feedback forms", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "panel:user",
            ref: { kind: "panel", id: "panel:user", participantId: "panel:user" },
            type: "panel",
            methods: [{ name: "feedback_form" }],
          },
        ],
      },
    });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [
        {
          type: "toolCall",
          id: "tc-q",
          name: "ask_user",
          arguments: {
            question: "Pick targets",
            options: ["Staging", "Production"],
            multiSelect: true,
          },
        },
      ],
      stopReason: "completed",
    });

    const started = s.log.find((row) => row.envelopeId === ids.invocationStart("tc-q"))!;
    const request = (started.payload as { request: Record<string, unknown> }).request;
    const fields = request["fields"] as Array<Record<string, unknown>>;

    expect(started.payload).toMatchObject({
      name: "feedback_form",
      invocationType: "user",
      transport: {
        kind: "channel",
        channelId: "chan-1",
        target: { participantId: "panel:user" },
      },
    });
    expect(request["hideSubmit"]).toBe(false);
    expect(fields[0]).toMatchObject({
      key: "answer",
      type: "multiSelect",
      label: "Pick targets",
      required: true,
      options: [
        { value: "Staging", label: "Staging" },
        { value: "Production", label: "Production" },
      ],
    });
    expect(fields[0]).not.toHaveProperty("submitOnSelect");

    const emittedEffect = s.outputs
      .flatMap((output) => output.effects)
      .find((effect) => effect.effectId === ids.invocationEffect("tc-q"));
    expect(emittedEffect).toMatchObject({
      kind: "channel_call",
      method: "feedback_form",
      purpose: "ask-user",
    });
  });
});

describe("channel tools", () => {
  it("routes roster participant methods over the channel transport", () => {
    const s = scenario({
      roster: {
        participants: [
          {
            participantId: "panel:user",
            ref: { kind: "panel", id: "panel:user", participantId: "panel:user" },
            type: "panel",
            methods: [{ name: "eval" }],
          },
        ],
      },
    });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-e", name: "eval", arguments: { code: "1+1" } }],
      stopReason: "completed",
    });
    const started = s.log.find((row) => row.envelopeId === ids.invocationStart("tc-e"))!;
    expect(started.payload).toMatchObject({
      transport: {
        kind: "channel",
        channelId: "chan-1",
        transportCallId: ids.transportCallId("tc-e"),
        target: { participantId: "panel:user" },
      },
    });
    const effects = derivePendingEffects(s.state);
    expect(effects).toEqual([
      expect.objectContaining({ kind: "channel_call", method: "eval" }),
    ]);
  });
});

describe("wake / recovery (C-wake)", () => {
  it("fails an orphan in-flight model call and retries with a fresh attempt", () => {
    const s = scenario();
    prompt(s);
    // crash: wipe the harness's effect registry (the outbox analogue)
    s.effects.clear();
    dispatch(s, { type: "command", command: { kind: "wake" } });

    expect(
      s.log.some(
        (row) =>
          row.payloadKind === "message.failed" && row.envelopeId === ids.messageTerminal(msg0)
      )
    ).toBe(true);
    expect(s.log.find((row) => row.envelopeId === ids.messageTerminal(msg0))?.publish).toBe(true);
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toEqual([ids.modelEffect(msg1)]);
  });

  it("NEVER re-emits a model call while a failed attempt's invocation is non-terminal", () => {
    const s = scenario();
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      stopReason: "completed",
    });
    // crash before the tool resolves
    s.effects.clear();
    dispatch(s, { type: "command", command: { kind: "wake" } });

    // the pending invocation re-derives; NO new model_call (the guard)
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);
    expect(derivePendingEffects(s.state).map((effect) => effect.kind)).toEqual(["local_tool"]);
  });

  it("starts a turn from a pendingPrompt on wake", () => {
    const s = scenario();
    // a user message arrives but the driver crashed before stepping the prompt:
    applyAppend(s, [
      {
        envelopeId: "recv:chan-1:env-9",
        payloadKind: "message.completed",
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ type: "text", content: "hi" }],
          outcome: "completed",
        },
        causality: { messageId: "recv:chan-1:env-9" as never },
      },
    ]);
    expect(s.state.pendingPrompt).not.toBeNull();
    dispatch(s, { type: "command", command: { kind: "wake" } });
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s)).toHaveLength(1);
  });
});

describe("credential wait", () => {
  it("suspension terminates the placeholder model message, keeps the turn open, and resumes", () => {
    const s = scenario();
    prompt(s);
    // model suspends on credentials: step-level events come from the driver;
    // simulate the journaled message terminal + wait marker
    applyAppend(s, [
      {
        envelopeId: ids.messageTerminal(msg0),
        payloadKind: "message.failed",
        payload: {
          protocol: "agentic.trajectory.v1",
          reason: "model_credential_required",
          recoverable: true,
        },
        causality: { messageId: msg0 as never },
        publish: true,
      },
      {
        envelopeId: ids.systemEvent(ids.credKey("chan-1", "anthropic"), "started"),
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "credential.wait_started",
          messageId: msg0,
          details: {
            kind: "credential.wait_started",
            credKey: ids.credKey("chan-1", "anthropic"),
            providerId: "anthropic",
            messageId: msg0,
            connectSpec: { providerId: "anthropic" },
            expiresAt: "2026-05-20T12:10:00.000Z",
          },
        },
        causality: { turnId: turn1, messageId: msg0 as never },
      },
    ]);
    expect(s.state.openTurn).not.toBeNull();
    expect(s.state.inFlightModelCall).toBeNull();
    expect(Object.keys(s.state.pendingCredentialWaits)).toHaveLength(1);
    expect(s.log.filter((row) => row.payloadKind === "turn.closed")).toHaveLength(0);
    // the wait derives a credential_wait effect
    expect(derivePendingEffects(s.state).map((effect) => effect.kind)).toEqual([
      "credential_wait",
    ]);

    // resolution event arrives → wait cleared, model restarts
    const resolved = applyAppend(s, [
      {
        envelopeId: ids.systemEvent(ids.credKey("chan-1", "anthropic"), "resolved"),
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "credential.wait_resolved",
          details: {
            kind: "credential.wait_resolved",
            credKey: ids.credKey("chan-1", "anthropic"),
            providerId: "anthropic",
            resolved: true,
          },
        },
        causality: { turnId: turn1 },
      },
    ]);
    for (const envelope of resolved) dispatch(s, { type: "event-appended", envelope });
    expect(Object.keys(s.state.pendingCredentialWaits)).toHaveLength(0);
    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toContain(ids.modelEffect(msg1));
  });
});

describe("fork policy", () => {
  it("settles pre-cut pendings and closes the inherited open turn on first wake", () => {
    // Build a parent-state scenario, then re-create as a forked head.
    const parent = scenario();
    prompt(parent);
    resolveEffect(parent, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
      stopReason: "completed",
    });
    // fork at the current seq: child inherits the open turn + pending invocation
    const forkSeq = parent.state.lastSeq;
    const child = createScenario({
      state: { ...parent.state, forkSeq },
      policies: defaultPolicies(),
    });
    child.log = [...parent.log];

    dispatch(child, { type: "command", command: { kind: "wake" } });

    const abandoned = child.log.find(
      (row) => row.envelopeId === ids.invocationTerminal("tc-1")
    )!;
    expect(abandoned.payloadKind).toBe("invocation.abandoned");
    expect(abandoned.payload).toMatchObject({ reason: "forked" });
    const closed = child.log.filter((row) => row.payloadKind === "turn.closed");
    expect(closed[closed.length - 1]!.payload).toMatchObject({ reason: "forked" });
    expect(child.state.openTurn).toBeNull();
    expect(pendingEffectIds(child)).toEqual([]);
  });
});

describe("silent policy", () => {
  it("suppresses publication of everything except turn open/close", () => {
    const s = scenario({ policies: [...defaultPolicies(), silentPolicy()] });
    prompt(s);
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "secret" }],
      stopReason: "completed",
    });
    for (const row of s.log) {
      if (row.payloadKind === "turn.opened" || row.payloadKind === "turn.closed") {
        expect(row.publish).toBe(true);
      } else {
        expect(row.publish ?? false).toBe(false);
      }
    }
  });

  it("suppresses executor-side ephemeral signals", () => {
    const silent = silentPolicy();
    expect(
      silent.filterEphemeral?.({
        state: {} as never,
        emit: {
          kind: "signal-event",
          channelId: "chan-1",
          event: { kind: "message.delta" } as never,
        },
      })
    ).toBeNull();
  });
});

describe("determinism properties", () => {
  function runTwice(run: (s: Scenario) => void): [Scenario, Scenario] {
    const a = scenario();
    const b = scenario();
    run(a);
    run(b);
    return [a, b];
  }

  it("same scenario twice yields byte-identical ids and state", () => {
    const [a, b] = runTwice((s) => {
      prompt(s);
      resolveEffect(s, ids.modelEffect(msg0), {
        kind: "model",
        blocks: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
        stopReason: "completed",
      });
      resolveEffect(s, ids.invocationEffect("tc-1"), { kind: "tool", result: null, isError: false });
    });
    expect(JSON.stringify(a.log)).toBe(JSON.stringify(b.log));
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it("duplicate append of a deterministic id is a replay no-op", () => {
    const s = scenario();
    prompt(s);
    const before = s.log.length;
    applyAppend(s, [
      {
        envelopeId: ids.turnOpened(turn1),
        payloadKind: "turn.opened",
        payload: { protocol: "agentic.trajectory.v1" },
        causality: { turnId: turn1 },
      },
    ]);
    expect(s.log.length).toBe(before);
  });

  it("message.delta is rejected by the fold (signal-only transport)", () => {
    const s = scenario();
    expect(() =>
      applyAppend(s, [
        {
          envelopeId: "delta-1",
          payloadKind: "message.delta",
          payload: { protocol: "agentic.trajectory.v1", blockId: "b", type: "text", text: "x" },
          causality: { messageId: "m" as never },
        },
      ])
    ).toThrow(/never be appended/u);
  });

  describe("overlayInputConfig (fold-cache reload)", () => {
    it("preserves the fold-derived roster while overlaying input settings", () => {
      // The vessel injects an EMPTY sentinel roster (roster folds from
      // system.event); a naive overlay would wipe the folded roster on every
      // reload and silently break channel tools (AL-6 regression).
      const folded: AgentLoopConfig = {
        ...baseConfig,
        model: "old-model",
        roster: {
          participants: [
            {
              participantId: "panel:x",
              ref: { kind: "panel", id: "panel:x", participantId: "panel:x" },
              methods: [{ name: "eval" }],
            },
          ],
        },
      };
      const input: AgentLoopConfig = {
        ...baseConfig,
        model: "new-model",
        systemPromptHash: "blob:updated",
        activeToolNames: ["read", "write", "eval"],
        roster: { participants: [] }, // empty sentinel from the vessel
      };

      const merged = overlayInputConfig(folded, input);

      // input-owned settings win
      expect(merged.model).toBe("new-model");
      expect(merged.systemPromptHash).toBe("blob:updated");
      expect(merged.activeToolNames).toEqual(["read", "write", "eval"]);
      // fold-owned roster survives the reload
      expect(merged.roster.participants).toHaveLength(1);
      expect(merged.roster.participants[0]!.participantId).toBe("panel:x");
    });
  });
});

describe("agent-loop message delivery (acks, edit/retract, after-turn, flush)", () => {
  const userRef = { kind: "user" as const, id: "panel:user", participantId: "panel:user" };

  function promptWith(
    s: Scenario,
    opts: {
      envelopeId: string;
      sourceMessageId?: string;
      content?: string;
      metadata?: { deliverAfterTurn?: boolean };
    }
  ): void {
    dispatch(s, {
      type: "command",
      command: {
        kind: "prompt",
        channelId: "chan-1",
        source: { envelopeId: opts.envelopeId },
        ...(opts.sourceMessageId ? { sourceMessageId: opts.sourceMessageId } : {}),
        content: opts.content ?? "hello",
        senderRef: userRef,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      },
    });
  }

  function readAcks(s: Scenario): Array<{ messageId: string; turnId?: string }> {
    return s.outputs
      .flatMap((output) => output.effects)
      .filter((effect) => effect.kind === "publish_envelope")
      .map((effect) => {
        const payload = (effect as { payload: Record<string, unknown> }).payload;
        const causality = (payload["causality"] ?? {}) as Record<string, unknown>;
        const inner = (payload["payload"] ?? {}) as Record<string, unknown>;
        return { messageId: String(causality["messageId"]), turnId: inner["turnId"] as string };
      });
  }

  it("emits a read ack when a fresh prompt is folded into a model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    const acks = readAcks(s);
    expect(acks.map((ack) => ack.messageId)).toContain("u1");
    expect(acks.find((ack) => ack.messageId === "u1")?.turnId).toBe(turn1);
  });

  it("fires the read ack for a mid-turn-steered message on the continuation model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    // steer arrives while the first model call is in flight → queued, no ack yet
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "more",
        senderRef: userRef,
      },
    });
    expect(readAcks(s).map((ack) => ack.messageId)).not.toContain("s1");
    // model completes text-only with a steer queued → continuation consumes it
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "ok" }],
      stopReason: "completed",
    });
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");
  });

  it("holds an after-turn message out of context and fires NO extra model call", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    const before = pendingEffectIds(s);
    const outputsBefore = s.outputs.length;
    promptWith(s, {
      envelopeId: "env-2",
      sourceMessageId: "d1",
      content: "later",
      metadata: { deliverAfterTurn: true },
    });
    // recv appended, but no NEW model_call effect and no context entry
    expect(pendingEffectIds(s)).toEqual(before);
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d1"]);
    expect(s.state.entries.some((e) => e.kind === "user" && e.sourceMessageId === "d1")).toBe(false);
    const newModelCalls = s.outputs
      .slice(outputsBefore)
      .flatMap((o) => o.effects)
      .filter((e) => e.kind === "model_call");
    expect(newModelCalls).toHaveLength(0);
  });

  it("promotes deferred messages one-per-turn after each close, with fresh envelope ids", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    promptWith(s, { envelopeId: "env-2", sourceMessageId: "d1", metadata: { deliverAfterTurn: true } });
    promptWith(s, { envelopeId: "env-3", sourceMessageId: "d2", metadata: { deliverAfterTurn: true } });
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d1", "d2"]);

    // first turn closes → promote d1 into its own fresh turn
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "text", content: "done" }],
      stopReason: "completed",
    });
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d2"]);
    expect(s.state.openTurn).not.toBeNull();
    // promoted recv used a fresh deterministic id (not the arrival env-2)
    expect(s.log.some((row) => row.envelopeId.startsWith("recv:promoted:d1:"))).toBe(true);

    // d1's turn closes → promote d2
    const d1Msg = ids.messageId(s.state.openTurn!.turnId, 0);
    resolveEffect(s, ids.modelEffect(d1Msg), {
      kind: "model",
      blocks: [{ type: "text", content: "done d1" }],
      stopReason: "completed",
    });
    expect(s.state.deferredPostTurnQueue).toHaveLength(0);
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toEqual(
      expect.arrayContaining(["u1", "d1", "d2"])
    );
  });

  it("edits queued steer content before read", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "first",
        senderRef: userRef,
      },
    });
    dispatch(s, {
      type: "command",
      command: { kind: "edit", sourceMessageId: "s1", blocks: [{ type: "text", content: "edited" }], by: userRef },
    });
    const entry = s.state.steeringQueue.find((e) => e.sourceMessageId === "s1");
    expect((entry?.content as { blocks?: unknown }).blocks).toEqual([{ type: "text", content: "edited" }]);
  });

  it("no-ops an edit/retract after the message was read (consumed into context)", () => {
    const s = scenario();
    // u1 is folded into the first model call → consumed (read); only in entries.
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1", content: "original" });
    const entryBefore = s.state.entries.find(
      (e) => e.kind === "user" && e.sourceMessageId === "u1"
    );
    expect(entryBefore).toBeDefined();
    dispatch(s, {
      type: "command",
      command: { kind: "edit", sourceMessageId: "u1", blocks: [{ type: "text", content: "x" }], by: userRef },
    });
    dispatch(s, {
      type: "command",
      command: { kind: "retract", sourceMessageId: "u1", by: userRef },
    });
    // read wins: the consumed entry is untouched, never removed.
    const entryAfter = s.state.entries.find(
      (e) => e.kind === "user" && e.sourceMessageId === "u1"
    );
    expect(entryAfter).toEqual(entryBefore);
  });

  it("retracts a queued steer before read", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "oops",
        senderRef: userRef,
      },
    });
    expect(s.state.steeringQueue).toHaveLength(1);
    dispatch(s, {
      type: "command",
      command: { kind: "retract", sourceMessageId: "s1", by: userRef },
    });
    expect(s.state.steeringQueue).toHaveLength(0);
  });

  it("flush with queued steers delivers the steers and leaves the deferred queue intact", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "now",
        senderRef: userRef,
      },
    });
    promptWith(s, { envelopeId: "env-3", sourceMessageId: "d1", metadata: { deliverAfterTurn: true } });
    // flush: steers present + model in flight → soft flush marker
    dispatch(s, { type: "command", command: { kind: "interrupt", flushDeferred: true } });
    expect(s.state.openTurn?.pendingFlush).toBe("steers");
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d1"]);
    // aborted model terminal → continuation consumes the steer (turn stays open)
    resolveEffect(s, ids.modelEffect(msg0), { kind: "model", blocks: [], stopReason: "aborted" });
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d1"]);
  });

  it("allows repeated soft flushes in the same turn", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "first steer",
        senderRef: userRef,
      },
    });

    dispatch(s, { type: "command", command: { kind: "interrupt", flushDeferred: true } });
    const firstFlushId = s.log.find(
      (row) => row.payloadKind === "system.event" && row.envelopeId.includes("flush-steers")
    )?.envelopeId;
    expect(firstFlushId).toBeDefined();
    expect(s.state.openTurn?.pendingFlush).toBe("steers");
    resolveEffect(s, ids.modelEffect(msg0), { kind: "model", blocks: [], stopReason: "aborted" });
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s1");

    const msg1 = ids.messageId(turn1, 1);
    expect(pendingEffectIds(s)).toContain(ids.modelEffect(msg1));
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-3" },
        sourceMessageId: "s2",
        content: "second steer",
        senderRef: userRef,
      },
    });

    dispatch(s, { type: "command", command: { kind: "interrupt", flushDeferred: true } });
    const flushIds = s.log
      .filter((row) => row.payloadKind === "system.event" && row.envelopeId.includes("flush-steers"))
      .map((row) => row.envelopeId);
    expect(flushIds).toHaveLength(2);
    expect(flushIds[1]).not.toBe(firstFlushId);
    expect(s.state.openTurn?.pendingFlush).toBe("steers");

    resolveEffect(s, ids.modelEffect(msg1), { kind: "model", blocks: [], stopReason: "aborted" });
    expect(s.state.openTurn).not.toBeNull();
    expect(readAcks(s).map((ack) => ack.messageId)).toContain("s2");
  });

  it("flush against a turn waiting on a pending invocation cancels it and delivers the steers", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    // The model parks on a tool call (e.g. a feedback form) — the invocation
    // stays pending, no model in flight, so wakeGuard is unsatisfied.
    resolveEffect(s, ids.modelEffect(msg0), {
      kind: "model",
      blocks: [{ type: "toolCall", id: "tc-1", name: "feedback_form", arguments: {} }],
      stopReason: "completed",
    });
    expect(pendingEffectIds(s)).toEqual([ids.invocationEffect("tc-1")]);
    expect(s.state.openTurn).not.toBeNull();
    // Queue a steer while blocked → lands in the steering queue (no ack yet).
    dispatch(s, {
      type: "command",
      command: {
        kind: "steer",
        channelId: "chan-1",
        source: { envelopeId: "env-2" },
        sourceMessageId: "s1",
        content: "actually do X",
        senderRef: userRef,
      },
    });
    expect(s.state.steeringQueue.map((e) => e.sourceMessageId)).toEqual(["s1"]);
    // Flush ("Send now"): abandon the pending form + deliver the steer.
    dispatch(s, { type: "command", command: { kind: "interrupt", flushDeferred: true } });
    // The pending invocation was cancelled (a valid cancelled tool-result)...
    const cancelled = s.log.find((r) => r.payloadKind === "invocation.cancelled");
    expect(cancelled).toBeTruthy();
    // ...and the cancel carries the transportCallId the provider knows, so a
    // panel feedback form can correlate it and dismiss (not linger on screen).
    expect((cancelled!.causality as { transportCallId?: string }).transportCallId).toBe(
      ids.transportCallId("tc-1")
    );
    // ...a fresh turn opened that folds + read-acks the steer, and the steer
    // queue drained — i.e. the agent actually makes progress.
    expect(readAcks(s).map((a) => a.messageId)).toContain("s1");
    expect(s.state.steeringQueue).toEqual([]);
    expect(s.state.openTurn).not.toBeNull();
    expect(pendingEffectIds(s).some((id) => id.includes("model"))).toBe(true);
  });

  it("flush with no steers promotes exactly one deferred head per flush", () => {
    const s = scenario();
    promptWith(s, { envelopeId: "env-1", sourceMessageId: "u1" });
    promptWith(s, { envelopeId: "env-2", sourceMessageId: "d1", metadata: { deliverAfterTurn: true } });
    promptWith(s, { envelopeId: "env-3", sourceMessageId: "d2", metadata: { deliverAfterTurn: true } });
    // flush: no steers, model in flight, deferred present → hard interrupt + close
    dispatch(s, { type: "command", command: { kind: "interrupt", flushDeferred: true } });
    resolveEffect(s, ids.modelEffect(msg0), { kind: "model", blocks: [], stopReason: "aborted" });
    // one head promoted into a fresh turn; the other still queued
    expect(s.state.deferredPostTurnQueue.map((d) => d.sourceMessageId)).toEqual(["d2"]);
    expect(s.state.openTurn).not.toBeNull();
  });
});
