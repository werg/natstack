import type { EventId, StateHash, TurnId } from "./ids.js";
import type { TrajectoryEvent } from "./events.js";
import { assertNoStoredValueRefs } from "./stored-values.js";
import {
  applyApprovalEvent,
  applyInvocationEvent,
  applyMessageEvent,
  type ApprovalMap,
  type InvocationMap,
  type MessageMap,
  type ProjectedTurn,
  type TurnMap,
} from "./handlers.js";

export interface BranchProjection {
  branchId: string;
  headEventId?: EventId;
  headEventHash?: string;
  headStateHash?: StateHash;
  seq: number;
  parentBranchId?: string;
  forkEventId?: EventId;
}

export interface TrajectoryState {
  trajectoryId?: string;
  branches: Record<string, BranchProjection>;
  openTurnIdByBranch: Record<string, TurnId | undefined>;
  turns: TurnMap;
  messages: MessageMap;
  invocations: InvocationMap;
  approvals: ApprovalMap;
  systemEvents: TrajectoryEvent[];
  stateEvents: TrajectoryEvent[];
  knowledgeEvents: TrajectoryEvent[];
  eventIds: string[];
}

export function createInitialTrajectoryState(): TrajectoryState {
  return {
    branches: {},
    openTurnIdByBranch: {},
    turns: {},
    messages: {},
    invocations: {},
    approvals: {},
    systemEvents: [],
    stateEvents: [],
    knowledgeEvents: [],
    eventIds: [],
  };
}

export function reduceTrajectory(
  state: TrajectoryState,
  event: TrajectoryEvent,
): TrajectoryState {
  assertNoStoredValueRefs(event, "trajectory reducer input");
  const branchId = event.branchId;
  const branch: BranchProjection = {
    ...(state.branches[branchId] ?? { branchId, seq: -1 }),
    headEventId: event.eventId,
    headEventHash: event.eventHash,
    seq: event.seq,
  };

  let next: TrajectoryState = {
    ...state,
    trajectoryId: event.trajectoryId,
    branches: { ...state.branches, [branchId]: branch },
    eventIds: [...state.eventIds, event.eventId],
  };

  if (event.kind.startsWith("message.")) {
    next = { ...next, messages: applyMessageEvent(next.messages, event as never, event.seq) };
  } else if (event.kind.startsWith("invocation.")) {
    next = { ...next, invocations: applyInvocationEvent(next.invocations, event as never) };
  } else if (event.kind.startsWith("approval.")) {
    next = { ...next, approvals: applyApprovalEvent(next.approvals, event as never) };
  } else if (event.kind === "turn.opened") {
    if (!event.turnId) throw new Error("turn.opened requires turnId");
    const turn: ProjectedTurn = {
      turnId: event.turnId,
      actor: event.actor,
      status: "open",
      openedAt: event.createdAt,
      summary: "summary" in event.payload ? event.payload.summary : undefined,
      reason: "reason" in event.payload ? event.payload.reason : undefined,
    };
    next = {
      ...next,
      openTurnIdByBranch: { ...next.openTurnIdByBranch, [branchId]: event.turnId },
      turns: { ...next.turns, [event.turnId]: turn },
    };
  } else if (event.kind === "turn.waiting") {
    if (!event.turnId) throw new Error("turn.waiting requires turnId");
    const existing = next.turns[event.turnId];
    next = {
      ...next,
      openTurnIdByBranch: { ...next.openTurnIdByBranch, [branchId]: event.turnId },
      turns: {
        ...next.turns,
        [event.turnId]: {
          ...(existing ?? {
            turnId: event.turnId,
            actor: event.actor,
            openedAt: event.createdAt,
          }),
          actor: existing?.actor ?? event.actor,
          status: "waiting",
          updatedAt: event.createdAt,
          summary: "summary" in event.payload ? event.payload.summary : existing?.summary,
          reason: "reason" in event.payload ? event.payload.reason : existing?.reason,
        },
      },
    };
  } else if (event.kind === "turn.closed") {
    if (!event.turnId) throw new Error("turn.closed requires turnId");
    const existing = next.turns[event.turnId];
    next = {
      ...next,
      openTurnIdByBranch: { ...next.openTurnIdByBranch, [branchId]: undefined },
      turns: {
        ...next.turns,
        [event.turnId]: {
          ...(existing ?? {
            turnId: event.turnId,
            actor: event.actor,
            openedAt: event.createdAt,
          }),
          status: "closed",
          closedAt: event.createdAt,
          summary: "summary" in event.payload ? event.payload.summary : existing?.summary,
          reason: "reason" in event.payload ? event.payload.reason : existing?.reason,
        },
      },
    };
  } else if (event.kind.startsWith("branch.")) {
    const payload = event.payload;
    next = {
      ...next,
      branches: {
        ...next.branches,
        [branchId]: {
          ...branch,
          parentBranchId: "parentBranchId" in payload ? payload.parentBranchId : branch.parentBranchId,
          forkEventId: "forkEventId" in payload ? payload.forkEventId : branch.forkEventId,
          headStateHash: "headStateHash" in payload ? payload.headStateHash : branch.headStateHash,
        },
      },
    };
  } else if (event.kind.startsWith("state.")) {
    next = { ...next, stateEvents: [...next.stateEvents, event] };
  } else if (event.kind.startsWith("knowledge.")) {
    next = { ...next, knowledgeEvents: [...next.knowledgeEvents, event] };
  } else if (event.kind.startsWith("system.")) {
    next = { ...next, systemEvents: [...next.systemEvents, event] };
  }

  return next;
}

export function userVisibleTrajectoryProjection(state: TrajectoryState) {
  return {
    messages: state.messages,
    invocations: state.invocations,
    approvals: state.approvals,
  };
}
