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
import {
  actionBarPayloadFromChannelView,
  chatMessagesFromChannelView,
  messageTypeDefinitionsFromChannelView,
} from "./channel-chat-merge.js";

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
  it("projects cleared message type definitions so registry consumers can invalidate compiled modules", () => {
    const registered: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "weather",
        displayMode: "inline",
        source: { type: "code", code: "export default function Weather() { return null; }" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const cleared: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor: agent,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId: "weather" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(registered, 1), envelope(cleared, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(messageTypeDefinitionsFromChannelView(state)).toEqual([
      expect.objectContaining({
        typeId: "weather",
        cleared: true,
        updatedAtSeq: 1,
        clearedAtSeq: 2,
      }),
    ]);
  });

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

  it("projects failed invocation error payloads into copyable expanded error data", () => {
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-grep") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "grep",
        request: {
          path: "packages workers panels",
          pattern: "console",
          glob: "*diagnostic*",
        },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("inv-grep") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "[extensions.invoke] Extension @workspace-extensions/file-tools.grep invocation failed",
        error: {
          text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
          content: [
            {
              type: "text",
              text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
            },
          ],
        },
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [envelope(started, 1), envelope(failed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    const invocation = chatMessagesFromChannelView(state)[0]?.invocation;
    expect(invocation).toMatchObject({
      name: "grep",
      arguments: {
        path: "packages workers panels",
        pattern: "console",
        glob: "*diagnostic*",
      },
      execution: {
        status: "error",
        description: "[extensions.invoke] Extension @workspace-extensions/file-tools.grep invocation failed",
        result: {
          text: "Path not found: /packages workers panels. The `path` argument accepts one directory or file.",
        },
      },
    });
  });

  it("projects assistant thinking blocks as inline thinking messages", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId: brandId<MessageId>("msg-thinking") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "Final answer",
        blocks: [
          { type: "thinking", content: "I should inspect the repo first." },
          { type: "text", content: "Final answer" },
        ],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "thinking:msg-thinking:0",
        contentType: "thinking",
        content: "I should inspect the repo first.",
        complete: true,
      }),
      expect.objectContaining({
        id: "msg-thinking",
        content: "Final answer",
        complete: true,
      }),
    ]);
  });

  it("projects published message.failed reasons as visible transcript errors", () => {
    const messageId = brandId<MessageId>("msg-provider-failed");
    const completed: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "",
        blocks: [],
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const failed: AgenticEvent<"message.failed"> = {
      kind: "message.failed",
      actor: agent,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "provider stream failed",
        recoverable: true,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };

    const state = [envelope(completed, 1), envelope(failed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)).toEqual([
      expect.objectContaining({
        id: "msg-provider-failed",
        content: "provider stream failed",
        error: "provider stream failed",
        complete: true,
      }),
    ]);
  });

  it("surfaces runner-restart no-response turns as lifecycle notices", () => {
    const turnId = brandId<TurnId>("turn-no-response");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-stalled") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "eval", request: { code: "run()" } },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const abandoned: AgenticEvent<"invocation.abandoned"> = {
      kind: "invocation.abandoned",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-stalled") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "Runner restarted before invocation completed" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "runner_restarted" },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, abandoned, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "invocation:inv-stalled",
      "turn:turn-no-response:recovered",
    ]);
    expect(chatMessagesFromChannelView(state)[1]).toMatchObject({
      contentType: "lifecycle",
      kind: "system",
      lifecycle: {
        status: "recovered",
        title: "Recovered after restart",
        detail: "The turn closed cleanly, but there was no assistant response to show.",
      },
      complete: true,
    });
  });

  it("projects restart diagnostics as lifecycle notices", () => {
    const message: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: {
        ...agent,
        metadata: {
          natstackDiagnostic: {
            type: "lifecycle_recovery",
            status: "interrupted",
            title: "Restart interrupted the response",
            detail: "The partial response was discarded because replay is not enabled for this agent.",
            reason: "runner_restarted_mid_model",
          },
        },
      },
      causality: { messageId: brandId<MessageId>("msg-restart") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "Agent turn was interrupted during model generation.",
      },
      createdAt: "2026-05-20T12:00:00.000Z",
    };

    const state = [envelope(message, 1)].reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      id: "msg-restart",
      contentType: "lifecycle",
      kind: "system",
      lifecycle: {
        status: "interrupted",
        title: "Restart interrupted the response",
        reason: "runner_restarted_mid_model",
      },
    });
  });

  it("surfaces completed turns whose only assistant message is empty", () => {
    const turnId = brandId<TurnId>("turn-empty-assistant");
    const messageId = brandId<MessageId>("msg-empty-assistant");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const completed: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "assistant",
        content: "",
        blocks: [],
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "Agent turn completed" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, completed, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "turn:turn-empty-assistant:no-response",
    ]);
    expect(chatMessagesFromChannelView(state)[0]).toMatchObject({
      content: "Agent turn closed without an assistant response. Agent turn completed",
      error: "Agent turn closed without an assistant response",
    });
  });

  it("does not add a no-response error when the turn produced inline UI", () => {
    const turnId = brandId<TurnId>("turn-inline-ui");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "credential-refresh",
        source: { type: "code", code: "export default function CredentialRefresh() { return null; }" },
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, summary: "Agent turn completed" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    const state = [opened, inline, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());

    expect(chatMessagesFromChannelView(state).map((message) => message.id)).toEqual([
      "inline-ui:participant-agent-1:credential-refresh",
    ]);
  });

  it("does not surface user-interrupted agent turns as no-response errors", () => {
    const turnId = brandId<TurnId>("turn-interrupted");
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-05-20T12:00:00.000Z",
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-cancelled") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, name: "eval", request: { code: "run()" } },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const abandoned: AgenticEvent<"invocation.abandoned"> = {
      kind: "invocation.abandoned",
      actor: agent,
      turnId,
      causality: { invocationId: brandId<InvocationId>("inv-cancelled") },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "Agent turn interrupted by user" },
      createdAt: "2026-05-20T12:00:02.000Z",
    };
    const closed: AgenticEvent<"turn.closed"> = {
      kind: "turn.closed",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: "Agent turn interrupted by user",
        reason: "user_interrupted",
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };

    const state = [opened, started, abandoned, closed]
      .map((event, index) => envelope(event, index + 1))
      .reduce(reduceChannelView, createInitialChannelViewState());
    const messages = chatMessagesFromChannelView(state);

    expect(messages.map((message) => message.id)).toEqual(["invocation:inv-cancelled"]);
    expect(messages[0]?.invocation?.execution.status).toBe("abandoned");
    expect(messages[0]?.complete).toBe(true);
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

  it("rejects stored refs before semantic chat projection", () => {
    const storedResult = {
      protocol: "natstack.blob-ref.v1" as const,
      digest: "digest-result",
      size: 1024,
      encoding: "json" as const,
      originalBytes: 1024,
    };
    const storedRequest = {
      protocol: "natstack.blob-ref.v1" as const,
      digest: "digest-request",
      size: 512,
      encoding: "json" as const,
      originalBytes: 512,
    };
    const started: AgenticEvent<"invocation.started"> = {
      kind: "invocation.started",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-stored") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: "eval",
        request: storedRequest,
      },
      createdAt: "2026-05-20T12:00:01.000Z",
    };
    const completed: AgenticEvent<"invocation.completed"> = {
      kind: "invocation.completed",
      actor: agent,
      causality: { invocationId: brandId<InvocationId>("call-stored") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        result: storedResult,
      },
      createdAt: "2026-05-20T12:00:02.000Z",
    };

    expect(() => [envelope(started, 1), envelope(completed, 2)]
      .reduce(reduceChannelView, createInitialChannelViewState())).toThrow(
      /contains unresolved stored value refs/
    );
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

  it("rejects sync UI executable sources that still contain stored refs", () => {
    const storedSource = {
      protocol: "natstack.blob-ref.v1",
      digest: "ui-source-digest",
      size: 1024,
      encoding: "json",
      originalBytes: 1024,
      preview: "{\"type\":\"code\",\"code\":\"export default function App(){}\"}",
    };
    const inline: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: "ui-stored",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:03.000Z",
    };
    const actionBar: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: "bar-stored",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:04.000Z",
    };
    const messageType: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor: agent,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: "stored-ui",
        displayMode: "row",
        source: storedSource as never,
      },
      createdAt: "2026-05-20T12:00:05.000Z",
    };

    expect(() => [envelope(inline, 1), envelope(actionBar, 2), envelope(messageType, 3)]
      .reduce(reduceChannelView, createInitialChannelViewState())).toThrow(
      /contains unresolved stored value refs/
    );
  });
});
