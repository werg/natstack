/**
 * step(state, incoming, ctx) → { append, effects } (WS1 §1.3). Pure: wall
 * clock and randomness arrive only via ctx; effects MUST be a subset of
 * derivePendingEffects(fold(state ⊕ append)) — the driver may discard them
 * and run the reconcile instead.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { Command, Incoming, StepContext } from "./commands.js";
import {
  derivePendingEffects,
  invocationEffect,
  modelCallEffect,
  type AppendItem,
  type EffectDescriptor,
} from "./effects.js";
import { applyEvent } from "./fold.js";
import { ids } from "./ids.js";
import { classifyModelFailure, type ModelFailureInfo } from "./model-errors.js";
import type { AgentLoopConfig, AgentState, AgentTurnMetadata, ModelRequestDescriptor } from "./state.js";
import type { LogEnvelope } from "@workspace/agentic-protocol";

export interface StepOutput {
  append: AppendItem[];
  effects: EffectDescriptor[];
}

export type StepFn = (state: AgentState, incoming: Incoming, ctx: StepContext) => StepOutput;

const EMPTY: StepOutput = { append: [], effects: [] };

export interface EphemeralSignal {
  kind: "signal-event";
  channelId: string;
  event: AgenticEvent;
}

function parseModel(model: string): { provider: string; model: string } {
  const idx = model.indexOf(":");
  if (idx === -1) return { provider: "anthropic", model };
  return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

/** Build the next assistant message.started + its model_call effect.
 *  `itemsBefore` = number of append items that precede the message.started in
 *  the same batch (their seqs are part of the context snapshot). */
function modelStartItems(
  state: AgentState,
  turnId: string,
  modelCallCount: number,
  itemsBefore: number
): { item: AppendItem; effect: EffectDescriptor } {
  const messageId = ids.messageId(turnId, modelCallCount);
  const attemptId = ids.attemptId(messageId);
  const config = turnConfig(state);
  const { provider, model } = parseModel(config.model);
  const request: ModelRequestDescriptor = {
    provider,
    model,
    thinkingLevel: config.thinkingLevel,
    systemPromptHash: config.systemPromptHash,
    ...(config.skillIndexHash ? { skillIndexHash: config.skillIndexHash } : {}),
    ...(config.toolSchemasHash ? { toolSchemasHash: config.toolSchemasHash } : {}),
    activeToolNames: config.activeToolNames,
    contextThroughSeq: state.lastSeq + itemsBefore,
    attemptId,
    ...(config.modelStreamIdleTimeoutMs !== undefined
      ? { streamOptions: { idleTimeoutMs: config.modelStreamIdleTimeoutMs } }
      : {}),
    ...(state.openTurn?.metadata ? { turnMetadata: state.openTurn.metadata } : {}),
  };
  const item: AppendItem = {
    envelopeId: ids.messageStarted(messageId),
    payloadKind: "message.started",
    payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant", modelRequest: request },
    causality: { messageId: messageId as never, turnId },
    publish: shouldPublishTurnLifecycle(state.openTurn?.metadata),
  };
  return {
    item,
    effect: {
      effectId: ids.modelEffect(messageId),
      kind: "model_call",
      channelId: state.channelId,
      idempotencyKey: attemptId,
      messageId,
      turnId,
      request,
    },
  };
}

function turnConfig(state: AgentState): AgentLoopConfig {
  const patch = state.openTurn?.metadata?.loopConfigPatch;
  if (!patch) return state.config;
  return { ...state.config, ...patch };
}

function turnMetadata(command: Extract<Command, { kind: "prompt" | "steer" }>): AgentTurnMetadata | undefined {
  return command.metadata;
}

function shouldPublishTurnLifecycle(metadata?: AgentTurnMetadata): boolean {
  return metadata?.delivery !== "none";
}

function recvItem(command: Extract<Command, { kind: "prompt" | "steer" }>): AppendItem {
  return {
    envelopeId: ids.recvUserMessage(command.channelId, command.source.envelopeId),
    payloadKind: "message.completed",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "user",
      blocks: Array.isArray(command.content)
        ? command.content
        : [{ type: "text", content: String(command.content ?? "") }],
      outcome: "completed",
      ...(command.metadata ? { metadata: command.metadata } : {}),
    },
    causality: {
      messageId: ids.recvUserMessage(command.channelId, command.source.envelopeId) as never,
      ...(command.agentHops !== undefined ? { agentHops: command.agentHops } : {}),
    },
    // The user's message already lives in the channel log; the trajectory
    // copy is private context (no republish).
    publish: false,
  };
}

function turnClosedItem(
  turnId: string,
  opts: { reason?: string; summary?: string } = {}
): AppendItem {
  return {
    envelopeId: ids.turnClosed(turnId),
    payloadKind: "turn.closed",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.summary ? { summary: opts.summary } : {}),
    },
    causality: { turnId },
    publish: true,
  };
}

function turnWaitingItem(
  turnId: string,
  waitingCount: number,
  opts: {
    reason:
      | "model_usage_limit_reset"
      | "model_credential_required"
      | "model_credential_reconnect_required";
    summary?: string;
  }
): AppendItem {
  return {
    envelopeId: ids.turnWaiting(turnId, waitingCount),
    payloadKind: "turn.waiting",
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      reason: opts.reason,
      ...(opts.summary ? { summary: opts.summary } : {}),
    },
    causality: { turnId },
    publish: true,
  };
}

function modelFailurePayload(
  failure: ModelFailureInfo,
  recoverableOverride: boolean | undefined
): Record<string, unknown> {
  const recoverable = failure.recoverable && (recoverableOverride ?? true);
  return {
    protocol: AGENTIC_PROTOCOL_VERSION,
    reason: failure.reason,
    recoverable,
    code: failure.code,
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
    ...(failure.resetAt ? { resetAt: failure.resetAt } : {}),
  };
}

/** Terminal cleanup for an interrupted/aborted turn (E-after-interrupt). */
function interruptCleanupItems(state: AgentState, reason: string): AppendItem[] {
  const items: AppendItem[] = [];
  for (const invocation of Object.values(state.pendingInvocations)) {
    items.push({
      envelopeId: ids.invocationTerminal(invocation.invocationId),
      payloadKind: "invocation.cancelled",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason,
        terminalOutcome: "cancelled",
        terminalReasonCode: reason,
      },
      causality: {
        invocationId: invocation.invocationId as never,
        turnId: invocation.turnId,
      },
      publish: true,
    });
  }
  for (const approval of Object.values(state.pendingApprovals)) {
    items.push({
      envelopeId: ids.approvalResolved(approval.approvalId),
      payloadKind: "approval.resolved",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        granted: false,
        resolvedBy: { kind: "system", id: "agent-loop" },
        reason,
      },
      causality: {
        approvalId: approval.approvalId as never,
        invocationId: approval.invocationId as never,
        turnId: approval.turnId,
      },
      publish: true,
    });
  }
  for (const wait of Object.values(state.pendingCredentialWaits)) {
    items.push({
      envelopeId: ids.systemEvent(wait.credKey, "resolved", wait.startedAtSeq),
      payloadKind: "system.event",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "credential.wait_resolved",
        credKey: wait.credKey,
        details: {
          kind: "credential.wait_resolved",
          credKey: wait.credKey,
          providerId: wait.providerId,
          resolved: false,
          reason,
        },
      },
      causality: { turnId: wait.turnId },
      publish: true,
    });
  }
  if (state.openTurn) {
    items.push(
      turnClosedItem(state.openTurn.turnId, {
        reason: reason === "forked" ? "forked" : "user_interrupted",
      })
    );
  }
  return items;
}

/** E-model-terminal expansion: journal one invocation.started per tool call
 *  and emit the matching dispatch effects. Also used by C-wake recovery for
 *  unprocessed tool calls (deterministic ids make re-expansion idempotent). */
/** Local tools dispatch in-process; any roster participant advertising the
 *  method becomes a channel_call target (the panel's eval/UI tools). Unknown
 *  names stay local so the local executor reports "unknown tool". */
function transportForToolCall(
  state: AgentState,
  name: string,
  invocationId: string
):
  | { kind: "local"; awaiterId: string }
  | { kind: "channel"; channelId: string; target: unknown; transportCallId: string } {
  if (state.config.activeToolNames.includes(name)) {
    return { kind: "local", awaiterId: invocationId };
  }
  for (const participant of state.config.roster.participants) {
    if (participant.methods.some((method) => method.name === name)) {
      return {
        kind: "channel",
        channelId: state.channelId,
        target: participant.ref,
        transportCallId: ids.transportCallId(invocationId),
      };
    }
  }
  return { kind: "local", awaiterId: invocationId };
}

function expandToolCalls(
  state: AgentState,
  toolCalls: ToolCallBlock[],
  messageId: string,
  turnId: string,
  ctx: StepContext
): StepOutput {
  const append: AppendItem[] = [];
  const effects: EffectDescriptor[] = [];
  const attemptId = messageId ? ids.attemptId(messageId) : "";
  let projected = state;
  for (const block of toolCalls) {
    const invocationId = block.id;
    const item: AppendItem = {
      envelopeId: ids.invocationStart(invocationId),
      payloadKind: "invocation.started",
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        name: block.name,
        invocationType: "tool",
        request: block.arguments,
        transport: transportForToolCall(state, block.name, invocationId),
        userVisible: true,
      },
      causality: {
        ...(messageId ? { messageId: messageId as never } : {}),
        invocationId: invocationId as never,
        modelToolCallId: invocationId,
        attemptId,
        turnId,
      },
      publish: true,
    };
    append.push(item);
    projected = projectAppend(projected, [item], ctx.now);
    effects.push(invocationEffect(projected, projected.pendingInvocations[invocationId]!));
  }
  return { append, effects };
}

/** Project the post-append state (fold over synthetic envelopes — pure). */
export function projectAppend(state: AgentState, append: AppendItem[], now: string): AgentState {
  let next = state;
  let seq = state.lastSeq;
  for (const item of append) {
    seq += 1;
    const envelope = {
      logId: state.logId,
      head: state.head,
      seq,
      envelopeId: item.envelopeId,
      actor: { kind: "agent", id: "self" },
      payloadKind: item.payloadKind,
      payload: item.payload,
      causality: item.causality,
      appendedAt: now,
      prevHash: next.lastHash,
      hash: `projected:${seq}`,
    } as unknown as LogEnvelope;
    next = applyEvent(next, envelope);
  }
  return next;
}

/** The C-wake duplicate-dispatch guard (plan WS1.4): never start a new model
 *  call while any invocation from a FAILED attempt is non-terminal. */
function wakeGuardSatisfied(state: AgentState): boolean {
  if (state.inFlightModelCall) return false;
  const currentAttempts = new Set<string>();
  // every pending invocation belongs to some attempt; with no in-flight call
  // any non-terminal invocation blocks a fresh model call
  for (const invocation of Object.values(state.pendingInvocations)) {
    currentAttempts.add(invocation.attemptId ?? "");
  }
  return currentAttempts.size === 0;
}

function hasFreshInput(state: AgentState): boolean {
  if (state.steeringQueue.length > 0) return true;
  // fresh tool results since the last model call: the last entry is a
  // tool-result newer than the in-flight snapshot
  const lastEntry = state.entries[state.entries.length - 1];
  return lastEntry?.kind === "tool-result";
}

/** Optional per-turn model-call budget. Null means unlimited. */
export const DEFAULT_MAX_MODEL_CALLS_PER_TURN: number | null = null;

function maxModelCallsPerTurn(state: AgentState): number | null {
  const configured = state.config.maxModelCallsPerTurn;
  if (configured === null || configured === undefined) {
    return DEFAULT_MAX_MODEL_CALLS_PER_TURN;
  }
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_MODEL_CALLS_PER_TURN;
  }
  return Math.floor(configured);
}

function nextModelCall(state: AgentState, itemsBefore: number): StepOutput {
  const turn = state.openTurn!;
  const maxModelCalls = maxModelCallsPerTurn(state);
  if (maxModelCalls !== null && turn.modelCallCount >= maxModelCalls) {
    return {
      append: [
        {
          envelopeId: `diag:${turn.turnId}:max-model-calls-per-turn`,
          payloadKind: "message.completed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            role: "assistant",
            blocks: [
              {
                type: "diagnostic",
                content:
                  `Configured maxModelCallsPerTurn reached for ${turn.turnId}: ` +
                  `${turn.modelCallCount} model call(s) have already run, ` +
                  `and the configured limit is ${maxModelCalls}.`,
                metadata: {
                  code: "max_model_calls_per_turn",
                  severity: "error",
                  configKey: "maxModelCallsPerTurn",
                  limit: maxModelCalls,
                  modelCallCount: turn.modelCallCount,
                  turnId: turn.turnId,
                },
              },
            ],
            outcome: "completed",
          },
          causality: {
            messageId: `diag:${turn.turnId}:max-model-calls-per-turn` as never,
            turnId: turn.turnId,
          },
          publish: turn.metadata?.delivery !== "none",
        },
        turnClosedItem(turn.turnId, { reason: "max_model_calls_per_turn" }),
      ],
      effects: [],
    };
  }
  const { item, effect } = modelStartItems(state, turn.turnId, turn.modelCallCount, itemsBefore);
  return { append: [item], effects: [effect] };
}

export function coreStep(state: AgentState, incoming: Incoming, ctx: StepContext): StepOutput {
  if (incoming.type === "command") return commandStep(state, incoming.command, ctx);
  if (incoming.type === "event-appended") return eventStep(state, incoming.envelope, ctx);
  return effectFailedStep(state, incoming, ctx);
}

/** A channel may redeliver the same event (retry, resubscribe, channel DO
 *  restart). The recv envelope id is deterministic from the source envelope,
 *  so "this prompt/steer was already folded" is exactly "its recv id is in
 *  state". Without this guard a redelivery re-emits the whole prompt batch,
 *  whose replayed prefix is no longer at head once the turn progressed — the
 *  gad store rejects the append and the delivery wedges in a retry loop. */
function alreadyIngested(state: AgentState, recvEnvelopeId: string): boolean {
  return (
    state.pendingPrompt?.envelopeId === recvEnvelopeId ||
    state.steeringQueue.some((entry) => entry.envelopeId === recvEnvelopeId) ||
    state.entries.some((entry) => entry.kind === "user" && entry.envelopeId === recvEnvelopeId)
  );
}

function commandStep(state: AgentState, command: Command, ctx: StepContext): StepOutput {
  switch (command.kind) {
    case "prompt": {
      if (alreadyIngested(state, ids.recvUserMessage(command.channelId, command.source.envelopeId))) {
        return EMPTY;
      }
      if (state.openTurn) {
        // degrade to steer (today's TurnDispatcher fallback)
        return commandStep(state, { ...command, kind: "steer" }, ctx);
      }
      const recv = recvItem(command);
      const turnId = ids.turnId(command.channelId, command.source.envelopeId);
      const opened: AppendItem = {
        envelopeId: ids.turnOpened(turnId),
        payloadKind: "turn.opened",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          ...(turnMetadata(command) ? { metadata: turnMetadata(command) } : {}),
        },
        causality: { turnId },
        publish: shouldPublishTurnLifecycle(turnMetadata(command)),
      };
      const afterOpened = {
        ...state,
        openTurn: {
          turnId,
          openedAtSeq: state.lastSeq + 2,
          modelCallCount: 0,
          interrupted: false,
          waitingCount: 0,
          ...(turnMetadata(command) ? { metadata: turnMetadata(command) } : {}),
        },
      };
      const { item, effect } = modelStartItems(afterOpened, turnId, 0, 2);
      return { append: [recv, opened, item], effects: [effect] };
    }

    case "steer": {
      const recv = recvItem(command);
      if (alreadyIngested(state, recv.envelopeId)) return EMPTY;
      const canContinue =
        state.openTurn &&
        !state.openTurn.interrupted &&
        !state.inFlightModelCall &&
        Object.keys(state.pendingInvocations).length === 0;
      if (canContinue) {
        const next = nextModelCall(
          { ...state, openTurn: state.openTurn },
          1 // the recv item precedes the message.started
        );
        return { append: [recv, ...next.append], effects: next.effects };
      }
      return { append: [recv], effects: [] };
    }

    case "interrupt":
    case "abort": {
      if (!state.openTurn) return EMPTY;
      const reason = command.kind === "abort" ? (command.reason ?? "work_failed") : "user_interrupted";
      const marker: AppendItem = {
        envelopeId: ids.systemEvent(state.openTurn.turnId, "interrupt"),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "interrupt",
          details: { kind: "interrupt", reason },
        },
        causality: { turnId: state.openTurn.turnId },
        publish: true,
      };
      if (state.inFlightModelCall) {
        // The driver aborts the model executor; cleanup happens when its
        // interrupted terminal lands (E-model-terminal interrupted path).
        return { append: [marker], effects: [] };
      }
      const interrupted = projectAppend(state, [marker], ctx.now);
      return { append: [marker, ...interruptCleanupItems(interrupted, reason)], effects: [] };
    }

    case "setConfig": {
      return {
        append: [
          {
            envelopeId: ids.configChange(
              patchHashOf(command.patch),
              state.lastSeq // monotone disambiguator
            ),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "config.changed",
              details: { kind: "config.changed", patch: command.patch },
            },
            publish: true,
          },
        ],
        effects: [],
      };
    }

    case "compact": {
      // Exact-entry compaction (model-summarized compaction is a follow-on).
      if (state.entries.length === 0) return EMPTY;
      const keep = state.entries.slice(-8);
      const turnId = state.openTurn?.turnId ?? "idle";
      return {
        append: [
          {
            envelopeId: ids.compaction(turnId, state.lastSeq),
            payloadKind: "system.compaction_recorded",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              summary: `compacted ${state.entries.length - keep.length} entries`,
              rangeStart: String(state.entries[0]?.seq ?? 0) as never,
              rangeEnd: String(keep[0]?.seq ?? 0) as never,
              replacement: keep,
            },
            publish: false,
          },
        ],
        effects: [],
      };
    }

    case "wake": {
      const append: AppendItem[] = [];
      // 1. orphan message.started: wake implies no executor is running
      if (state.inFlightModelCall) {
        append.push({
          envelopeId: ids.messageTerminal(state.inFlightModelCall.messageId),
          payloadKind: "message.failed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "interrupted by restart",
            recoverable: true,
          },
          causality: { messageId: state.inFlightModelCall.messageId as never },
          publish: true,
        });
      }
      const afterOrphan = projectAppend(state, append, ctx.now);
      if (
        afterOrphan.openTurn &&
        afterOrphan.openTurn.interrupted &&
        !afterOrphan.inFlightModelCall
      ) {
        return {
          append: [...append, ...interruptCleanupItems(afterOrphan, "user_interrupted")],
          effects: [],
        };
      }
      // 2a. crash between model terminal and tool expansion: the last assistant
      // entry carries toolCall blocks with neither a pending invocation nor a
      // tool-result — re-expand them (idempotent via deterministic ids).
      if (afterOrphan.openTurn && !afterOrphan.openTurn.interrupted && !afterOrphan.inFlightModelCall) {
        const lastAssistant = [...afterOrphan.entries]
          .reverse()
          .find((entry) => entry.kind === "assistant");
        if (lastAssistant && lastAssistant.kind === "assistant") {
          const settled = new Set(
            afterOrphan.entries
              .filter((entry) => entry.kind === "tool-result")
              .map((entry) => (entry as { invocationId: string }).invocationId)
          );
          const unprocessed = lastAssistant.blocks
            .filter(isToolCallBlock)
            .filter(
              (block) =>
                !(block.id in afterOrphan.pendingInvocations) && !settled.has(block.id)
            );
          if (unprocessed.length > 0) {
            const expansion = expandToolCalls(
              afterOrphan,
              unprocessed,
              lastAssistant.messageId,
              afterOrphan.openTurn.turnId,
              ctx
            );
            return { append: [...append, ...expansion.append], effects: expansion.effects };
          }
        }
      }
      // 2+3. open turn + fresh input + guard → next model call
      if (
        afterOrphan.openTurn &&
        !afterOrphan.openTurn.interrupted &&
        wakeGuardSatisfied(afterOrphan) &&
        (hasFreshInput(afterOrphan) || afterOrphan.openTurn.modelCallCount === 0 || append.length > 0)
      ) {
        const next = nextModelCall(afterOrphan, append.length);
        return { append: [...append, ...next.append], effects: next.effects };
      }
      // 4. no open turn + pendingPrompt → C-prompt path
      if (!afterOrphan.openTurn && afterOrphan.pendingPrompt) {
        const prompt = afterOrphan.pendingPrompt;
        const turnId = ids.turnId(state.channelId, prompt.envelopeId);
        const opened: AppendItem = {
          envelopeId: ids.turnOpened(turnId),
          payloadKind: "turn.opened",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
          },
          causality: { turnId },
          publish: true,
        };
        const afterOpened = {
          ...afterOrphan,
          openTurn: {
            turnId,
            openedAtSeq: afterOrphan.lastSeq + append.length + 1,
            modelCallCount: 0,
            interrupted: false,
            waitingCount: 0,
            ...(prompt.metadata ? { metadata: prompt.metadata } : {}),
          },
        };
        const { item, effect } = modelStartItems(afterOpened, turnId, 0, append.length + 1);
        return { append: [...append, opened, item], effects: [effect] };
      }
      return { append, effects: [] };
    }

    case "resumeAfterReset": {
      const turn = state.openTurn;
      if (!turn || turn.interrupted || state.inFlightModelCall) return EMPTY;
      if (!command.messageId.startsWith(`m:${turn.turnId}:`)) return EMPTY;
      const resetAtMs = Date.parse(command.resetAt);
      const nowMs = Date.parse(ctx.now);
      if (Number.isFinite(resetAtMs) && Number.isFinite(nowMs) && resetAtMs > nowMs + 1000) {
        return EMPTY;
      }
      if (!wakeGuardSatisfied(state)) return EMPTY;
      const marker: AppendItem = {
        envelopeId: ids.systemEvent(command.messageId, "model-limit-resume-due", state.lastSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "model.limit_resume_due",
          messageId: command.messageId,
          resetAt: command.resetAt,
          details: {
            kind: "model.limit_resume_due",
            messageId: command.messageId,
            resetAt: command.resetAt,
          },
        },
        causality: { turnId: turn.turnId, messageId: command.messageId as never },
        publish: true,
      };
      const next = nextModelCall(state, 1);
      return { append: [marker, ...next.append], effects: next.effects };
    }
  }
}

function eventStep(state: AgentState, envelope: LogEnvelope, ctx: StepContext): StepOutput {
  const kind = envelope.payloadKind;
  const payload =
    envelope.payload && typeof envelope.payload === "object"
      ? (envelope.payload as Record<string, unknown>)
      : {};
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  // NOTE: `state` here is post-fold (the driver folds the envelope first).

  // E-model-terminal
  if (kind === "message.completed" && payload["role"] === "assistant") {
    const turn = state.openTurn;
    if (!turn) return EMPTY;
    const outcome = String(payload["outcome"] ?? "completed");
    if (outcome === "interrupted" || turn.interrupted) {
      return { append: interruptCleanupItems(state, "user_interrupted"), effects: [] };
    }
    const blocks = Array.isArray(payload["blocks"]) ? (payload["blocks"] as unknown[]) : [];
    const toolCalls = blocks.filter(isToolCallBlock);
    if (toolCalls.length > 0) {
      return expandToolCalls(state, toolCalls, String(causality["messageId"] ?? ""), turn.turnId, ctx);
    }
    // no tool calls
    if (state.steeringQueue.length > 0) return nextModelCall(state, 0);
    return { append: [turnClosedItem(turn.turnId)], effects: [] };
  }

  // recoverable model failure → fresh attempt (multi-attempt rule)
  if (kind === "message.failed") {
    const turn = state.openTurn;
    if (!turn || turn.interrupted) return EMPTY;
    if (typeof payload["resetAt"] === "string" && payload["resetAt"].trim()) {
      return {
        append: [
          turnWaitingItem(turn.turnId, turn.waitingCount, {
            reason: "model_usage_limit_reset",
            summary: "Waiting for model usage limit reset",
          }),
        ],
        effects: [],
      };
    }
    if (payload["recoverable"] !== true) {
      return { append: [turnClosedItem(turn.turnId, { reason: "work_failed" })], effects: [] };
    }
    if (!wakeGuardSatisfied(state)) return EMPTY; // guard: invocations first
    return nextModelCall(state, 0);
  }

  // E-invocation-terminal
  if (
    kind === "invocation.completed" ||
    kind === "invocation.failed" ||
    kind === "invocation.cancelled" ||
    kind === "invocation.abandoned"
  ) {
    const turn = state.openTurn;
    if (!turn || turn.interrupted) return EMPTY;
    if (state.inFlightModelCall) return EMPTY;
    if (Object.keys(state.pendingInvocations).length > 0) return EMPTY; // not last yet
    if (Object.keys(state.pendingApprovals).length > 0) return EMPTY;
    if (Object.keys(state.pendingCredentialWaits).length > 0) return EMPTY;
    return nextModelCall(state, 0);
  }

  // E-approval-resolved
  if (kind === "approval.resolved") {
    const invocationId = String(causality["invocationId"] ?? "");
    const invocation = state.pendingInvocations[invocationId];
    if (payload["granted"] === true) {
      if (!invocation) return EMPTY;
      // the invocation.started already exists; only the dispatch effect is new
      return { append: [], effects: [invocationEffect(state, invocation)] };
    }
    // D-deny
    if (!invocation) return EMPTY;
    return {
      append: [
        {
          envelopeId: ids.invocationTerminal(invocationId),
          payloadKind: "invocation.failed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "approval denied",
            terminalOutcome: "tool_error",
            terminalReasonCode: "approval_denied",
          },
          causality: { invocationId: invocationId as never, turnId: invocation.turnId },
          publish: true,
        },
      ],
      effects: [],
    };
  }

  // interrupt marker with no in-flight call → immediate cleanup
  if (kind === "system.event") {
    const details = (payload["details"] ?? {}) as Record<string, unknown>;
    if (details["kind"] === "interrupt" && state.openTurn && !state.inFlightModelCall) {
      return { append: interruptCleanupItems(state, String(details["reason"] ?? "user_interrupted")), effects: [] };
    }
    if (
      (details["kind"] === "credential.wait_resolved" && details["resolved"] === true) ||
      details["kind"] === "credential.resolved"
    ) {
      // resume after credential connect: next model call if the turn is idle
      if (
        state.openTurn &&
        !state.openTurn.interrupted &&
        wakeGuardSatisfied(state) &&
        Object.keys(state.pendingInvocations).length === 0
      ) {
        return nextModelCall(state, 0);
      }
    }
  }

  return EMPTY;
}

function effectFailedStep(
  state: AgentState,
  incoming: Extract<Incoming, { type: "effect-failed" }>,
  _ctx: StepContext
): StepOutput {
  const turn = state.openTurn;
  if (incoming.kind === "model_call") {
    const failure = classifyModelFailure({
      provider: state.inFlightModelCall?.request.provider,
      model: state.inFlightModelCall?.request.model,
      rawReason: incoming.error.message,
      message: incoming.error.message,
      now: _ctx.now,
    });
    const messageId = state.inFlightModelCall?.messageId;
    const append: AppendItem[] = [];
    if (messageId) {
      append.push({
        envelopeId: ids.messageTerminal(messageId),
          payloadKind: "message.failed",
        payload: modelFailurePayload(failure, false),
        causality: { messageId: messageId as never },
        publish: true,
      });
    }
    if (turn && !failure.resetAt) {
      // published diagnostic (replaces agent_turn_outbox emit_diagnostic)
      append.push({
        envelopeId: `diag:${turn.turnId}:${incoming.effectId}`,
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "diagnostic",
              content: `Turn failed: ${failure.reason}`,
              metadata: { code: "work_failed", severity: "error" },
            },
          ],
          outcome: "completed",
        },
        causality: { messageId: `diag:${turn.turnId}:${incoming.effectId}` as never, turnId: turn.turnId },
        publish: true,
      });
      append.push(turnClosedItem(turn.turnId, { reason: "work_failed" }));
    }
    return { append, effects: [] };
  }

  if (incoming.kind === "credential_wait") {
    const wait = Object.values(state.pendingCredentialWaits).find(
      (candidate) => ids.credentialWaitEffect(candidate.credKey) === incoming.effectId
    );
    const append: AppendItem[] = [];
    if (wait) {
      append.push({
        envelopeId: ids.systemEvent(wait.credKey, "expired", wait.startedAtSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "credential.wait_expired",
          credKey: wait.credKey,
          details: { kind: "credential.wait_expired", credKey: wait.credKey, providerId: wait.providerId },
        },
        causality: { turnId: wait.turnId },
        publish: true,
      });
    }
    if (turn) append.push(turnClosedItem(turn.turnId, { reason: "work_failed" }));
    return { append, effects: [] };
  }

  if (incoming.kind === "publish_envelope") {
    // Best-effort, fire-and-forget (§1.4.6): never tracked as pending state and
    // never re-derived, so a failed publish is simply dropped. It must NOT close
    // the turn or emit an error diagnostic (the prior fall-through to the
    // unmapped-effect catch-all incorrectly failed the turn on a dropped publish).
    return EMPTY;
  }

  // Exhaustiveness guard: after the model_call/credential_wait/publish_envelope
  // branches above, the only remaining effect kinds are the invocation-style
  // ones, dispatched by effect-id prefix below (form: approval / inv:
  // tool-or-channel-or-http). If a new EffectKind is ever added to effects.ts
  // without a branch here, this assignment fails to compile — preventing the
  // AL-7 class of silently-unmapped effect that returns EMPTY and wedges the
  // driver in a re-dispatch loop.
  const _invocationKind: "local_tool" | "channel_call" | "http_call" = incoming.kind;
  void _invocationKind;

  if (incoming.effectId.startsWith("form:")) {
    const approvalId = incoming.effectId.slice(5);
    const approval = state.pendingApprovals[approvalId];
    if (!approval) return EMPTY;
    return {
      append: [
        {
          envelopeId: ids.approvalResolved(approvalId),
          payloadKind: "approval.resolved",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            granted: false,
            resolvedBy: { kind: "system", id: "delivery-failed" },
            reason: incoming.error.message || "delivery-failed",
          },
          causality: {
            approvalId: approvalId as never,
            invocationId: approval.invocationId as never,
            turnId: approval.turnId,
          },
          publish: true,
        },
      ],
      effects: [],
    };
  }

  if (!incoming.effectId.startsWith("inv:")) {
    const append: AppendItem[] = [];
    if (turn) {
      const messageId = `diag:${turn.turnId}:unknown-effect:${incoming.effectId}`;
      append.push({
        envelopeId: messageId,
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "assistant",
          blocks: [
            {
              type: "diagnostic",
              content: `Turn failed: unmapped effect failure ${incoming.effectId}`,
              metadata: { code: "unmapped_effect_failure", severity: "error" },
            },
          ],
          outcome: "completed",
        },
        causality: { messageId: messageId as never, turnId: turn.turnId },
        publish: true,
      });
      append.push(turnClosedItem(turn.turnId, { reason: "work_failed" }));
    }
    return { append, effects: [] };
  }

  // local_tool / channel_call / http_call
  const invocationId = incoming.effectId.slice(4);
  if (!state.pendingInvocations[invocationId]) return EMPTY;
  return {
    append: [
      {
        envelopeId: ids.invocationTerminal(invocationId),
        payloadKind: "invocation.failed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: incoming.error.message,
          terminalOutcome: "infrastructure_error",
          terminalReasonCode: "dispatch_failed",
        },
        causality: {
          invocationId: invocationId as never,
          turnId: state.pendingInvocations[invocationId]!.turnId,
        },
        publish: true,
      },
    ],
    effects: [],
  };
}

interface ToolCallBlock {
  type: string;
  id: string;
  name: string;
  arguments: unknown;
}

function isToolCallBlock(block: unknown): block is ToolCallBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  return (
    (record["type"] === "toolCall" || record["type"] === "tool_call") &&
    typeof record["id"] === "string" &&
    typeof record["name"] === "string"
  );
}

import { patchHash } from "./ids.js";
function patchHashOf(patch: unknown): string {
  return patchHash(patch);
}

// ---------------------------------------------------------------------------
// Policy composition (§1.6)
// ---------------------------------------------------------------------------

export interface StepPolicy {
  name: string;
  intercept(args: {
    state: AgentState;
    incoming: Incoming;
    ctx: StepContext;
    output: StepOutput;
  }): StepOutput;
  /** Optional pass over driver-side appends that bypass step (effect outcome
   *  events) — e.g. the silent policy's publication filter. */
  transformAppend?(args: { state: AgentState; items: AppendItem[] }): AppendItem[];
  /** Optional pass over executor-side signal events that bypass the durable log. */
  filterEphemeral?(args: {
    state: AgentState;
    emit: EphemeralSignal;
  }): EphemeralSignal | null | undefined;
}

export function composeStep(policies: StepPolicy[]): StepFn {
  return (state, incoming, ctx) => {
    let output = coreStep(state, incoming, ctx);
    for (const policy of policies) {
      output = policy.intercept({ state, incoming, ctx, output });
    }
    return output;
  };
}

export { derivePendingEffects, modelCallEffect };
