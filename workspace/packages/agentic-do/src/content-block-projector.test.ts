/**
 * Tests for ContentBlockProjector and its pure mapper piEventToChannelOps.
 *
 * The projector owns the translation from pi-agent-core AgentEvents to
 * channel ops (one channel message per Pi content block). These tests
 * drive synthetic Pi event traces — representative of the real streams —
 * through the pure mapper and check the emitted ops.
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  ContentBlockProjector,
  type ChannelOp,
  type ProjectorSink,
  type ProjectorState,
  createInitialProjectorState,
  piEventToChannelOps,
} from "./content-block-projector.js";

// ─── Test doubles ────────────────────────────────────────────────────────────

interface MockSink extends ProjectorSink {
  ops: ChannelOp[];
  errors: Array<{ msgId: string; message: string; code?: string }>;
}

function makeSink(opts?: { failOn?: (op: ChannelOp) => boolean }): MockSink {
  const ops: ChannelOp[] = [];
  const errors: Array<{ msgId: string; message: string; code?: string }> = [];
  const maybeFail = (op: ChannelOp) => {
    if (opts?.failOn?.(op)) throw new Error(`mock failure: ${op.kind}`);
  };
  return {
    ops,
    errors,
    async send(msgId, content, o) {
      const op: ChannelOp = {
        kind: "send",
        msgId,
        content,
        contentType: o?.contentType,
        ...(o?.attachments ? { attachments: o.attachments } : {}),
      };
      ops.push(op);
      maybeFail(op);
    },
    async update(msgId, content, o) {
      const op: ChannelOp = {
        kind: "update",
        msgId,
        content,
        ...(o?.append ? { append: true } : {}),
      };
      ops.push(op);
      maybeFail(op);
    },
    async complete(msgId) {
      const op: ChannelOp = { kind: "complete", msgId };
      ops.push(op);
      maybeFail(op);
    },
    setTyping(on) {
      ops.push({ kind: "typing", on });
    },
    async error(msgId, message, code) {
      errors.push({ msgId, message, ...(code ? { code } : {}) });
    },
  };
}

/** Deterministic msgId allocator for golden traces. */
function makeAllocator(): () => string {
  let n = 0;
  return () => `m${++n}`;
}

function runTrace(events: AgentEvent[]): ChannelOp[] {
  let state: ProjectorState = createInitialProjectorState();
  const alloc = makeAllocator();
  const allOps: ChannelOp[] = [];
  for (const ev of events) {
    const { newState, ops } = piEventToChannelOps(ev, state, alloc);
    state = newState;
    allOps.push(...ops);
  }
  return allOps;
}

// ─── Pi event builders (minimal shape the projector actually reads) ─────────

function ev<T extends AgentEvent>(partial: T): T {
  return partial;
}

function assistantMsgStart(): AgentEvent {
  return ev({
    type: "message_start",
    message: { role: "assistant", content: [] } as never,
  });
}

function assistantMsgEnd(): AgentEvent {
  return ev({
    type: "message_end",
    message: { role: "assistant", content: [] } as never,
  });
}

function textStart(contentIndex: number): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "text_start", contentIndex } as never,
  });
}

function textDelta(contentIndex: number, delta: string): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "text_delta", contentIndex, delta } as never,
  });
}

function textEnd(contentIndex: number): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "text_end", contentIndex } as never,
  });
}

function thinkingStart(contentIndex: number): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "thinking_start", contentIndex } as never,
  });
}

function thinkingDelta(contentIndex: number, delta: string): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } as never,
  });
}

function thinkingEnd(contentIndex: number): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: { type: "thinking_end", contentIndex } as never,
  });
}

function toolcallStart(
  contentIndex: number,
  tc: { id: string; name: string; arguments: Record<string, unknown> },
): AgentEvent {
  // toolcall_start reads the partial message's content[contentIndex] to
  // pick up the in-flight toolCall block shape.
  const partial = {
    role: "assistant",
    content: [
      ...Array(contentIndex).fill({ type: "text", text: "" }),
      { type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments },
    ],
  };
  return ev({
    type: "message_update",
    message: partial as never,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex,
      partial,
    } as never,
  });
}

function toolcallEnd(
  contentIndex: number,
  tc: { id: string; name: string; arguments: Record<string, unknown> },
): AgentEvent {
  return ev({
    type: "message_update",
    message: { role: "assistant", content: [] } as never,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex,
      toolCall: tc,
    } as never,
  });
}

function toolExecEnd(toolCallId: string, result: unknown, isError = false): AgentEvent {
  return ev({
    type: "tool_execution_end",
    toolCallId,
    toolName: "t",
    result,
    isError,
  } as never);
}

function toolExecUpdate(toolCallId: string, consoleLine: string): AgentEvent {
  return ev({
    type: "tool_execution_update",
    toolCallId,
    toolName: "t",
    args: {},
    partialResult: { details: { type: "console", content: consoleLine } },
  } as never);
}

function agentEnd(stopReason?: "stop" | "error" | "aborted" | "toolUse" | "length"): AgentEvent {
  const messages = stopReason
    ? [{ role: "assistant", content: [], stopReason }]
    : [];
  return ev({ type: "agent_end", messages: messages as never });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("piEventToChannelOps — text-only turn", () => {
  it("streams a single text block via send → update → complete", () => {
    const ops = runTrace([
      assistantMsgStart(),
      textStart(0),
      textDelta(0, "Hel"),
      textDelta(0, "lo"),
      textEnd(0),
      assistantMsgEnd(),
    ]);
    expect(ops).toEqual([
      { kind: "send", msgId: "m1", content: "", contentType: undefined },
      { kind: "update", msgId: "m1", content: "Hel" },
      { kind: "update", msgId: "m1", content: "lo" },
      { kind: "complete", msgId: "m1" },
    ]);
  });

  it("drops message_start for non-assistant roles", () => {
    const ops = runTrace([
      ev({
        type: "message_start",
        message: { role: "user", content: [] } as never,
      }),
    ]);
    expect(ops).toEqual([]);
  });
});

describe("piEventToChannelOps — thinking + text", () => {
  it("thinking uses contentType: thinking + append flag on deltas", () => {
    const ops = runTrace([
      assistantMsgStart(),
      thinkingStart(0),
      thinkingDelta(0, "Let me "),
      thinkingDelta(0, "think."),
      thinkingEnd(0),
      textStart(1),
      textDelta(1, "Answer."),
      textEnd(1),
      assistantMsgEnd(),
    ]);
    expect(ops).toEqual([
      { kind: "send", msgId: "m1", content: "", contentType: "thinking" },
      { kind: "update", msgId: "m1", content: "Let me ", append: true },
      { kind: "update", msgId: "m1", content: "think.", append: true },
      { kind: "complete", msgId: "m1" },
      { kind: "send", msgId: "m2", content: "", contentType: undefined },
      { kind: "update", msgId: "m2", content: "Answer." },
      { kind: "complete", msgId: "m2" },
    ]);
  });
});

describe("piEventToChannelOps — tool-only turn", () => {
  it("emits toolCall payload at start, updates on execution, completes at end", () => {
    const tc = { id: "tc1", name: "Read", arguments: { path: "a.ts" } };
    const ops = runTrace([
      assistantMsgStart(),
      toolcallStart(0, tc),
      toolcallEnd(0, tc),
      assistantMsgEnd(),
      toolExecUpdate("tc1", "reading..."),
      toolExecEnd("tc1", { ok: true }, false),
    ]);

    // Initial send at toolcall_start
    expect(ops[0]!.kind).toBe("send");
    const send = ops[0] as ChannelOp & { kind: "send" };
    expect(send.contentType).toBe("toolCall");
    expect(send.msgId).toBe("m1");
    const startPayload = JSON.parse(send.content);
    expect(startPayload.name).toBe("Read");
    expect(startPayload.execution.status).toBe("pending");

    // toolcall_end → update with finalized args
    expect(ops[1]!.kind).toBe("update");

    // tool_execution_update → update with consoleOutput
    expect(ops[2]!.kind).toBe("update");
    const consoleUpd = ops[2] as ChannelOp & { kind: "update" };
    expect(JSON.parse(consoleUpd.content).execution.consoleOutput).toBe("reading...");

    // tool_execution_end → update with complete + complete op
    expect(ops[3]!.kind).toBe("update");
    const finalUpd = ops[3] as ChannelOp & { kind: "update" };
    const finalPayload = JSON.parse(finalUpd.content);
    expect(finalPayload.execution.status).toBe("complete");
    expect(finalPayload.execution.result).toEqual({ ok: true });
    expect(ops[4]).toEqual({ kind: "complete", msgId: "m1" });
  });

  it("tool_execution_end with isError → status=error", () => {
    const tc = { id: "tc1", name: "Read", arguments: {} };
    const ops = runTrace([
      toolcallStart(0, tc),
      toolExecEnd("tc1", "oops", true),
    ]);
    const finalUpd = ops[1] as ChannelOp & { kind: "update" };
    const payload = JSON.parse(finalUpd.content);
    expect(payload.execution.status).toBe("error");
    expect(payload.execution.isError).toBe(true);
  });

  it("tool result images fold into execution.resultImages", () => {
    const tc = { id: "tc1", name: "Read", arguments: {} };
    const result = {
      content: [
        { type: "text", text: "preview" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
    };
    const ops = runTrace([
      toolcallStart(0, tc),
      toolExecEnd("tc1", result, false),
    ]);
    const finalUpd = ops[1] as ChannelOp & { kind: "update" };
    const payload = JSON.parse(finalUpd.content);
    expect(payload.execution.resultImages).toEqual([
      { mimeType: "image/png", data: "AAAA" },
    ]);
  });
});

describe("piEventToChannelOps — mixed text → toolCall → text", () => {
  it("keeps each text block streaming live and tool in between", () => {
    const tc = { id: "tc1", name: "Read", arguments: {} };
    const ops = runTrace([
      assistantMsgStart(),
      textStart(0),
      textDelta(0, "first"),
      textEnd(0),
      toolcallStart(1, tc),
      toolcallEnd(1, tc),
      textStart(2),
      textDelta(2, "second"),
      textEnd(2),
      assistantMsgEnd(),
      toolExecEnd("tc1", "ok", false),
    ]);

    const msgIds = ops.map((o) => ("msgId" in o ? o.msgId : ""));
    // Distinct channel messages for each block
    expect(new Set(msgIds.filter((x) => x))).toEqual(new Set(["m1", "m2", "m3"]));
    // First text completes before the second text starts
    expect(ops.findIndex((o) => o.kind === "complete" && o.msgId === "m1"))
      .toBeLessThan(ops.findIndex((o) => o.kind === "send" && o.msgId === "m3"));
  });
});

describe("piEventToChannelOps — parallel tool calls", () => {
  it("each tool gets its own channel message", () => {
    const a = { id: "tcA", name: "Read", arguments: { path: "a" } };
    const b = { id: "tcB", name: "Edit", arguments: { path: "b" } };
    const ops = runTrace([
      toolcallStart(0, a),
      toolcallStart(1, b),
      toolExecEnd("tcA", "okA", false),
      toolExecEnd("tcB", "okB", false),
    ]);
    const sends = ops.filter((o) => o.kind === "send");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.msgId).toBe("m1");
    expect(sends[1]!.msgId).toBe("m2");
    // Each tool's execution_end references its own msgId.
    const completes = ops.filter((o) => o.kind === "complete").map((o) => o.msgId);
    expect(new Set(completes)).toEqual(new Set(["m1", "m2"]));
  });
});

describe("piEventToChannelOps — agent_end", () => {
  it("emits typing off on a clean stop", () => {
    const ops = runTrace([agentEnd("stop")]);
    expect(ops).toEqual([{ kind: "typing", on: false }]);
  });

  it("emits typing off even when stopReason absent (legacy traces)", () => {
    const ops = runTrace([agentEnd()]);
    expect(ops).toEqual([{ kind: "typing", on: false }]);
  });
});

describe("ContentBlockProjector — channel op failure surfacing", () => {
  it("emits channel.error for a failed op and drops subsequent ops on the same msgId", async () => {
    const sink = makeSink({
      failOn: (op) => op.kind === "update" && "msgId" in op && op.msgId === "m1",
    });
    const projector = new ContentBlockProjector(sink, makeAllocator());

    await projector.handleEvent(textStart(0));
    await projector.handleEvent(textDelta(0, "hi"));
    // At this point the update rejected and the msgId is poisoned.
    await projector.handleEvent(textDelta(0, "more"));
    await projector.handleEvent(textEnd(0));

    // Exactly one error emitted for m1.
    expect(sink.errors).toHaveLength(1);
    expect(sink.errors[0]!.msgId).toBe("m1");
    expect(sink.errors[0]!.message).toMatch(/update/);

    // The first failing update was attempted; the subsequent update + complete
    // should be short-circuited by the poison set (not pushed to ops).
    const updateCount = sink.ops.filter((o) => o.kind === "update" && "msgId" in o && o.msgId === "m1").length;
    const completeCount = sink.ops.filter((o) => o.kind === "complete" && o.msgId === "m1").length;
    expect(updateCount).toBe(1);
    expect(completeCount).toBe(0);
  });

  it("failure on one msgId does not poison other channel messages", async () => {
    const sink = makeSink({
      failOn: (op) => op.kind === "send" && "msgId" in op && op.msgId === "m1",
    });
    const projector = new ContentBlockProjector(sink, makeAllocator());

    await projector.handleEvent(textStart(0));       // m1 — send fails
    await projector.handleEvent(thinkingStart(1));   // m2 — send succeeds
    await projector.handleEvent(thinkingDelta(1, "x"));
    await projector.handleEvent(thinkingEnd(1));

    // m1 errored; m2 completed normally.
    expect(sink.errors.map((e) => e.msgId)).toEqual(["m1"]);
    const m2Ops = sink.ops.filter((o) => "msgId" in o && o.msgId === "m2").map((o) => o.kind);
    expect(m2Ops).toEqual(["send", "update", "complete"]);
  });
});

describe("ContentBlockProjector — error/abort auto-close", () => {
  it("auto-closes in-flight blocks on agent_end with stopReason=error", async () => {
    const sink = makeSink();
    const projector = new ContentBlockProjector(sink, makeAllocator());

    await projector.handleEvent(textStart(0));
    await projector.handleEvent(textDelta(0, "part"));
    // No text_end — simulate runner failure mid-stream.
    await projector.handleEvent(agentEnd("error"));

    const kinds = sink.ops.map((o) => o.kind);
    expect(kinds).toContain("typing");
    // The open text block must receive a complete op despite no text_end event.
    const completes = sink.ops.filter((o) => o.kind === "complete");
    expect(completes.map((o) => o.msgId)).toContain("m1");
  });

  it("auto-closes in-flight toolCall on agent_end with stopReason=aborted", async () => {
    const sink = makeSink();
    const projector = new ContentBlockProjector(sink, makeAllocator());

    await projector.handleEvent(
      toolcallStart(0, { id: "tc", name: "Read", arguments: {} }),
    );
    // No tool_execution_end — aborted mid-execution.
    await projector.handleEvent(agentEnd("aborted"));

    const completes = sink.ops.filter((o) => o.kind === "complete");
    expect(completes.map((o) => o.msgId)).toContain("m1");
  });

  it("does NOT auto-close on a clean agent_end (stopReason=stop)", async () => {
    const sink = makeSink();
    const projector = new ContentBlockProjector(sink, makeAllocator());

    await projector.handleEvent(textStart(0));
    await projector.handleEvent(textDelta(0, "part"));
    // Happy path: text_end fires normally.
    await projector.handleEvent(textEnd(0));
    sink.ops.length = 0;
    await projector.handleEvent(agentEnd("stop"));

    // Only typing op; no synthetic completes.
    expect(sink.ops).toEqual([{ kind: "typing", on: false }]);
  });
});

// ─── ContentBlockProjector (stateful) ────────────────────────────────────────

describe("ContentBlockProjector", () => {
  it("dispatches ops in order through the sink (back-pressure honored)", async () => {
    const sink = makeSink();
    const alloc = makeAllocator();
    const projector = new ContentBlockProjector(sink, alloc);

    await projector.handleEvent(textStart(0));
    await projector.handleEvent(textDelta(0, "hi"));
    await projector.handleEvent(textEnd(0));

    expect(sink.ops.map((o) => o.kind)).toEqual(["send", "update", "complete"]);
    expect(sink.ops[0]).toMatchObject({ msgId: "m1" });
  });

  it("closeAll completes every in-flight block and does NOT toggle typing", async () => {
    const sink = makeSink();
    const alloc = makeAllocator();
    const projector = new ContentBlockProjector(sink, alloc);

    // Start text, thinking, and toolCall — none completed.
    await projector.handleEvent(textStart(0));
    await projector.handleEvent(thinkingStart(1));
    await projector.handleEvent(
      toolcallStart(2, { id: "tc", name: "Read", arguments: {} }),
    );

    sink.ops.length = 0; // ignore prior send ops for this assertion
    await projector.closeAll();

    const kinds = sink.ops.map((o) => o.kind);
    // 3 completes, one per open block. No typing op.
    expect(kinds.filter((k) => k === "complete")).toHaveLength(3);
    expect(kinds).not.toContain("typing");
  });

  it("closeAll skips tool calls already in terminal state", async () => {
    const sink = makeSink();
    const alloc = makeAllocator();
    const projector = new ContentBlockProjector(sink, alloc);

    const tc = { id: "tc", name: "Read", arguments: {} };
    await projector.handleEvent(toolcallStart(0, tc));
    await projector.handleEvent(toolExecEnd("tc", "ok", false));

    sink.ops.length = 0;
    await projector.closeAll();
    expect(sink.ops).toEqual([]);
  });
});
