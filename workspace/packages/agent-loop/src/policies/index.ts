/**
 * Step policies (WS1 §1.6) — pure interceptors over the core step output.
 * Fixed compose order: channel-tools → approval-gate → ask-user → fork →
 * (consumer extras) → compaction.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { ids } from "../ids.js";
import type { AppendItem, ChannelCallEffect, EffectDescriptor } from "../effects.js";
import type { StepOutput, StepPolicy } from "../step.js";
import type { AgentState } from "../state.js";

export const DEFAULT_SAFE_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_user",
  "set_title",
  "close_turn_without_response",
]);

function invocationStartedItems(output: StepOutput): Array<{
  item: AppendItem;
  payload: Record<string, unknown>;
}> {
  return output.append
    .filter((item) => item.payloadKind === "invocation.started")
    .map((item) => ({ item, payload: item.payload as Record<string, unknown> }));
}

/** channel-tools: route roster participant methods over the channel transport. */
export function channelToolsPolicy(): StepPolicy {
  return {
    name: "channel-tools",
    intercept({ state, output }) {
      const roster = state.config.roster?.participants ?? [];
      if (roster.length === 0) return output;
      const methodOwners = new Map<string, ParticipantRef>();
      for (const participant of roster) {
        for (const method of participant.methods ?? []) {
          if (!methodOwners.has(method.name)) methodOwners.set(method.name, participant.ref);
        }
      }
      let changed = false;
      const append = output.append.map((item) => {
        if (item.payloadKind !== "invocation.started") return item;
        const payload = item.payload as Record<string, unknown>;
        const name = String(payload["name"] ?? "");
        const transport = payload["transport"] as { kind?: string } | undefined;
        const owner = methodOwners.get(name);
        if (!owner || transport?.kind !== "local") return item;
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        changed = true;
        return {
          ...item,
          payload: {
            ...payload,
            invocationType: "panel",
            transport: {
              kind: "channel",
              channelId: state.channelId,
              target: owner,
              transportCallId: ids.transportCallId(invocationId),
            },
          },
        };
      });
      if (!changed) return output;
      // effects re-derive from the rewritten payloads
      const effects = output.effects.map((effect) => {
        if (effect.kind !== "local_tool") return effect;
        const rewritten = append.find(
          (item) =>
            item.payloadKind === "invocation.started" &&
            String((item.causality as { invocationId?: string })?.invocationId) ===
              effect.invocationId &&
            (item.payload as { transport?: { kind?: string } }).transport?.kind === "channel"
        );
        if (!rewritten) return effect;
        const payload = rewritten.payload as Record<string, unknown>;
        const transport = payload["transport"] as {
          target: ParticipantRef;
          transportCallId: string;
        };
        const channelEffect: ChannelCallEffect = {
          effectId: effect.effectId,
          kind: "channel_call",
          channelId: effect.channelId,
          idempotencyKey: transport.transportCallId,
          invocationId: effect.invocationId,
          turnId: effect.turnId,
          transportCallId: transport.transportCallId,
          target: transport.target,
          method: String(payload["name"]),
          args: payload["request"],
        };
        return channelEffect;
      });
      return { append, effects };
    },
  };
}

/** approval-gate: today's toolNeedsApproval rule as a pure rewrite. */
export function approvalGatePolicy(): StepPolicy {
  return {
    name: "approval-gate",
    intercept({ state, ctx, output }) {
      const level = state.config.approvalLevel;
      if (level === 2) return output;
      const gatedIds = new Set<string>();
      const append: AppendItem[] = [];
      for (const item of output.append) {
        append.push(item);
        if (item.payloadKind !== "invocation.started") continue;
        const payload = item.payload as Record<string, unknown>;
        const name = String(payload["name"] ?? "");
        if (level === 1 && DEFAULT_SAFE_TOOL_NAMES.has(name)) continue;
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        const approvalId = ids.approvalId(invocationId);
        gatedIds.add(invocationId);
        // mark the started payload as approval-gated
        append[append.length - 1] = {
          ...item,
          payload: { ...payload, requiresApproval: true },
        };
        append.push({
          envelopeId: ids.approvalRequested(approvalId),
          payloadKind: "approval.requested",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            question: "Allow tool call?",
            requestedBy: ctx.selfRef,
            details: { toolName: name, input: payload["request"] },
          },
          causality: {
            approvalId: approvalId as never,
            invocationId: invocationId as never,
            modelToolCallId: invocationId,
            turnId: (item.causality as { turnId?: string } | undefined)?.turnId,
          },
          publish: true,
        });
      }
      if (gatedIds.size === 0) return output;
      // the gated tools' dispatch effects become derivable only after grant;
      // the approval form effect is derived by the reconcile (or here).
      const effects = output.effects.filter(
        (effect) =>
          !(
            (effect.kind === "local_tool" ||
              effect.kind === "channel_call" ||
              effect.kind === "http_call") &&
            gatedIds.has(effect.invocationId)
          )
      );
      return { append, effects };
    },
  };
}

/** ask-user: rewrite ask_user invocations to a channel call to the prompter. */
export function askUserPolicy(): StepPolicy {
  return {
    name: "ask-user",
    intercept({ state, output }) {
      const promptingUser = state.config.roster?.participants?.find(
        (participant) => participant.type === "panel" || participant.ref.kind === "user"
      );
      if (!promptingUser) return output;
      const rewrittenIds = new Map<string, ParticipantRef>();
      const append = output.append.map((item) => {
        if (item.payloadKind !== "invocation.started") return item;
        const payload = item.payload as Record<string, unknown>;
        if (payload["name"] !== "ask_user") return item;
        const invocationId = String(
          (item.causality as { invocationId?: string } | undefined)?.invocationId ?? ""
        );
        rewrittenIds.set(invocationId, promptingUser.ref);
        return {
          ...item,
          payload: {
            ...payload,
            name: "feedback_form",
            invocationType: "user",
            request: feedbackFormArgsFromAskUser(payload["request"]),
            transport: {
              kind: "channel",
              channelId: state.channelId,
              target: promptingUser.ref,
              transportCallId: ids.transportCallId(invocationId),
            },
          },
        };
      });
      if (rewrittenIds.size === 0) return output;
      const effects = output.effects.map((effect): EffectDescriptor => {
        if (effect.kind !== "local_tool" || !rewrittenIds.has(effect.invocationId)) return effect;
        const target = rewrittenIds.get(effect.invocationId)!;
        return {
          effectId: effect.effectId,
          kind: "channel_call",
          channelId: effect.channelId,
          idempotencyKey: ids.transportCallId(effect.invocationId),
          invocationId: effect.invocationId,
          turnId: effect.turnId,
          transportCallId: ids.transportCallId(effect.invocationId),
          target,
          method: "feedback_form",
          args: feedbackFormArgsFromAskUser(effect.args),
          purpose: "ask-user",
        };
      });
      return { append, effects };
    },
  };
}

function feedbackFormArgsFromAskUser(raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const question =
    typeof input["question"] === "string" && input["question"].trim()
      ? input["question"]
      : "Question";
  const options = Array.isArray(input["options"])
    ? input["options"].filter((option): option is string => typeof option === "string")
    : [];
  if (options.length > 0) {
    const allowFreeText = input["allowFreeform"] === false ? false : undefined;
    const multiSelect = input["multiSelect"] === true;
    return {
      title: question,
      fields: [
        {
          key: "answer",
          type: multiSelect ? "multiSelect" : "select",
          label: question,
          required: true,
          options: options.map((option) => ({ value: option, label: option })),
          ...(allowFreeText === false ? { allowFreeText } : {}),
          ...(multiSelect ? {} : { submitOnSelect: input["allowFreeform"] !== true }),
        },
      ],
      hideSubmit: multiSelect ? false : input["allowFreeform"] !== true,
    };
  }
  return {
    title: question,
    fields: [{ key: "answer", type: "string", label: question, required: true }],
  };
}

/** fork: on wake, settle every pre-cut pending under the forked head. */
export function forkPolicy(): StepPolicy {
  return {
    name: "fork",
    intercept({ state, incoming, output }) {
      if (incoming.type !== "command" || incoming.command.kind !== "wake") return output;
      if (state.forkSeq <= 0) return output;
      const append: AppendItem[] = [...output.append];
      const preCut = <T extends { startedAtSeq: number }>(record: Record<string, T>) =>
        Object.values(record).filter((item) => item.startedAtSeq <= state.forkSeq);
      for (const invocation of preCut(state.pendingInvocations)) {
        append.push({
          envelopeId: ids.invocationTerminal(invocation.invocationId),
          payloadKind: "invocation.abandoned",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            reason: "forked",
            terminalOutcome: "abandoned",
            terminalReasonCode: "forked",
          },
          causality: {
            invocationId: invocation.invocationId as never,
            turnId: invocation.turnId,
          },
          publish: true,
        });
      }
      for (const approval of preCut(state.pendingApprovals)) {
        append.push({
          envelopeId: ids.approvalResolved(approval.approvalId),
          payloadKind: "approval.resolved",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            granted: false,
            resolvedBy: { kind: "system", id: "fork" },
            reason: "forked",
          },
          causality: {
            approvalId: approval.approvalId as never,
            invocationId: approval.invocationId as never,
            turnId: approval.turnId,
          },
          publish: true,
        });
      }
      for (const wait of preCut(state.pendingCredentialWaits)) {
        append.push({
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
              reason: "forked",
            },
          },
          causality: { turnId: wait.turnId },
          publish: true,
        });
      }
      if (state.openTurn && state.openTurn.openedAtSeq <= state.forkSeq) {
        append.push({
          envelopeId: ids.turnClosed(state.openTurn.turnId),
          payloadKind: "turn.closed",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: "forked" },
          causality: { turnId: state.openTurn.turnId },
          publish: true,
        });
        // a wake-generated model_call for the pre-cut turn must not survive
        const effects = output.effects.filter((effect) => effect.kind !== "model_call");
        return { append, effects };
      }
      return { append, effects: output.effects };
    },
  };
}

/** silent: suppress publication of everything except turn open/close; the
 *  agent speaks only through its explicit `say` tool. */
export function silentPolicy(): StepPolicy {
  const filter = (items: AppendItem[]): AppendItem[] =>
    items.map((item) =>
      item.payloadKind === "turn.opened" || item.payloadKind === "turn.closed"
        ? item
        : { ...item, publish: false }
    );
  return {
    name: "silent",
    intercept({ output }) {
      return { append: filter(output.append), effects: output.effects };
    },
    transformAppend({ items }) {
      return filter(items);
    },
    filterEphemeral() {
      return null;
    },
  };
}

export function defaultPolicies(): StepPolicy[] {
  return [channelToolsPolicy(), approvalGatePolicy(), askUserPolicy(), forkPolicy()];
}
