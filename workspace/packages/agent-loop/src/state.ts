/**
 * AgentState (WS1 §1.1) — derived by fold, never stored authoritatively
 * (the driver's fold_cache is a P1 cache). All fields JSON-serializable;
 * large payloads remain `natstack.blob-ref.v1` refs inside entries
 * (hydration happens in executors, never in the fold).
 */

import type { InvocationTransport, ParticipantRef } from "@workspace/agentic-protocol";

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type RespondPolicy =
  | "all"
  | "mentioned"
  | "mentioned-strict"
  | "mentioned-or-followup"
  | "from-participants";

export interface RosterMethod {
  name: string;
  description?: string;
  /** JSON Schema for the method's arguments (from the participant's
   *  method advertisement) — exposed to the model as the tool schema. */
  parameters?: unknown;
}

export interface RosterEntry {
  participantId: string;
  ref: ParticipantRef;
  handle?: string;
  type?: string;
  methods: RosterMethod[];
}

export interface RosterSnapshot {
  participants: RosterEntry[];
}

export interface AgentLoopConfig {
  model: string;
  thinkingLevel: ThinkingLevel;
  approvalLevel: 0 | 1 | 2;
  respondPolicy: RespondPolicy;
  systemPromptHash: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  roster: RosterSnapshot;
  agentHopLimit?: number;
  /** Optional cap for model rounds in one turn. Null/undefined means unlimited. */
  maxModelCallsPerTurn?: number | null;
  /** Idle watchdog for model streams. `null` intentionally disables it. */
  modelStreamIdleTimeoutMs?: number | null;
}

export interface AgentTurnContextPolicy {
  mode?: "full" | "heartbeat" | "isolated";
  includeWorkspacePrompt?: boolean;
  includeSkillIndex?: boolean;
  promptFile?: string;
  promptFileContent?: string;
  tokenBudget?: number;
}

export interface AgentTurnMetadata {
  origin?: "agent-initiated" | "heartbeat" | "scheduled";
  contextPolicy?: AgentTurnContextPolicy;
  loopConfigPatch?: {
    maxModelCallsPerTurn?: number | null;
    modelStreamIdleTimeoutMs?: number | null;
  };
  delivery?: "none" | "channel" | "last-contact";
  ackToken?: string;
  silentOk?: boolean;
}

/** Config fields that are FOLD-OWNED: the reducer derives them from the log
 *  (roster from `roster.snapshot` events), so a reload must keep the folded
 *  value, NOT the vessel's injected input config (which carries an empty
 *  sentinel roster). Everything else in AgentLoopConfig is INPUT-OWNED
 *  (settings the vessel injects: model/prompt/tool hashes/active tools) and
 *  must overlay so updated settings reach the model. */
const FOLD_OWNED_CONFIG_KEYS = ["roster"] as const;

/** Overlay input-owned config onto a folded state's config while preserving
 *  fold-owned fields (see FOLD_OWNED_CONFIG_KEYS). Used by the fold cache on
 *  every reload: input settings win, but the folded roster survives so
 *  channel tools don't vanish after an eviction/reload. */
export function overlayInputConfig(
  folded: AgentLoopConfig,
  input: AgentLoopConfig
): AgentLoopConfig {
  const merged = { ...input };
  for (const key of FOLD_OWNED_CONFIG_KEYS) {
    (merged as Record<string, unknown>)[key] = folded[key];
  }
  return merged;
}

export interface ModelRequestDescriptor {
  provider: string;
  model: string;
  modelBaseUrl?: string;
  thinkingLevel: ThinkingLevel;
  systemPromptHash: string;
  skillIndexHash?: string;
  toolSchemasHash?: string;
  activeToolNames: string[];
  /** entries snapshot boundary; executor rebuilds context through this seq. */
  contextThroughSeq: number;
  attemptId: string;
  streamOptions?: { deltaBatchMs?: number; idleTimeoutMs?: number | null };
  turnMetadata?: AgentTurnMetadata;
}

export interface OpenTurn {
  turnId: string;
  openedAtSeq: number;
  reason?: string;
  /** count of message.started in this turn — drives messageId derivation. */
  modelCallCount: number;
  /** system.event {interrupt} seen since the turn opened (gates new model calls). */
  interrupted: boolean;
  /** count of turn.waiting events (drives waiting envelope id suffix). */
  waitingCount: number;
  metadata?: AgentTurnMetadata;
}

export interface InFlightModelCall {
  messageId: string;
  attemptId: string;
  contextThroughSeq: number;
  request: ModelRequestDescriptor;
}

export interface PendingInvocation {
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  /** originating model attempt (causality.attemptId). */
  attemptId?: string;
  name: string;
  transport: InvocationTransport;
  request: unknown;
  requiresApproval: boolean;
  approvalId?: string;
  approvalState: "none" | "pending" | "granted";
}

export interface PendingApproval {
  approvalId: string;
  invocationId: string;
  turnId: string;
  startedAtSeq: number;
  question: string;
  details: { toolName: string; input: unknown };
}

export interface PendingCredentialWait {
  credKey: string;
  providerId: string;
  turnId: string;
  startedAtSeq: number;
  connectSpec: Record<string, unknown>;
  modelBaseUrl?: string;
  waitReason?: "model_credential_required" | "model_credential_reconnect_required";
  reason?: string;
  failureCode?: string;
  /** ISO; from the logged event, never wall clock. */
  expiresAt: string;
}

export interface SteeringEntry {
  envelopeId: string;
  seq: number;
  senderRef: ParticipantRef;
  content: unknown;
  metadata?: AgentTurnMetadata;
}

export interface PendingPrompt {
  envelopeId: string;
  seq: number;
  senderRef: ParticipantRef;
  content: unknown;
  agentHops?: number;
  metadata?: AgentTurnMetadata;
}

/** Linear session entry — the materialized model-context path. */
export type SessionEntry =
  | {
      kind: "user";
      seq: number;
      envelopeId: string;
      senderRef?: ParticipantRef;
      content: unknown;
      metadata?: AgentTurnMetadata;
    }
  | {
      kind: "assistant";
      seq: number;
      messageId: string;
      blocks: unknown[];
      outcome?: string;
    }
  | {
      kind: "tool-result";
      seq: number;
      invocationId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | { kind: "note"; seq: number; text: string };

export interface AgentState {
  logId: string;
  head: string;
  channelId: string;
  /** seq of last folded envelope. */
  lastSeq: number;
  /** hash of last folded envelope (== expectedHeadHash for the next append). */
  lastHash: string;
  /** fork boundary of this head (0 for root logs); pendings with
   *  startedAtSeq ≤ forkSeq are pre-cut (fork policy). */
  forkSeq: number;

  config: AgentLoopConfig;
  entries: SessionEntry[];

  openTurn: OpenTurn | null;
  inFlightModelCall: InFlightModelCall | null;
  pendingInvocations: Record<string, PendingInvocation>;
  pendingApprovals: Record<string, PendingApproval>;
  pendingCredentialWaits: Record<string, PendingCredentialWait>;
  steeringQueue: SteeringEntry[];
  pendingPrompt: PendingPrompt | null;
}

export const GENESIS_LAST_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export interface InitialStateInput {
  channelId: string;
  logId?: string;
  head?: string;
  config: AgentLoopConfig;
  forkSeq?: number;
  lastSeq?: number;
  lastHash?: string;
}

export function initialAgentState(input: InitialStateInput): AgentState {
  const logId = input.logId ?? `branch:channel:${input.channelId}`;
  return {
    logId,
    head: input.head ?? logId,
    channelId: input.channelId,
    lastSeq: input.lastSeq ?? input.forkSeq ?? 0,
    lastHash: input.lastHash ?? GENESIS_LAST_HASH,
    forkSeq: input.forkSeq ?? 0,
    config: input.config,
    entries: [],
    openTurn: null,
    inFlightModelCall: null,
    pendingInvocations: {},
    pendingApprovals: {},
    pendingCredentialWaits: {},
    steeringQueue: [],
    pendingPrompt: null,
  };
}

/** Derived turn status — replaces the old 8-state agent_turn_runs FSM. */
export function derivedTurnStatus(state: AgentState):
  | "idle"
  | "starting"
  | "running_model"
  | "waiting_external"
  | "continuing" {
  if (!state.openTurn) return "idle";
  if (state.inFlightModelCall) return "running_model";
  if (state.openTurn.modelCallCount === 0) return "starting";
  const pendings = Object.values(state.pendingInvocations);
  const hasExternal =
    pendings.some((inv) => inv.transport.kind !== "local") ||
    Object.keys(state.pendingApprovals).length > 0 ||
    Object.keys(state.pendingCredentialWaits).length > 0;
  if (pendings.length > 0 || hasExternal) return "waiting_external";
  return "continuing";
}
