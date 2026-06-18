/**
 * The fold (WS1 §1.2): one pure reducer over trajectory log envelopes.
 * Same log prefix → same state, forever (P4). No wall clock, no randomness,
 * no I/O. Events not handled fold to `state` unchanged except the universal
 * lastSeq/lastHash advance.
 */

import type { LogEnvelope } from "@workspace/agentic-protocol";
import type {
  AgentState,
  ModelRequestDescriptor,
  PendingInvocation,
  SessionEntry,
} from "./state.js";

function payloadRecord(envelope: LogEnvelope): Record<string, unknown> {
  const payload = envelope.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function withAdvance(state: AgentState, envelope: LogEnvelope): AgentState {
  return { ...state, lastSeq: envelope.seq, lastHash: envelope.hash };
}

export function applyEvent(prev: AgentState, envelope: LogEnvelope): AgentState {
  const state = withAdvance(prev, envelope);
  const kind = envelope.payloadKind;
  const payload = payloadRecord(envelope);
  const causality = (envelope.causality ?? {}) as Record<string, unknown>;
  const turnId = typeof causality["turnId"] === "string" ? (causality["turnId"] as string) : undefined;

  switch (true) {
    case kind === "message.delta":
      // Deltas are signal-only and never in the log (§2.4.1).
      throw new Error("message.delta must never be appended to a trajectory log");

    case kind === "turn.opened": {
      if (!turnId) return state;
      return {
        ...state,
        openTurn: {
          turnId,
          openedAtSeq: envelope.seq,
          reason: typeof payload["reason"] === "string" ? (payload["reason"] as string) : undefined,
          modelCallCount: 0,
          interrupted: false,
          waitingCount: 0,
        },
        pendingPrompt: null,
      };
    }

    case kind === "turn.closed": {
      if (state.openTurn && turnId && state.openTurn.turnId !== turnId) return state;
      return { ...state, openTurn: null, inFlightModelCall: null };
    }

    case kind === "turn.waiting": {
      if (!state.openTurn) return state;
      return {
        ...state,
        openTurn: { ...state.openTurn, waitingCount: state.openTurn.waitingCount + 1 },
      };
    }

    case kind === "message.started": {
      const role = payload["role"];
      if (role !== "assistant") return state;
      const messageId = String(causality["messageId"] ?? "");
      const request = payload["modelRequest"] as ModelRequestDescriptor | undefined;
      if (!request) {
        throw new Error(`assistant message.started ${messageId} lacks a modelRequest descriptor`);
      }
      const contextThroughSeq = request.contextThroughSeq;
      return {
        ...state,
        inFlightModelCall: {
          messageId,
          attemptId: request.attemptId,
          contextThroughSeq,
          request,
        },
        openTurn: state.openTurn
          ? { ...state.openTurn, modelCallCount: state.openTurn.modelCallCount + 1 }
          : state.openTurn,
        // Steered messages covered by this call's context snapshot are consumed.
        steeringQueue: state.steeringQueue.filter((entry) => entry.seq > contextThroughSeq),
      };
    }

    case kind === "message.completed": {
      const role = payload["role"];
      const messageId = String(causality["messageId"] ?? "");
      if (role === "assistant") {
        if (state.inFlightModelCall && state.inFlightModelCall.messageId !== messageId) {
          return state; // stale terminal for an older attempt — fold ignores
        }
        const entry: SessionEntry = {
          kind: "assistant",
          seq: envelope.seq,
          messageId,
          blocks: Array.isArray(payload["blocks"]) ? (payload["blocks"] as unknown[]) : [],
          outcome:
            typeof payload["outcome"] === "string" ? (payload["outcome"] as string) : undefined,
        };
        return {
          ...state,
          inFlightModelCall: null,
          entries: [...state.entries, entry],
        };
      }
      // user (or panel) message — row 3
      const entry: SessionEntry = {
        kind: "user",
        seq: envelope.seq,
        envelopeId: String(envelope.envelopeId),
        senderRef: envelope.actor,
        content: payload,
      };
      const steering = {
        envelopeId: String(envelope.envelopeId),
        seq: envelope.seq,
        senderRef: envelope.actor,
        content: payload,
      };
      if (state.openTurn) {
        return {
          ...state,
          entries: [...state.entries, entry],
          steeringQueue: [...state.steeringQueue, steering],
        };
      }
      return {
        ...state,
        entries: [...state.entries, entry],
        pendingPrompt: {
          envelopeId: String(envelope.envelopeId),
          seq: envelope.seq,
          senderRef: envelope.actor,
          content: payload,
          agentHops:
            typeof causality["agentHops"] === "number"
              ? (causality["agentHops"] as number)
              : undefined,
        },
      };
    }

    case kind === "message.failed": {
      const messageId = String(causality["messageId"] ?? "");
      if (state.inFlightModelCall && state.inFlightModelCall.messageId !== messageId) return state;
      return { ...state, inFlightModelCall: null };
    }

    case kind === "invocation.started": {
      const invocationId = String(causality["invocationId"] ?? "");
      if (!invocationId) return state;
      const transport = payload["transport"] as PendingInvocation["transport"] | undefined;
      if (!transport) {
        throw new Error(`invocation.started ${invocationId} lacks a transport (WS1 §1.9)`);
      }
      const pending: PendingInvocation = {
        invocationId,
        turnId: turnId ?? state.openTurn?.turnId ?? "",
        startedAtSeq: envelope.seq,
        attemptId:
          typeof causality["attemptId"] === "string"
            ? (causality["attemptId"] as string)
            : undefined,
        name: String(payload["name"] ?? "unknown"),
        transport,
        request: payload["request"],
        requiresApproval: payload["requiresApproval"] === true,
        approvalState: payload["requiresApproval"] === true ? "none" : "none",
      };
      return {
        ...state,
        pendingInvocations: { ...state.pendingInvocations, [invocationId]: pending },
      };
    }

    case kind === "invocation.completed" ||
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned": {
      const invocationId = String(causality["invocationId"] ?? "");
      const pending = state.pendingInvocations[invocationId];
      if (!pending) return state;
      const { [invocationId]: _removed, ...rest } = state.pendingInvocations;
      const entry: SessionEntry =
        kind === "invocation.completed"
          ? {
              kind: "tool-result",
              seq: envelope.seq,
              invocationId,
              name: pending.name,
              result: payload["result"],
              isError: false,
            }
          : {
              kind: "tool-result",
              seq: envelope.seq,
              invocationId,
              name: pending.name,
              result:
                kind === "invocation.abandoned"
                  ? `abandoned: ${String(payload["reason"] ?? "abandoned")}`
                  : (payload["error"] ?? payload["reason"] ?? "failed"),
              isError: true,
            };
      return {
        ...state,
        pendingInvocations: rest,
        entries: [...state.entries, entry],
      };
    }

    case kind === "approval.requested": {
      const approvalId = String(causality["approvalId"] ?? "");
      const invocationId = String(causality["invocationId"] ?? "");
      if (!approvalId) return state;
      const details = (payload["details"] ?? {}) as { toolName?: string; input?: unknown };
      const invocation = state.pendingInvocations[invocationId];
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [approvalId]: {
            approvalId,
            invocationId,
            turnId: turnId ?? state.openTurn?.turnId ?? "",
            startedAtSeq: envelope.seq,
            question: String(payload["question"] ?? "Allow tool call?"),
            details: { toolName: details.toolName ?? "", input: details.input },
          },
        },
        pendingInvocations: invocation
          ? {
              ...state.pendingInvocations,
              [invocationId]: { ...invocation, approvalState: "pending", approvalId },
            }
          : state.pendingInvocations,
      };
    }

    case kind === "approval.resolved": {
      const approvalId = String(causality["approvalId"] ?? "");
      const approval = state.pendingApprovals[approvalId];
      if (!approval) return state;
      const { [approvalId]: _removedApproval, ...restApprovals } = state.pendingApprovals;
      const invocation = state.pendingInvocations[approval.invocationId];
      const granted = payload["granted"] === true;
      return {
        ...state,
        pendingApprovals: restApprovals,
        pendingInvocations:
          invocation && granted
            ? {
                ...state.pendingInvocations,
                [approval.invocationId]: { ...invocation, approvalState: "granted" },
              }
            : state.pendingInvocations,
        // denied: invocation stays pending until step appends its
        // invocation.failed (D-deny).
      };
    }

    case kind === "system.compaction_recorded": {
      const replacement = payload["replacement"];
      return {
        ...state,
        entries: Array.isArray(replacement) ? (replacement as SessionEntry[]) : state.entries,
      };
    }

    case kind === "system.event": {
      const details = (payload["details"] ?? {}) as Record<string, unknown>;
      const detailKind = String(details["kind"] ?? payload["kind"] ?? "");
      if (detailKind === "credential.wait_started") {
        // Payload-first: emitters mirror fold-critical fields at the payload
        // top level so an (oversized-details) blob spill can't blind the fold.
        const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
        const modelBaseUrl = payload["modelBaseUrl"] ?? details["modelBaseUrl"];
        const waitReason = payload["waitReason"] ?? details["waitReason"];
        const reason = payload["reason"] ?? details["reason"];
        const failureCode = payload["failureCode"] ?? details["failureCode"];
        const messageId = String(payload["messageId"] ?? details["messageId"] ?? causality["messageId"] ?? "");
        const next: AgentState = {
          ...state,
          pendingCredentialWaits: {
            ...state.pendingCredentialWaits,
            [credKey]: {
              credKey,
              providerId: String(payload["providerId"] ?? details["providerId"] ?? ""),
              turnId: turnId ?? state.openTurn?.turnId ?? "",
              startedAtSeq: envelope.seq,
              connectSpec: (details["connectSpec"] ?? {}) as Record<string, unknown>,
              modelBaseUrl: typeof modelBaseUrl === "string" ? modelBaseUrl : undefined,
              waitReason:
                waitReason === "model_credential_reconnect_required" ||
                waitReason === "model_credential_required"
                  ? waitReason
                  : undefined,
              reason: typeof reason === "string" ? reason : undefined,
              failureCode: typeof failureCode === "string" ? failureCode : undefined,
              expiresAt: String(payload["expiresAt"] ?? details["expiresAt"] ?? ""),
            },
          },
        };
        if (messageId && next.inFlightModelCall?.messageId === messageId) {
          return { ...next, inFlightModelCall: null };
        }
        return next;
      }
      if (detailKind === "credential.wait_resolved" || detailKind === "credential.wait_expired") {
        const credKey = String(payload["credKey"] ?? details["credKey"] ?? "");
        if (!(credKey in state.pendingCredentialWaits)) return state;
        const { [credKey]: _removedWait, ...restWaits } = state.pendingCredentialWaits;
        return { ...state, pendingCredentialWaits: restWaits };
      }
      if (detailKind === "roster.snapshot") {
        return {
          ...state,
          config: {
            ...state.config,
            roster: (details["roster"] ?? { participants: [] }) as AgentState["config"]["roster"],
          },
        };
      }
      if (detailKind === "config.changed") {
        return {
          ...state,
          config: { ...state.config, ...(details["patch"] as Record<string, unknown>) },
        };
      }
      if (detailKind === "interrupt") {
        return state.openTurn
          ? { ...state, openTurn: { ...state.openTurn, interrupted: true } }
          : state;
      }
      return state;
    }

    default:
      return state;
  }
}

export function foldEvents(initial: AgentState, envelopes: LogEnvelope[]): AgentState {
  let state = initial;
  for (const envelope of envelopes) state = applyEvent(state, envelope);
  return state;
}
