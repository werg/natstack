/**
 * ContentBlockProjector — maps pi-agent-core AgentEvents to channel messages.
 *
 * One channel message per Pi content block (text / thinking / toolCall).
 * Text and thinking stream via send→updates→complete. ToolCall messages carry
 * a structured `ToolCallPayload` that evolves with a "replace" payload on
 * each update, finalizing at `tool_execution_end`.
 *
 * Ordering: all channel ops flow through a per-projector promise chain so
 * RPC calls land at the channel DO in emission order. `handleEvent` returns
 * the chain promise so pi-agent-core's awaited `.subscribe` provides
 * end-to-end back-pressure.
 */

import { getDetailedActionDescription } from "@workspace/pubsub";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RunnerEvent } from "@natstack/harness";
import type { ToolCallPayload, ToolExecutionState } from "@workspace/agentic-core";

import { truncateResult } from "./action-data.js";

export interface ProjectorSink {
  send(msgId: string, content: string, opts?: {
    contentType?: string;
    attachments?: Array<{ data: string; mimeType: string }>;
  }): Promise<void>;
  update(msgId: string, content: string, opts?: { append?: boolean }): Promise<void>;
  complete(msgId: string): Promise<void>;
  /** Best-effort error marker for a specific channel message. Called by the
   *  projector when a preceding op (send/update/complete) fails — the chat
   *  UI renders `ChatMessage.error` inline so users see the failure rather
   *  than a stuck "pending" block. */
  error(msgId: string, message: string, code?: string): Promise<void>;
}

export type ChannelOp =
  | {
      kind: "send";
      msgId: string;
      content: string;
      contentType?: string;
      attachments?: Array<{ data: string; mimeType: string }>;
    }
  | { kind: "update"; msgId: string; content: string; append?: boolean }
  | { kind: "complete"; msgId: string }
  | { kind: "error"; msgId: string; message: string; code?: string };

interface ToolCallRecord {
  msgId: string;
  payload: ToolCallPayload;
}

export interface ProjectorState {
  textMsgIdByIndex: ReadonlyMap<number, string>;
  textContentByIndex: ReadonlyMap<number, string>;
  thinkingMsgIdByIndex: ReadonlyMap<number, string>;
  thinkingContentByIndex: ReadonlyMap<number, string>;
  toolCalls: ReadonlyMap<string, ToolCallRecord>;
}

export function createInitialProjectorState(): ProjectorState {
  return {
    textMsgIdByIndex: new Map(),
    textContentByIndex: new Map(),
    thinkingMsgIdByIndex: new Map(),
    thinkingContentByIndex: new Map(),
    toolCalls: new Map(),
  };
}

// ─── Pure mapping ────────────────────────────────────────────────────────────

/**
 * Pure mapping from a Pi AgentEvent + current projector state to the
 * channel ops to emit and the next state. Unit-testable against captured
 * Pi event traces.
 */
export function piEventToChannelOps(
  event: RunnerEvent,
  state: ProjectorState,
  allocMsgId: () => string,
): { newState: ProjectorState; ops: ChannelOp[] } {
  switch (event.type) {
    case "message_start": {
      const role = getRole(event.message);
      if (role !== "assistant") return { newState: state, ops: [] };
      // Clear per-message index maps. Tool-call records survive across the
      // message boundary: execution events for these tool calls arrive
      // after `message_end`.
      return {
        newState: {
          ...state,
          textMsgIdByIndex: new Map(),
          textContentByIndex: new Map(),
          thinkingMsgIdByIndex: new Map(),
          thinkingContentByIndex: new Map(),
        },
        ops: [],
      };
    }

    case "message_update": {
      const ame = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
      if (!ame) return { newState: state, ops: [] };
      return handleAssistantMessageEvent(event, ame as AssistantMessageEventLike, state, allocMsgId);
    }

    case "message_end": {
      const role = getRole(event.message);
      if (role !== "assistant") return { newState: state, ops: [] };
      // Per-message block maps are cleared; tool-call records survive because
      // their execution events arrive after message_end. Text/thinking blocks
      // are closed via their own *_end events — no work here.
      return {
        newState: {
          ...state,
          textMsgIdByIndex: new Map(),
          textContentByIndex: new Map(),
          thinkingMsgIdByIndex: new Map(),
          thinkingContentByIndex: new Map(),
        },
        ops: [],
      };
    }

    case "tool_execution_start":
      // Status stays "pending" — no UI transition on start.
      return { newState: state, ops: [] };

    case "tool_execution_update": {
      const { toolCallId } = event as { toolCallId: string };
      const record = state.toolCalls.get(toolCallId);
      if (!record) return { newState: state, ops: [] };
      const partial = (event as { partialResult?: { details?: unknown } }).partialResult;
      const details = partial?.details as { type?: string; content?: string } | undefined;
      if (details?.type !== "console" || typeof details.content !== "string") {
        return { newState: state, ops: [] };
      }
      const prior = record.payload.execution.consoleOutput;
      const nextConsole = prior ? `${prior}\n${details.content}` : details.content;
      const nextPayload: ToolCallPayload = {
        ...record.payload,
        execution: { ...record.payload.execution, consoleOutput: nextConsole },
      };
      return {
        newState: replaceToolCall(state, toolCallId, { ...record, payload: nextPayload }),
        ops: [{ kind: "update", msgId: record.msgId, content: JSON.stringify(nextPayload) }],
      };
    }

    case "session_compact": {
      const count = event.compactionEntry.tokensBefore;
      const msgId = allocMsgId();
      return {
        newState: state,
        ops: [{
          kind: "send",
          msgId,
          content: `Context compacted: ${count} tokens summarized`,
          contentType: "system",
        }, { kind: "complete", msgId }],
      };
    }

    case "system_event": {
      if (event.kind !== "orphan_file_mutation_intent") {
        return { newState: state, ops: [] };
      }
      const msgId = allocMsgId();
      const suffix = event.path ? `: ${event.path}` : "";
      return {
        newState: state,
        ops: [{
          kind: "send",
          msgId,
          content: `Recovered incomplete file mutation${suffix}`,
          contentType: "system",
        }, { kind: "complete", msgId }],
      };
    }

    case "tool_execution_end": {
      const { toolCallId, result, isError } = event as {
        toolCallId: string; result: unknown; isError: boolean;
      };
      const record = state.toolCalls.get(toolCallId);
      if (!record) return { newState: state, ops: [] };
      const { value: truncatedResult, truncated } = truncateResult(result);
      const resultImages = extractImages(result);
      const execution: ToolExecutionState = {
        status: isError ? "error" : "complete",
        description: record.payload.execution.description,
        consoleOutput: record.payload.execution.consoleOutput,
        result: truncatedResult,
        isError: isError || undefined,
        resultTruncated: truncated || undefined,
        resultImages: resultImages.length > 0 ? resultImages : undefined,
      };
      const nextPayload: ToolCallPayload = { ...record.payload, execution };
      const nextState = removeToolCall(state, toolCallId);
      return {
        newState: nextState,
        ops: [
          { kind: "update", msgId: record.msgId, content: JSON.stringify(nextPayload) },
          { kind: "complete", msgId: record.msgId },
        ],
      };
    }

    // agent_end is handled by the stateful projector below. The pure mapper
    // does not emit ops because it cannot inspect in-flight block state after
    // applying the current event.
    default:
      return { newState: state, ops: [] };
  }
}

type AssistantMessageEventLike = {
  type: string;
  contentIndex?: number;
  delta?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  partial?: { content?: unknown[] };
};

function handleAssistantMessageEvent(
  event: AgentEvent & { type: "message_update" },
  ame: AssistantMessageEventLike,
  state: ProjectorState,
  allocMsgId: () => string,
): { newState: ProjectorState; ops: ChannelOp[] } {
  const ci = ame.contentIndex;
  switch (ame.type) {
    case "text_start": {
      if (ci === undefined) return { newState: state, ops: [] };
      const msgId = allocMsgId();
      return {
        newState: {
          ...state,
          textMsgIdByIndex: addToMap(state.textMsgIdByIndex, ci, msgId),
          textContentByIndex: addToMap(state.textContentByIndex, ci, ""),
        },
        ops: [{ kind: "send", msgId, content: "" }],
      };
    }
    case "text_delta": {
      if (ci === undefined || !ame.delta) return { newState: state, ops: [] };
      let msgId = state.textMsgIdByIndex.get(ci);
      if (!msgId) {
        // Defensive: some models emit deltas before a start event.
        msgId = allocMsgId();
        return {
          newState: {
            ...state,
            textMsgIdByIndex: addToMap(state.textMsgIdByIndex, ci, msgId),
            textContentByIndex: addToMap(state.textContentByIndex, ci, ame.delta),
          },
          ops: [
            { kind: "send", msgId, content: "" },
            { kind: "update", msgId, content: ame.delta },
          ],
        };
      }
      const nextContent = (state.textContentByIndex.get(ci) ?? "") + ame.delta;
      return {
        newState: { ...state, textContentByIndex: addToMap(state.textContentByIndex, ci, nextContent) },
        ops: [{ kind: "update", msgId, content: ame.delta }],
      };
    }
    case "text_end": {
      if (ci === undefined) return { newState: state, ops: [] };
      const msgId = state.textMsgIdByIndex.get(ci);
      if (!msgId) return { newState: state, ops: [] };
      return {
        newState: {
          ...state,
          textMsgIdByIndex: removeFromMap(state.textMsgIdByIndex, ci),
          textContentByIndex: removeFromMap(state.textContentByIndex, ci),
        },
        ops: [{ kind: "complete", msgId }],
      };
    }
    case "thinking_start": {
      if (ci === undefined) return { newState: state, ops: [] };
      const msgId = allocMsgId();
      return {
        newState: {
          ...state,
          thinkingMsgIdByIndex: addToMap(state.thinkingMsgIdByIndex, ci, msgId),
          thinkingContentByIndex: addToMap(state.thinkingContentByIndex, ci, ""),
        },
        ops: [{ kind: "send", msgId, content: "", contentType: "thinking" }],
      };
    }
    case "thinking_delta": {
      if (ci === undefined || !ame.delta) return { newState: state, ops: [] };
      let msgId = state.thinkingMsgIdByIndex.get(ci);
      if (!msgId) {
        msgId = allocMsgId();
        return {
          newState: {
            ...state,
            thinkingMsgIdByIndex: addToMap(state.thinkingMsgIdByIndex, ci, msgId),
            thinkingContentByIndex: addToMap(state.thinkingContentByIndex, ci, ame.delta),
          },
          ops: [
            { kind: "send", msgId, content: "", contentType: "thinking" },
            { kind: "update", msgId, content: ame.delta, append: true },
          ],
        };
      }
      const nextContent = (state.thinkingContentByIndex.get(ci) ?? "") + ame.delta;
      return {
        newState: { ...state, thinkingContentByIndex: addToMap(state.thinkingContentByIndex, ci, nextContent) },
        ops: [{ kind: "update", msgId, content: ame.delta, append: true }],
      };
    }
    case "thinking_end": {
      if (ci === undefined) return { newState: state, ops: [] };
      const msgId = state.thinkingMsgIdByIndex.get(ci);
      if (!msgId) return { newState: state, ops: [] };
      return {
        newState: {
          ...state,
          thinkingMsgIdByIndex: removeFromMap(state.thinkingMsgIdByIndex, ci),
          thinkingContentByIndex: removeFromMap(state.thinkingContentByIndex, ci),
        },
        ops: [{ kind: "complete", msgId }],
      };
    }
    case "toolcall_start": {
      // `toolcall_start` doesn't include the ToolCall directly on this event —
      // we read it from the partial message's content array at `contentIndex`.
      if (ci === undefined) return { newState: state, ops: [] };
      const partialMsg = ame.partial ?? (event.message as { content?: unknown[] });
      const blocks = partialMsg?.content ?? [];
      const block = blocks[ci] as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
      if (!block?.id) return { newState: state, ops: [] };
      if (state.toolCalls.has(block.id)) return { newState: state, ops: [] };
      const msgId = allocMsgId();
      const name = block.name ?? "tool";
      const args = block.arguments ?? {};
      const payload: ToolCallPayload = {
        id: block.id,
        name,
        arguments: args,
        execution: {
          status: "pending",
          description: getDetailedActionDescription(name, args),
        },
      };
      return {
        newState: addToolCall(state, block.id, { msgId, payload }),
        ops: [{
          kind: "send",
          msgId,
          content: JSON.stringify(payload),
          contentType: "toolCall",
        }],
      };
    }
    case "toolcall_end": {
      const tc = ame.toolCall;
      if (!tc?.id) return { newState: state, ops: [] };
      const existing = state.toolCalls.get(tc.id);
      // Late materialization: pi streamed no start, only end (rare).
      const msgId = existing?.msgId ?? allocMsgId();
      const args = tc.arguments ?? {};
      const description = getDetailedActionDescription(tc.name, args);
      const payload: ToolCallPayload = {
        id: tc.id,
        name: tc.name,
        arguments: args,
        execution: existing
          ? { ...existing.payload.execution, description }
          : { status: "pending", description },
      };
      const record: ToolCallRecord = { msgId, payload };
      const ops: ChannelOp[] = existing
        ? [{ kind: "update", msgId, content: JSON.stringify(payload) }]
        : [{
            kind: "send",
            msgId,
            content: JSON.stringify(payload),
            contentType: "toolCall",
          }];
      return { newState: addToolCall(state, tc.id, record), ops };
    }
    default:
      return { newState: state, ops: [] };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRole(message: unknown): string | undefined {
  return (message as { role?: string } | null)?.role;
}

/** Inspect an `agent_end` event's final assistant message for an error/abort
 *  stopReason. pi-agent-core's `handleRunFailure` path terminates the run
 *  with `stopReason: "error" | "aborted"` on the last message — on either,
 *  natural `*_end` events for in-flight blocks never fire. */
function isTerminatedByError(event: AgentEvent & { type: "agent_end" }): boolean {
  const messages = (event as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string } | null;
    if (!m || m.role !== "assistant") continue;
    return m.stopReason === "error" || m.stopReason === "aborted";
  }
  return false;
}

function terminalErrorMessage(event: AgentEvent & { type: "agent_end" }): string | null {
  const messages = (event as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: unknown } | null;
    if (!m || m.role !== "assistant") continue;
    if (m.stopReason !== "error" && m.stopReason !== "aborted") return null;
    return typeof m.errorMessage === "string" && m.errorMessage.length > 0
      ? m.errorMessage
      : "Agent turn failed";
  }
  return null;
}

function isCredentialRequiredTerminalError(message: string | null): boolean {
  return !!message &&
    /^No URL-bound model credential is configured for model provider: /.test(message);
}

function finalAssistantMessage(event: AgentEvent & { type: "agent_end" }): unknown {
  const messages = (event as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string } | null;
    if (message?.role === "assistant") return message;
  }
  return null;
}

function contentBlocks(message: unknown): unknown[] {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? content : [];
}

function blockString(block: unknown, keys: string[]): string | null {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function textBlockContent(message: unknown, index: number): string | null {
  const block = contentBlocks(message)[index];
  if (!block || typeof block !== "object") return null;
  const type = (block as { type?: unknown }).type;
  if (type !== "text") return null;
  return blockString(block, ["text", "content"]);
}

function thinkingBlockContent(message: unknown, index: number): string | null {
  const block = contentBlocks(message)[index];
  if (!block || typeof block !== "object") return null;
  const type = (block as { type?: unknown }).type;
  if (type !== "thinking" && type !== "reasoning") return null;
  return blockString(block, ["text", "content", "thinking", "reasoning"]);
}

function addToMap<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function removeFromMap<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

function addToolCall(
  state: ProjectorState,
  toolCallId: string,
  record: ToolCallRecord,
): ProjectorState {
  const next = new Map(state.toolCalls);
  next.set(toolCallId, record);
  return { ...state, toolCalls: next };
}

function replaceToolCall(
  state: ProjectorState,
  toolCallId: string,
  record: ToolCallRecord,
): ProjectorState {
  return addToolCall(state, toolCallId, record);
}

function removeToolCall(state: ProjectorState, toolCallId: string): ProjectorState {
  const next = new Map(state.toolCalls);
  next.delete(toolCallId);
  return { ...state, toolCalls: next };
}

/** Walk a tool result shape to collect any ImageContent-like blocks. */
function extractImages(result: unknown): Array<{ mimeType: string; data: string }> {
  const out: Array<{ mimeType: string; data: string }> = [];
  const candidates: unknown[] = [];
  if (Array.isArray(result)) {
    candidates.push(...result);
  } else if (result && typeof result === "object") {
    const r = result as { content?: unknown[] };
    if (Array.isArray(r.content)) candidates.push(...r.content);
    else candidates.push(result);
  }
  for (const item of candidates) {
    const img = item as { type?: string; mimeType?: string; data?: string };
    if (img?.type === "image" && img.mimeType && img.data) {
      out.push({ mimeType: img.mimeType, data: img.data });
    }
  }
  return out;
}

// ─── Stateful projector ──────────────────────────────────────────────────────

export class ContentBlockProjector {
  private state: ProjectorState = createInitialProjectorState();
  private pendingOp: Promise<void> = Promise.resolve();

  constructor(
    private sink: ProjectorSink,
    private allocMsgId: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * Project a Pi event into channel ops and dispatch them in order.
   * Returns the promise chain so callers providing back-pressure (e.g.
   * pi-agent-core's awaited subscribe) can wait on all RPC calls to land.
   *
   * On `agent_end`, emits `complete` for every in-flight block so replayed
   * channel state is terminal even if the provider skipped or raced a natural
   * `*_end` event. (Mid-turn block events continue streaming normally; only
   * the terminal event triggers the sweep.)
   */
  handleEvent(event: RunnerEvent): Promise<void> {
    const { newState, ops } = piEventToChannelOps(event, this.state, this.allocMsgId);
    this.state = newState;
    for (const op of ops) this.dispatch(op);
    if (event.type === "agent_end") {
      this.enqueueMissingFinalContent(event);
      const openMsgIds = this.collectOpenMsgIds();
      if (openMsgIds.length > 0) {
        this.enqueueCloseAll();
      } else if (isTerminatedByError(event)) {
        const message = terminalErrorMessage(event);
        if (message && !isCredentialRequiredTerminalError(message)) {
          const msgId = this.allocMsgId();
          this.dispatch({ kind: "send", msgId, content: message });
          this.dispatch({ kind: "error", msgId, message, code: "agent_turn_failed" });
        }
      }
    }
    return this.pendingOp;
  }

  private enqueueMissingFinalContent(event: RunnerEvent & { type: "agent_end" }): void {
    const assistant = finalAssistantMessage(event);
    if (!assistant) return;

    for (const [index, msgId] of this.state.textMsgIdByIndex) {
      const finalContent = textBlockContent(assistant, index);
      if (finalContent === null) continue;
      const persistedContent = this.state.textContentByIndex.get(index) ?? "";
      if (finalContent.length <= persistedContent.length) continue;
      if (!finalContent.startsWith(persistedContent)) continue;
      const suffix = finalContent.slice(persistedContent.length);
      if (suffix.length === 0) continue;
      this.dispatch({ kind: "update", msgId, content: suffix });
      this.state = {
        ...this.state,
        textContentByIndex: addToMap(this.state.textContentByIndex, index, finalContent),
      };
    }

    for (const [index, msgId] of this.state.thinkingMsgIdByIndex) {
      const finalContent = thinkingBlockContent(assistant, index);
      if (finalContent === null) continue;
      const persistedContent = this.state.thinkingContentByIndex.get(index) ?? "";
      if (finalContent.length <= persistedContent.length) continue;
      if (!finalContent.startsWith(persistedContent)) continue;
      const suffix = finalContent.slice(persistedContent.length);
      if (suffix.length === 0) continue;
      this.dispatch({ kind: "update", msgId, content: suffix, append: true });
      this.state = {
        ...this.state,
        thinkingContentByIndex: addToMap(this.state.thinkingContentByIndex, index, finalContent),
      };
    }
  }

  private enqueueCloseAll(): void {
    const openMsgIds = this.collectOpenMsgIds();
    for (const msgId of openMsgIds) this.dispatch({ kind: "complete", msgId });
    this.state = createInitialProjectorState();
  }

  private collectOpenMsgIds(): string[] {
    const ids: string[] = [
      ...this.state.textMsgIdByIndex.values(),
      ...this.state.thinkingMsgIdByIndex.values(),
    ];
    for (const record of this.state.toolCalls.values()) {
      const status = record.payload.execution.status;
      if (status !== "complete" && status !== "error") ids.push(record.msgId);
    }
    return ids;
  }

  /**
   * Emit `channel.complete` for every open channel message the projector
   * is tracking. Call from interrupt / error paths so the client sees
   * clean closure for every in-flight block, not just the happy-path
   * `*_end` events. Does NOT toggle typing — the caller owns that
   * lifecycle; see `AgentWorkerBase.interruptRunner`.
   */
  async closeAll(): Promise<void> {
    this.enqueueCloseAll();
    await this.pendingOp;
  }

  /** msgIds for which a preceding op already failed. Further ops for the
   *  same msgId are dropped so we don't emit a cascade of failures on the
   *  same already-errored channel message. */
  private poisonedMsgIds = new Set<string>();

  private dispatch(op: ChannelOp): void {
    // Short-circuit ops for already-errored messages without poking the sink.
    if ("msgId" in op && this.poisonedMsgIds.has(op.msgId)) return;

    this.pendingOp = this.pendingOp.then(() => this.execute(op)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[ContentBlockProjector] channel op failed:", op.kind, ("msgId" in op ? op.msgId : ""), msg);
      if ("msgId" in op) {
        // Surface the failure as a visible error on that channel message so
        // the user sees something instead of a stuck "pending" block. The
        // error emit itself is best-effort; we swallow its failure here
        // rather than recursing.
        this.poisonedMsgIds.add(op.msgId);
        return this.sink.error(op.msgId, `Channel op failed (${op.kind}): ${msg}`).catch((errErr) => {
          console.warn("[ContentBlockProjector] channel.error emit failed:", errErr);
        });
      }
      return undefined;
    });
  }

  private async execute(op: ChannelOp): Promise<void> {
    switch (op.kind) {
      case "send":
        await this.sink.send(op.msgId, op.content, {
          contentType: op.contentType,
          attachments: op.attachments,
        });
        return;
      case "update":
        await this.sink.update(op.msgId, op.content, op.append ? { append: true } : undefined);
        return;
      case "complete":
        await this.sink.complete(op.msgId);
        return;
      case "error":
        await this.sink.error(op.msgId, op.message, op.code);
        return;
    }
  }
}
