import { describe, expect, it } from "vitest";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  createInitialChannelViewState,
  reduceChannelView,
  type AgenticEvent,
  type ApprovalId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type InvocationId,
  type MessageId,
  type TurnId,
} from "@workspace/agentic-protocol";
import { actionBarPayloadFromChannelView, chatMessagesFromChannelView } from "./channel-chat-merge.js";

const agent = { kind: "agent" as const, id: "agent-1", displayName: "Agent One" };
const participant = { ...agent, participantId: "participant-agent-1" };

function envelope(payload: AgenticEvent, seq: number): ChannelEnvelope<AgenticEvent> {
  return {
    envelopeId: brandId<EnvelopeId>(`env-${seq}`),
    channelId: brandId<ChannelId>("channel-1"),
    seq,
    from: participant,
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload,
    publishedAt: payload.createdAt,
  };
}

describe("chatMessagesFromChannelView", () => {
  it("projects typed channel events into transcript chat messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "done" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "read_file", request: { path: "README.md" } },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, result: "contents" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(message, 1), envelope(started, 2), envelope(completed, 3)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    const chatMessages = chatMessagesFromChannelView(state);
    expect(chatMessages.map((chatMessage) => chatMessage.id)).toEqual([
      "msg-1",
      "invocation:inv-1",
    ]);
    expect(chatMessages[0]).toMatchObject({
      senderId: "agent-1",
      content: "done",
      complete: true,
    });
    expect(chatMessages[1]).toMatchObject({
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "inv-1",
        name: "read_file",
        arguments: { path: "README.md" },
        execution: { status: "complete", result: "contents" },
      },
    });
  });

  it("preserves invocation name and arguments when only completion is projected", () => {
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          toolCallId: "call-1",
          toolName: "eval",
          details: { input: { code: "1 + 1" } },
          content: [{ type: "text", text: "2" }],
        },
        summary: "2",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(completed, 1)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "call-1",
        name: "eval",
        arguments: { code: "1 + 1" },
        execution: { status: "complete" },
      },
    });
  });

  it("projects invocation progress, output, and errors without losing the exact invocation name", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "shell.exec",
        request: { cmd: "pnpm test" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const progress: AgenticEvent<"invocation.progress"> = {
      kind: "invocation.progress",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        message: "Running tests",
        progress: 0.5,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, output: "stderr line" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-error") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "exit code 1",
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };

    const state = [started, progress, output, failed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(state.invocations["inv-error"]?.progress).toEqual([
      expect.objectContaining({ message: "Running tests", progress: 0.5 }),
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "inv-error",
        name: "shell.exec",
        arguments: { cmd: "pnpm test" },
        execution: {
          status: "error",
          description: "exit code 1",
          consoleOutput: "stderr line",
          isError: true,
        },
      },
    });
  });

  it("preserves provider method names and streamed output across cross-participant invocation events", () => {
    const provider = { kind: "panel" as const, id: "provider-1", displayName: "Provider" };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "mcp__workspace__ListDirectory",
        request: { path: "src" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const output: AgenticEvent<"invocation.output"> = {
      kind: "invocation.output",
      actor: provider,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        output: "src/index.ts",
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-provider") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: {
          toolCallId: "inv-provider",
          toolName: "mcp__workspace__ListDirectory",
          details: { input: { path: "src" } },
          content: [{ type: "text", text: "src/index.ts" }],
        },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const providerEnvelope = {
      ...envelope(output, 2),
      from: { ...provider, participantId: "provider-1" },
    };
    const state = [envelope(started, 1), providerEnvelope, envelope(completed, 3)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "inv-provider",
        name: "mcp__workspace__ListDirectory",
        arguments: { path: "src" },
        execution: {
          status: "complete",
          consoleOutput: "src/index.ts",
        },
      },
    });
  });

  it("keeps one canonical invocation card across duplicate channel starts and late terminal output", () => {
    const startedByModel: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("tool-1") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: { code: "await work()" },
        userVisible: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const startedByChannel: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: { kind: "system", id: "system" },
      causality: { invocationId: brandId<InvocationId>("tool-1"), transportCallId: "transport-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "unknown",
        request: {},
        userVisible: false,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const cancelled: AgenticEvent<"invocation.cancelled"> = {
      kind: "invocation.cancelled",
      actor: { kind: "system", id: "system" },
      causality: { invocationId: brandId<InvocationId>("tool-1"), transportCallId: "transport-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "cancelled",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const lateCompleted: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("tool-1"), transportCallId: "transport-1" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: { ok: true },
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };

    const state = [startedByModel, startedByChannel, cancelled, lateCompleted]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "tool-1",
        name: "eval",
        arguments: { code: "await work()" },
        execution: {
          status: "cancelled",
          description: "cancelled",
        },
      },
    });
  });

  it("projects durable open turns into typing transcript items and removes them when closed", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "done" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const openState = [envelope(opened, 1)].reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(openState)[0]).toMatchObject({
      id: "turn:turn-1",
      contentType: "typing",
      complete: false,
      senderId: "agent-1",
    });

    const closedState = [envelope(opened, 1), envelope(closed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());
    expect(chatMessagesFromChannelView(closedState).some((msg) => msg.contentType === "typing")).toBe(false);
  });

  it("orders open turn typing by the latest event in that turn", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const olderMessage: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: { kind: "user", id: "user-1", displayName: "User One" },
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "user", content: "hi" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const invocation: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { invocationId: brandId<InvocationId>("inv-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "read", request: { path: "skills/onboarding/SKILL.md" } },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, olderMessage, invocation]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "msg-1",
      "invocation:inv-1",
      "turn:turn-1",
    ]);
  });

  it("suppresses open turn typing while an assistant message is streaming in that turn", () => {
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "started" },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId: brandId<TurnId>("turn-1"),
      causality: { messageId: brandId<MessageId>("msg-1") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", content: "partial" },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [opened, started]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual(["msg-1"]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      content: "partial",
      complete: false,
    });
  });

  it("uses failure payload metadata when only a terminal invocation failure is available", () => {
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-terminal-failure") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "permission denied",
        error: {
          toolName: "write_file",
          details: { input: { path: "src/app.ts", content: "updated" } },
        },
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    } as AgenticEvent<"invocation.failed">;

    const state = [envelope(failed, 1)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      contentType: "invocation",
      invocation: {
        id: "inv-terminal-failure",
        name: "write_file",
        arguments: { path: "src/app.ts", content: "updated" },
        execution: {
          status: "error",
          description: "permission denied",
          isError: true,
        },
      },
    });
  });

  it("projects typed inline UI events into inline UI chat messages", () => {
    const rendered: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "ui-1",
        source: { type: "file", path: "skills/setup/Panel.tsx" },
        imports: { react: "19.0.0" },
        props: { step: "connect" },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [envelope(rendered, 1)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "inline-ui:participant-agent-1:ui-1",
      contentType: "inline_ui",
      inlineUi: {
        id: "ui-1",
        source: { type: "file", path: "skills/setup/Panel.tsx" },
        imports: { react: "19.0.0" },
        props: { step: "connect" },
      },
    });
  });

  it("projects typed approval events into approval chat messages", () => {
    const requested: AgenticEvent<"approval.requested"> = {
      kind: "approval.requested",
      actor: agent,
      causality: {
        approvalId: brandId<ApprovalId>("approval-1"),
        invocationId: brandId<InvocationId>("inv-approval"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        question: "Allow tool call?",
        details: { toolName: "write" },
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };
    const resolved: AgenticEvent<"approval.resolved"> = {
      kind: "approval.resolved",
      actor: agent,
      causality: {
        approvalId: brandId<ApprovalId>("approval-1"),
        invocationId: brandId<InvocationId>("inv-approval"),
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        granted: false,
        resolvedBy: agent,
        reason: "User denied tool call",
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    const state = [envelope(requested, 1), envelope(resolved, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "approval:approval-1",
      contentType: "approval",
      complete: true,
      approval: {
        id: "approval-1",
        invocationId: "inv-approval",
        question: "Allow tool call?",
        status: "denied",
        granted: false,
        reason: "User denied tool call",
      },
    });
  });

  it("projects latest typed action bar event into the action bar view model", () => {
    const loaded: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-1",
        source: { type: "file", path: "skills/onboarding/ActionBar.tsx" },
        props: { compact: true },
        maxHeight: 180,
        result: { ok: true },
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [envelope(loaded, 1)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(actionBarPayloadFromChannelView(state)).toEqual({
      id: "bar-1",
      source: { type: "file", path: "skills/onboarding/ActionBar.tsx" },
      props: { compact: true },
      maxHeight: 180,
      result: { ok: true },
    });
  });
});
