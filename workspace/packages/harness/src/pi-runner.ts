/**
 * PiRunner - NatStack's thin AgentHarness host.
 *
 * The runner owns NatStack-specific wiring around upstream AgentHarness:
 * resource loading, extension-hosted tools, approval/UI dispatch, gad
 * provenance, file mutation recovery, and runner-local HookBus events.
 */

import {
  AgentHarness,
  InMemorySessionRepo,
  Session,
  uuidv7,
  type AgentHarnessEvent,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  ExecutionError,
  type ExecutionEnv,
  FileError,
  type FileInfo,
  type Result,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getModel as piGetModel, type ImageContent, type Model } from "@earendil-works/pi-ai";
import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { isAbsolute, relative as relativePath } from "node:path";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@natstack/shared/userlandServiceRpc";

import type { RuntimeFs } from "./tools/runtime-fs.js";
import {
  type NatStackResources,
  type RpcCaller,
  loadNatStackResources,
} from "./resource-loader.js";
import { composeSystemPrompt, type SystemPromptMode } from "./system-prompt.js";
import { isTurnSuspensionSignal, type TurnSuspensionSignal } from "./turn-suspension.js";
import { PiExtensionRuntime } from "./pi-extension-runtime.js";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  resolveReadPath,
  resolveToCwd,
} from "./tools/index.js";
import {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
} from "./extensions/approval-gate.js";
import {
  createChannelToolsExtension,
  type ChannelToolMethod,
  type StreamUpdateCallback,
} from "./extensions/channel-tools.js";
import { createAskUserExtension, type AskUserParams } from "./extensions/ask-user.js";
import { createWebToolsExtension } from "./extensions/web/index.js";
import type { CredentialPresenceProbe } from "./extensions/web/provider.js";
import {
  NatStackUiToolResultError,
  type NatStackScopedUiContext,
} from "./natstack-extension-context.js";
import {
  TrajectoryBackedSessionStorage,
  materializeSessionTree,
  sessionEntryToAgenticEvent,
  type TrajectorySessionMetadata,
} from "@workspace/pi-adapter";
import {
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  createInitialTrajectoryState,
  encodeAgenticEventStoredValues,
  hydrateStoredValueRefs,
  invocationAbandonedPayload,
  invocationCancelledPayload,
  invocationCompletedPayload,
  invocationFailedPayload,
  invocationTerminalKindForOutcome,
  MAX_INLINE_TRAJECTORY_EVENT_BYTES,
  messageDisplayText,
  reduceTrajectory,
  summarizeMessageBlocks,
  TURN_SCOPED_OWNER_KINDS,
  type AgenticEvent,
  type ApprovalId,
  type BlockId,
  type EventId,
  type EventKind,
  type InvocationId,
  type InvocationOutcome,
  type MessageBlockInput,
  type MessageId,
  type MessageOutcome,
  type MessageRole,
  type TrajectoryState,
  type TrajectoryEvent,
  type TurnId,
  type TurnReasonCode,
} from "@workspace/agentic-protocol";
import { buildTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import {
  HookBus,
  type CorrelatedAgentHarnessEvent,
  type EventListener,
  type TransformContextListener,
} from "./hook-bus.js";
import { CompactionTrigger, type CompactionTriggerOptions } from "./compaction-trigger.js";
import { AgentWorkerError } from "./errors.js";

export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Built-in file tool names that are always active alongside roster tools. */
const BUILTIN_TOOL_NAMES = [
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "web_read",
] as const;

export interface PiRunnerGadProvenance {
  trajectoryId?: string | null;
  branchId: string;
  workspaceId?: string | null;
  channelId?: string | null;
  contextId?: string | null;
  source?: string;
  metadata?: Record<string, unknown>;
}
interface GadBlobSnapshot {
  digest: string;
  size: number;
}

interface AgentHarnessQueueAccess {
  steerQueue: AgentMessage[];
  emitQueueUpdate(): Promise<void>;
}

interface NatstackTerminalMarker {
  outcome: InvocationOutcome;
  reasonCode?: string;
}

function isInvocationOutcome(value: unknown): value is InvocationOutcome {
  return (
    value === "success" ||
    value === "tool_error" ||
    value === "infrastructure_error" ||
    value === "cancelled" ||
    value === "stale_dispatch" ||
    value === "abandoned"
  );
}

function terminalMarkerFromDetails(details: unknown): NatstackTerminalMarker | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const marker = (details as Record<string, unknown>)["__natstack_terminal"];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const record = marker as Record<string, unknown>;
  if (!isInvocationOutcome(record["outcome"])) return null;
  return {
    outcome: record["outcome"],
    ...(typeof record["reasonCode"] === "string" ? { reasonCode: record["reasonCode"] } : {}),
  };
}

function abortedBeforeToolExecutionResult(): AgentToolResult<any> {
  return {
    isError: true,
    terminate: true,
    content: [{ type: "text", text: "Agent run was aborted before tool execution." }],
    details: {
      __natstack_terminal: {
        outcome: "cancelled",
        reasonCode: "user_interrupted",
      },
    },
  } as AgentToolResult<any>;
}

export interface PiRunnerOptions {
  rpc: RpcCaller;
  fs: RuntimeFs;
  uiCallbacks: NatStackScopedUiContext;
  rosterCallback: () => ChannelToolMethod[];
  callMethodCallback: (
    toolCallId: string,
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onStreamUpdate?: StreamUpdateCallback,
    turnId?: string
  ) => Promise<AgentToolResult<any>>;
  askUserCallback: (
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
    turnId?: string
  ) => Promise<AgentToolResult<any> | string>;
  model: string;
  getApiKey: () => Promise<string>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  approvalLevel: ApprovalLevel;
  cwd?: string;
  gad?: PiRunnerGadProvenance;
  sessionStorage?: SessionStorage<TrajectorySessionMetadata | SessionMetadata>;
  onPrepareNextTurn?: (
    snapshot: TurnSnapshot
  ) => Promise<TurnSnapshot | void> | TurnSnapshot | void;
  publicationPolicy?: (input: { event: AgenticEvent; publishToChannel?: boolean }) => boolean;
  repairDurableOpenStateOnInit?: boolean;
  onTurnPhase?: (event: { turnId: string; phase: "model_start" }) => void | Promise<void>;
  keepTurnOpenOnAgentEnd?: (event: AgentHarnessEvent) => boolean;
  extraTools?: AgentTool<any>[];
  toolFilter?: (toolName: string) => boolean;
  /**
   * Channel-provided tools that this runner expects to see before model calls.
   * These are diagnostics only: absence is logged/checkpointed loudly because
   * it usually means the runner is about to call the model in a bare built-in
   * tool mode while the conversation expects panel/headless methods such as eval.
   */
  expectedChannelToolNames?: readonly string[];
  compactionPolicy?: CompactionTriggerOptions;
  /**
   * Optional probe asking whether the credentials runtime holds a credential
   * whose audience matches a given provider origin. Used to auto-upgrade
   * web search from DuckDuckGo to a paid provider when the user has
   * registered one through the credentials system. The harness never sees
   * the credential value — auth is injected by the host's fetcher.
   */
  hasCredentialForOrigin?: CredentialPresenceProbe;
  agentActor?: AgenticEvent["actor"];
  /**
   * Optional global-fetch override. In production the host wires a
   * binary-safe credentialed fetcher that routes through the credentials
   * runtime: auth is auto-attached by URL-audience matching, every call
   * is audited, and PDFs/images round-trip as bytes. The harness never
   * sees credential values.
   */
  fetcher?: typeof fetch;
}

export interface HibernationResumableTool {
  natstackResume?: {
    safeAcrossHibernation: true;
  };
}

export interface PiStateSnapshot {
  messages: AgentMessage[];
  isStreaming: boolean;
}

export interface RunnerTurnInput {
  content: string;
  images?: ImageContent[];
}

export interface RunnerTurnOptions {
  turnId?: string;
}

interface RunnerDebugCheckpoint {
  phase: string;
  at: string;
  detail?: Record<string, unknown>;
}

interface RunnerDebugError {
  scope: string;
  at: string;
  message: string;
  name?: string;
  stack?: string;
}

interface RunnerDebugEvent {
  type: string;
  at: string;
  turnId: string | null;
  summary?: Record<string, unknown>;
}

interface RunnerDebugTrajectoryEvent {
  kind: string;
  at: string;
  turnId?: string;
  eventId?: string;
  publishToChannel?: boolean;
  causality?: unknown;
  payloadSummary?: unknown;
}

interface OpenToolInvocationDebug {
  invocationId: string;
  modelToolCallId?: string;
  name: string;
  request: unknown;
  messageId?: string;
  blockIndex?: number;
  turnId?: string;
  startedAt: string;
}

interface RunnerDebugOperation {
  kind: "prompt" | "continue";
  operationId?: string;
  turnId?: string | null;
  startedAt: string;
  input?: {
    contentLength: number;
    contentPreview: string;
    imageCount: number;
  };
}

interface PendingMutation {
  intentEntryId: string;
  path: string;
  before: GadBlobSnapshot | null;
  toolCallId: string;
  toolName: "edit" | "write";
}

interface TrajectoryQueueItem {
  event: AgenticEvent;
  eventId?: string;
  publishToChannel?: boolean;
}

interface PublishedChannelEnvelope {
  channelId: string;
  envelopeId: string;
}

interface AppendTrajectoryBatchResultLike {
  published?: PublishedChannelEnvelope[];
}

interface ResolvedServiceLike {
  kind?: string;
  targetId?: string;
}

interface ChannelPublicationBroadcastState {
  pendingBatches: number;
  queuedEnvelopeIds: string[];
  activeEnvelopeIds: string[];
  lastScheduledAt?: string;
  lastCompletedAt?: string;
  failureCount?: number;
  lastError?: {
    envelopeIds: string[];
    message: string;
    at: string;
  };
}

interface CompactionDiagnosticState {
  attempts: number;
  failures: number;
  consecutiveFailures: number;
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastFailure?: {
    message: string;
    at: string;
  };
}

function removeQueuedEnvelopeIds(queued: string[], removed: string[]): string[] {
  const remainingToRemove = new Map<string, number>();
  for (const id of removed) {
    remainingToRemove.set(id, (remainingToRemove.get(id) ?? 0) + 1);
  }
  return queued.filter((id) => {
    const count = remainingToRemove.get(id) ?? 0;
    if (count === 0) return true;
    if (count === 1) remainingToRemove.delete(id);
    else remainingToRemove.set(id, count - 1);
    return false;
  });
}

const DEBUG_RING_LIMIT = 80;
const DEBUG_PREVIEW_LIMIT = 240;
const DEBUG_COLLECTION_LIMIT = 16;
const DEBUG_DEPTH_LIMIT = 3;

function pushBounded<T>(items: T[], item: T, limit = DEBUG_RING_LIMIT): void {
  items.push(item);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function previewText(value: string, limit = DEBUG_PREVIEW_LIMIT): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function summarizeDebugValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return previewText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const sample = value
      .slice(0, DEBUG_COLLECTION_LIMIT)
      .map((item) => summarizeDebugValue(item, depth + 1));
    return value.length > sample.length
      ? [...sample, { omittedItems: value.length - sample.length }]
      : sample;
  }
  if (typeof value === "object") {
    if (depth >= DEBUG_DEPTH_LIMIT) return "[object]";
    const entries = Object.entries(value as Record<string, unknown>);
    const sample = entries
      .slice(0, DEBUG_COLLECTION_LIMIT)
      .map(([key, item]) => [key, summarizeDebugValue(item, depth + 1)]);
    const result = Object.fromEntries(sample) as Record<string, unknown>;
    if (entries.length > sample.length) {
      result["omittedKeys"] = entries.length - sample.length;
    }
    return result;
  }
  return String(value);
}

function summarizeAgentMessage(message: Record<string, unknown>): Record<string, unknown> {
  return {
    role: message["role"] ?? null,
    timestamp: message["timestamp"] ?? null,
    ...(message["stopReason"] ? { stopReason: message["stopReason"] } : {}),
    ...(message["toolCallId"] ? { toolCallId: message["toolCallId"] } : {}),
    ...(message["toolName"] ? { toolName: message["toolName"] } : {}),
    content: summarizeDebugValue(message["content"]),
  };
}

function summarizeSessionEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return summarizeDebugValue(entry);
  const record = entry as Record<string, unknown>;
  const message = record["message"];
  return {
    type: record["type"] ?? null,
    id: record["id"] ?? null,
    parentId: record["parentId"] ?? null,
    timestamp: record["timestamp"] ?? null,
    ...(message && typeof message === "object" && !Array.isArray(message)
      ? { message: summarizeAgentMessage(message as Record<string, unknown>) }
      : {}),
  };
}

function agentMessageFailureReason(message: AgentMessage): string | null {
  const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (candidate.role !== "assistant" || candidate.stopReason !== "error") return null;
  return typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()
    ? candidate.errorMessage
    : "Assistant message failed.";
}

function agentMessageStopReason(message: AgentMessage): string | null {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" ? stopReason : null;
}

function providerPayloadToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const tools = Array.isArray(record["tools"]) ? record["tools"] : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const item = tool as Record<string, unknown>;
    if (typeof item["name"] === "string") {
      names.add(item["name"]);
      continue;
    }
    const fn = item["function"];
    if (fn && typeof fn === "object" && !Array.isArray(fn)) {
      const name = (fn as Record<string, unknown>)["name"];
      if (typeof name === "string") names.add(name);
      continue;
    }
    const declarations = item["functionDeclarations"];
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) continue;
        const name = (declaration as Record<string, unknown>)["name"];
        if (typeof name === "string") names.add(name);
      }
    }
  }
  return [...names].sort();
}

function sortedToolNames(tools: readonly AgentTool<any>[]): string[] {
  return [...new Set(tools.map((tool) => tool.name))].sort();
}

function diffToolNames(
  previous: readonly string[] | null,
  next: readonly string[]
): {
  added: string[];
  removed: string[];
} {
  if (!previous) return { added: [], removed: [] };
  const prev = new Set(previous);
  const current = new Set(next);
  return {
    added: next.filter((name) => !prev.has(name)),
    removed: previous.filter((name) => !current.has(name)),
  };
}

function sameToolNames(previous: readonly string[] | null, next: readonly string[]): boolean {
  return (
    !!previous &&
    previous.length === next.length &&
    previous.every((name, index) => name === next[index])
  );
}

function uniqueToolsByName(tools: readonly AgentTool<any>[]): {
  tools: AgentTool<any>[];
  duplicates: string[];
} {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unique: AgentTool<any>[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.add(tool.name);
      continue;
    }
    seen.add(tool.name);
    unique.push(tool);
  }
  return { tools: unique, duplicates: [...duplicates].sort() };
}

function missingNames(
  expected: readonly string[] | undefined,
  actual: readonly string[]
): string[] {
  if (!expected || expected.length === 0) return [];
  const actualSet = new Set(actual);
  return [...new Set(expected)].filter((name) => !actualSet.has(name)).sort();
}

function summarizeDebugList(
  values: unknown[] | null,
  itemSummarizer = summarizeDebugValue
): Record<string, unknown> | null {
  if (!values) return null;
  const sample = values.slice(0, DEBUG_COLLECTION_LIMIT).map(itemSummarizer);
  return {
    count: values.length,
    sample,
    ...(values.length > sample.length ? { omittedItems: values.length - sample.length } : {}),
  };
}

export class PiRunner {
  private harness: AgentHarness | null = null;
  private extensionRuntime: PiExtensionRuntime | null = null;
  private builtinTools: AgentTool<any>[] = [];
  private lastHarnessToolNames: string[] | null = null;
  private lastProviderPayloadToolNames: string[] | null = null;
  private lastRosterToolNames: string[] = [];
  private harnessUnsub: (() => void) | null = null;
  private _approvalLevel: ApprovalLevel;
  private readonly preApprovedCallIds = new Set<string>();
  readonly hooks = new HookBus();
  private readonly compactionTrigger: CompactionTrigger;
  session: Session<TrajectorySessionMetadata | SessionMetadata> | null = null;
  private storage: SessionStorage<TrajectorySessionMetadata | SessionMetadata> | null = null;
  private currentResources: NatStackResources | null = null;
  private resolvedModel: Model<any> | null = null;
  private provenanceQueue: TrajectoryQueueItem[] = [];
  private readonly pendingMutations = new Map<string, PendingMutation>();
  private readonly gad: DurableObjectServiceClient;
  private running = false;
  private currentTurnId: TurnId | null = null;
  private openedTurnIds = new Set<string>();
  private turnCloseFailedIds = new Set<string>();
  private readonly channelTargetPromises = new Map<string, Promise<string>>();
  private readonly channelPublicationBroadcastChains = new Map<string, Promise<void>>();
  private readonly channelPublicationBroadcasts = new Map<
    string,
    ChannelPublicationBroadcastState
  >();
  private readonly openInvocationIds = new Set<string>();
  private readonly openToolInvocations = new Map<string, OpenToolInvocationDebug>();
  private readonly forceClosingTurnIds = new Set<string>();
  private readonly phaseCheckpoints: RunnerDebugCheckpoint[] = [];
  private readonly recentHarnessEvents: RunnerDebugEvent[] = [];
  private readonly recentTrajectoryEvents: RunnerDebugTrajectoryEvent[] = [];
  private readonly terminalInvocationIds = new Set<string>();
  private readonly lastErrors: RunnerDebugError[] = [];
  private readonly compactionDiagnostics: CompactionDiagnosticState = {
    attempts: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
  private currentOperation: RunnerDebugOperation | null = null;
  private awaitingProviderFirstEvent = false;
  private providerRequestCount = 0;
  private credentialRequestCount = 0;
  /** Set when getApiKey threw a typed suspension for the in-flight turn. Drives
   *  keep-turn-open + channel-publish suppression of the resulting failure
   *  message. Cleared when the next prompt/continue adopts the turn. */
  private pendingSuspension: TurnSuspensionSignal | null = null;
  private restoredTrajectoryState: TrajectoryState | null = null;
  private activeAssistantMessage: {
    messageId: string;
    lastText: string;
    lastBlocks: MessageBlockInput[];
    started: boolean;
  } | null = null;
  private activation: {
    controller: AbortController;
    signal: AbortSignal;
    turnId: string | null;
    runSignalCleanup?: () => void;
  } | null = null;
  private activeRunSignal: AbortSignal | null = null;
  private activeOperationId: string | null = null;
  private activeOperationSawAgentStart = false;
  private activeOperationSawAgentEnd = false;
  private lastContinueDiagnostic: Record<string, unknown> | null = null;
  private harnessEventChain: Promise<void> = Promise.resolve();
  private harnessEventFailure: unknown = null;
  private readonly harnessEventFailureWaiters = new Set<(err: unknown) => void>();

  constructor(private readonly options: PiRunnerOptions) {
    this._approvalLevel = options.approvalLevel;
    this.compactionTrigger = new CompactionTrigger(options.compactionPolicy);
    this.gad = createGadServiceClient(options.rpc);
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  private rememberCheckpoint(phase: string, detail?: Record<string, unknown>): void {
    pushBounded(this.phaseCheckpoints, {
      phase,
      at: new Date().toISOString(),
      ...(detail ? { detail: this.summarizeRecord(detail) } : {}),
    });
  }

  private rememberError(scope: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    pushBounded(this.lastErrors, {
      scope,
      at: new Date().toISOString(),
      message: err.message,
      name: err.name,
      stack: err.stack,
    });
  }

  private rememberHarnessEvent(event: AgentHarnessEvent): void {
    const type = (event as { type?: unknown }).type;
    if (typeof type !== "string") return;
    pushBounded(this.recentHarnessEvents, {
      type,
      at: new Date().toISOString(),
      turnId: this.currentTurnId,
      summary: this.harnessEventSummary(event),
    });
    if (this.awaitingProviderFirstEvent) {
      this.awaitingProviderFirstEvent = false;
      this.rememberCheckpoint("provider.first_event", { eventType: type });
    }
  }

  private rememberTrajectoryEvent(item: TrajectoryQueueItem): void {
    const event = item.event;
    pushBounded(this.recentTrajectoryEvents, {
      kind: event.kind,
      at: new Date().toISOString(),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(item.eventId ? { eventId: item.eventId } : {}),
      ...(item.publishToChannel !== undefined ? { publishToChannel: item.publishToChannel } : {}),
      causality: (event as { causality?: unknown }).causality,
      payloadSummary: summarizeDebugValue((event as { payload?: unknown }).payload),
    });
  }

  private harnessEventSummary(event: AgentHarnessEvent): Record<string, unknown> | undefined {
    const record = event as Record<string, unknown>;
    const message = record["message"] as { role?: unknown; content?: unknown } | undefined;
    if (message && typeof message === "object") {
      return {
        role: message.role,
        content: summarizeDebugValue(message.content),
      };
    }
    if (Array.isArray(record["messages"])) {
      return { messageCount: record["messages"].length };
    }
    return undefined;
  }

  private summarizeRecord(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, summarizeDebugValue(value)])
    );
  }

  private beginActivation(turnId: string | null): AbortSignal {
    this.endActivation("new_activation", { abort: false });
    const controller = new AbortController();
    this.activation = {
      controller,
      signal: controller.signal,
      turnId,
    };
    return controller.signal;
  }

  private ensureActivation(turnId: string | null): AbortSignal {
    if (this.activation) {
      if (!this.activation.turnId && turnId) this.activation.turnId = turnId;
      return this.activation.signal;
    }
    return this.beginActivation(turnId);
  }

  private linkHarnessRunSignal(signal: AbortSignal | null | undefined): void {
    if (!this.activation || !signal) return;
    this.activation.runSignalCleanup?.();
    if (signal.aborted) {
      this.activation.controller.abort(signal.reason ?? new Error("Harness run aborted"));
      return;
    }
    const controller = this.activation.controller;
    const onAbort = () => {
      controller.abort(signal.reason ?? new Error("Harness run aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.activation.runSignalCleanup = () => signal.removeEventListener("abort", onAbort);
  }

  private endActivation(_reason: string, opts: { abort?: boolean } = {}): void {
    const activation = this.activation;
    if (!activation) return;
    if (opts.abort) {
      activation.controller.abort(new Error(_reason));
    }
    activation.runSignalCleanup?.();
    this.activation = null;
  }

  private activationSignal(): AbortSignal | undefined {
    return this.activation?.signal;
  }

  getDebugState(): Record<string, unknown> {
    const activeToolNames = this.extensionRuntime
      ? this.computeActiveTools().map((tool) => tool.name)
      : [];
    return {
      running: this.running,
      currentTurnId: this.currentTurnId,
      activeToolNames,
      openInvocationIds: [...this.openInvocationIds],
      openToolInvocations: [...this.openToolInvocations.values()].map((invocation) => ({
        ...invocation,
      })),
      activeAssistantMessage: this.activeAssistantMessage
        ? { ...this.activeAssistantMessage }
        : null,
      phase: {
        currentOperation: this.currentOperation ? { ...this.currentOperation } : null,
        activeRunSignal: this.activeRunSignal ? { aborted: this.activeRunSignal.aborted } : null,
        activationSignal: this.activation
          ? { aborted: this.activation.signal.aborted, turnId: this.activation.turnId }
          : null,
        awaitingProviderFirstEvent: this.awaitingProviderFirstEvent,
        providerRequestCount: this.providerRequestCount,
        credentialRequestCount: this.credentialRequestCount,
        checkpoints: [...this.phaseCheckpoints],
      },
      hooks: this.hooks.getDebugState(),
      lastContinueDiagnostic: this.lastContinueDiagnostic,
      recentHarnessEvents: [...this.recentHarnessEvents],
      recentTrajectoryEvents: [...this.recentTrajectoryEvents],
      lastErrors: [...this.lastErrors],
      compaction: {
        ...this.compactionDiagnostics,
        lastFailure: this.compactionDiagnostics.lastFailure
          ? { ...this.compactionDiagnostics.lastFailure }
          : undefined,
      },
      pendingProvenance: this.provenanceQueue.map((item) => ({
        kind: item.event.kind,
        eventId: item.eventId ?? null,
        publishToChannel: item.publishToChannel ?? false,
      })),
      pendingMutations: [...this.pendingMutations.values()].map((mutation) => ({
        intentEntryId: mutation.intentEntryId,
        path: mutation.path,
        toolCallId: mutation.toolCallId,
        toolName: mutation.toolName,
        before: mutation.before,
      })),
      branchInfo: this.options.gad
        ? {
            trajectoryId: this.gadTrajectoryId(),
            branchId: this.options.gad.branchId,
            workspaceId: this.options.gad.workspaceId ?? null,
            channelId: this.options.gad.channelId ?? null,
            contextId: this.options.gad.contextId ?? null,
            source: this.options.gad.source ?? null,
            metadata: this.options.gad.metadata ?? {},
          }
        : null,
      restoredTrajectoryState: this.restoredTrajectoryState
        ? {
            turnCount: Object.keys(this.restoredTrajectoryState.turns).length,
            openTurns: Object.values(this.restoredTrajectoryState.turns)
              .filter((turn) => turn.status === "open")
              .map((turn) => turn.turnId),
            invocationCount: Object.keys(this.restoredTrajectoryState.invocations).length,
            openInvocations: Object.values(this.restoredTrajectoryState.invocations)
              .filter((invocation) => !this.isTerminalInvocationStatus(invocation.status))
              .map((invocation) => invocation.invocationId),
          }
        : null,
      channelPublicationBroadcasts: Object.fromEntries(
        [...this.channelPublicationBroadcasts.entries()].map(([channelId, state]) => [
          channelId,
          {
            ...state,
            queuedEnvelopeIds: [...state.queuedEnvelopeIds],
            activeEnvelopeIds: [...state.activeEnvelopeIds],
            lastError: state.lastError
              ? { ...state.lastError, envelopeIds: [...state.lastError.envelopeIds] }
              : undefined,
          },
        ])
      ),
      session: {
        available: false,
        reason: "session_debug_requires_async_io",
      },
      approvalLevel: this._approvalLevel,
      model: this.resolvedModel
        ? {
            id: (this.resolvedModel as { id?: unknown }).id,
            provider: (this.resolvedModel as { provider?: unknown }).provider,
            modelId: (this.resolvedModel as { modelId?: unknown }).modelId,
            baseUrl: (this.resolvedModel as { baseUrl?: unknown }).baseUrl,
          }
        : null,
    };
  }

  async forceCloseCurrentTurn(
    reason: Extract<
      TurnReasonCode,
      "user_interrupted" | "channel_unsubscribe" | "turn_superseded"
    > = "user_interrupted",
    summary = "Agent turn interrupted"
  ): Promise<boolean> {
    return this.cancelCurrentTurn(reason, summary);
  }

  private async cancelCurrentTurn(
    reason: Extract<TurnReasonCode, "user_interrupted" | "channel_unsubscribe" | "turn_superseded">,
    summary: string
  ): Promise<boolean> {
    if (!this.options.gad || !this.currentTurnId) return false;
    const turnId = this.currentTurnId;
    this.forceClosingTurnIds.add(turnId);
    this.running = false;
    this.activeAssistantMessage = null;
    try {
      await this.flushProvenance();
      await this.settleOpenInvocations(summary, "cancelled", reason, turnId);
      await this.appendTrajectoryEvents([
        {
          event: {
            kind: "turn.closed",
            actor: this.agentActor(),
            turnId,
            payload: {
              protocol: "agentic.trajectory.v1",
              summary,
              reason,
            },
            createdAt: new Date().toISOString(),
          },
          publishToChannel: true,
        },
      ]);
      if (this.currentTurnId === turnId) this.currentTurnId = null;
      this.endActivation("turn_interrupted", { abort: false });
      this.openedTurnIds.delete(turnId);
      this.turnCloseFailedIds.delete(turnId);
      return true;
    } finally {
      this.forceClosingTurnIds.delete(turnId);
    }
  }

  private async failCurrentTurn(
    reason: Extract<TurnReasonCode, "work_failed">,
    summary: string
  ): Promise<boolean> {
    if (!this.options.gad || !this.currentTurnId) return false;
    const turnId = this.currentTurnId;
    this.forceClosingTurnIds.add(turnId);
    this.running = false;
    this.activeAssistantMessage = null;
    try {
      await this.flushProvenance();
      await this.settleOpenInvocations(summary, "infrastructure_error", reason, turnId);
      await this.appendTrajectoryEvents([
        {
          event: {
            kind: "turn.closed",
            actor: this.agentActor(),
            turnId,
            payload: {
              protocol: "agentic.trajectory.v1",
              summary,
              reason,
            },
            createdAt: new Date().toISOString(),
          },
          publishToChannel: true,
        },
      ]);
      if (this.currentTurnId === turnId) this.currentTurnId = null;
      this.endActivation("turn_failed", { abort: false });
      this.openedTurnIds.delete(turnId);
      this.turnCloseFailedIds.delete(turnId);
      return true;
    } finally {
      this.forceClosingTurnIds.delete(turnId);
    }
  }

  forgetOpenInvocation(invocationId: string): void {
    this.openInvocationIds.delete(invocationId);
    this.openToolInvocations.delete(invocationId);
  }

  getOpenInvocation(invocationId: string):
    | {
        invocationId: string;
        modelToolCallId?: string;
        name: string;
        messageId?: string;
        blockIndex?: number;
        turnId?: string;
      }
    | undefined {
    const invocation = this.openToolInvocations.get(invocationId);
    if (!invocation) return undefined;
    return {
      invocationId: invocation.invocationId,
      ...(invocation.modelToolCallId ? { modelToolCallId: invocation.modelToolCallId } : {}),
      name: invocation.name,
      ...(invocation.messageId ? { messageId: invocation.messageId } : {}),
      ...(invocation.blockIndex !== undefined ? { blockIndex: invocation.blockIndex } : {}),
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    };
  }

  isInvocationOpen(invocationId: string): boolean {
    return this.openInvocationIds.has(invocationId);
  }

  async hasToolResult(invocationId: string): Promise<boolean> {
    if (!this.session) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    const context = await this.session.buildContext();
    return context.messages.some((message) => {
      return message?.role === "toolResult" && message.toolCallId === invocationId;
    });
  }

  async isCurrentLeafToolResult(invocationId: string): Promise<boolean> {
    if (!this.session) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    const context = await this.session.buildContext();
    const message = context.messages[context.messages.length - 1];
    return message?.role === "toolResult" && message.toolCallId === invocationId;
  }

  async isLeafDescendantOf(ancestorEntryId: string): Promise<boolean> {
    if (!this.session) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    const branch = await this.session.getBranch();
    return branch.some((entry: { id?: unknown }) => entry.id === ancestorEntryId);
  }

  async getSessionBranchEntryIds(): Promise<string[]> {
    if (!this.session) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    const branch = await this.session.getBranch();
    return branch
      .map((entry: { id?: unknown }) => entry.id)
      .filter((id): id is string => typeof id === "string");
  }

  async init(): Promise<void> {
    const cwd = this.options.cwd ?? "/";
    this.currentResources = await loadNatStackResources({ rpc: this.options.rpc });

    this.extensionRuntime = new PiExtensionRuntime(cwd);
    this.extensionRuntime.bindUI(this.options.uiCallbacks);
    await this.extensionRuntime.loadFactories([
      createApprovalGateExtension({
        getApprovalLevel: () => this._approvalLevel,
        safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
        preApprovedCallIds: this.preApprovedCallIds,
      }),
      createChannelToolsExtension({
        getRoster: this.options.rosterCallback,
        callMethod: (toolCallId, participantHandle, method, args, signal, onStreamUpdate) =>
          this.options.callMethodCallback(
            toolCallId,
            participantHandle,
            method,
            args,
            signal,
            onStreamUpdate,
            this.currentTurnId ?? undefined
          ),
        builtinToolNames: [...BUILTIN_TOOL_NAMES],
      }),
      createAskUserExtension({
        askUser: (toolCallId, params, signal) =>
          this.options.askUserCallback(toolCallId, params, signal, this.currentTurnId ?? undefined),
      }),
      createWebToolsExtension({
        rpc: this.options.rpc,
        hasCredentialForOrigin: this.options.hasCredentialForOrigin,
        fetcher: this.options.fetcher,
      }),
    ]);

    this.builtinTools = [
      createReadTool(cwd, this.options.fs, {
        rpc: this.options.rpc,
      }),
      createEditTool(cwd, this.options.fs),
      createWriteTool(cwd, this.options.fs),
      createGrepTool(cwd, this.options.fs, {
        rpc: this.options.rpc,
      }),
      createFindTool(cwd, this.options.fs, {
        rpc: this.options.rpc,
      }),
      createLsTool(cwd, this.options.fs),
    ] as AgentTool<any>[];

    this.resolvedModel = resolveModel(this.options.model);
    this.session = await this.createSession();
    await this.refreshRuntimeTools("init");

    this.harness = new AgentHarness({
      env: createExecutionEnv(cwd, this.options.fs),
      session: this.session,
      tools: this.computeActiveTools(),
      activeToolNames: this.computeActiveTools().map((tool) => tool.name),
      model: this.resolvedModel,
      thinkingLevel: this.options.thinkingLevel ?? "medium",
      getApiKeyAndHeaders: async () => {
        this.credentialRequestCount++;
        this.rememberCheckpoint("model_credential.request.start", {
          credentialRequestCount: this.credentialRequestCount,
        });
        try {
          const apiKey = await this.options.getApiKey();
          this.rememberCheckpoint("model_credential.request.ok", {
            credentialRequestCount: this.credentialRequestCount,
          });
          return { apiKey };
        } catch (err) {
          this.rememberError("model_credential.request", err);
          this.rememberCheckpoint("model_credential.request.error", {
            credentialRequestCount: this.credentialRequestCount,
            error: err instanceof Error ? err.message : String(err),
          });
          // A typed suspension (e.g. a deferred credential approval) is a PAUSE,
          // not a failure: stash it so the turn stays open and the resulting
          // failure message is never published to the channel as a red error.
          if (isTurnSuspensionSignal(err)) this.pendingSuspension = err;
          throw err;
        }
      },
      systemPrompt: () => this.composeCurrentSystemPrompt(),
    });

    this.wireHarness();
    await this.surfaceOrphanMutationIntents();
    if (this.options.repairDurableOpenStateOnInit !== false) {
      await this.repairDurableOpenState();
    }
  }

  private async createSession(): Promise<Session<TrajectorySessionMetadata | SessionMetadata>> {
    if (this.options.sessionStorage) {
      this.storage = this.options.sessionStorage;
      return new Session(this.storage);
    }
    if (this.options.gad) {
      this.storage = await this.buildSessionStorage();
      return new Session(this.storage);
    }
    this.storage = null;
    const repo = new InMemorySessionRepo();
    return repo.create({ id: "natstack-memory-session" });
  }

  private async buildSessionStorage(): Promise<TrajectoryBackedSessionStorage> {
    const gad = this.options.gad!;
    const trajectoryId = this.gadTrajectoryId();
    const events = await this.gad.call<TrajectoryEvent[]>("listTrajectoryEvents", {
      trajectoryId,
      branchId: gad.branchId,
      limit: 0,
    });
    const hydratedEvents = await Promise.all(
      events.map((event) => this.hydrateGadStoredRefs(event))
    );
    const state = hydratedEvents.reduce(reduceTrajectory, createInitialTrajectoryState());
    this.restoredTrajectoryState = state;
    const restoredOpenTurnId =
      state.openTurnIdByBranch[gad.branchId] ??
      Object.values(state.turns).find((turn) => turn.status === "open")?.turnId;
    if (restoredOpenTurnId && state.turns[restoredOpenTurnId]?.status === "open") {
      this.currentTurnId = restoredOpenTurnId;
      this.openedTurnIds.add(restoredOpenTurnId);
    }
    this.terminalInvocationIds.clear();
    for (const invocation of Object.values(state.invocations)) {
      if (this.isTerminalInvocationStatus(invocation.status)) {
        this.terminalInvocationIds.add(invocation.invocationId);
      }
    }
    return new TrajectoryBackedSessionStorage({
      trajectoryId,
      branchId: gad.branchId,
      entries: materializeSessionTree(state),
      appendEvent: async (event, entry) => {
        if (entry.type === "message") return;
        await this.appendTrajectoryEvents([{ event, eventId: this.sessionEntryEventId(entry.id) }]);
      },
    });
  }

  private gadTrajectoryId(): string {
    const gad = this.options.gad;
    if (!gad) throw new AgentWorkerError("invalid_state", "GAD provenance is not configured");
    return gad.trajectoryId ?? gad.workspaceId ?? gad.branchId;
  }

  private async hydrateGadStoredRefs<T>(value: T): Promise<T> {
    return hydrateStoredValueRefs(value, {
      getText: (digest) =>
        this.options.rpc.call<string | null>("main", "blobstore.getText", [digest]),
    }) as Promise<T>;
  }

  private sessionEntryEventId(entryId: string): string {
    return `${entryId}:pi-session-entry`;
  }

  private semanticEntryEventId(entryId: string, label: string, event: AgenticEvent): string {
    return `${entryId}:${label}:${stableHash(stableJson(event))}`;
  }

  private async queueSessionEntryProvenance(entryId: string): Promise<void> {
    if (!this.options.gad || !(this.storage instanceof TrajectoryBackedSessionStorage)) return;
    const entry = await this.storage.getEntry(entryId);
    if (!entry || entry.type !== "message") return;
    this.provenanceQueue.push({
      event: sessionEntryToAgenticEvent(entry as SessionTreeEntry),
      eventId: this.sessionEntryEventId(entry.id),
      publishToChannel: false,
    });
  }

  private wireHarness(): void {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");

    this.harnessUnsub = this.harness.subscribe((event, signal) => {
      this.enqueueHarnessEvent(event, signal);
    });

    this.harness.on("context", async (event) => {
      this.rememberCheckpoint("context.transform.start", {
        messageCount: event.messages.length,
      });
      try {
        const messages = await this.hooks.emitTransformContext(event.messages, {
          signal: this.activationSignal(),
        });
        this.rememberCheckpoint("context.transform.ok", { messageCount: messages.length });
        return { messages };
      } catch (err) {
        this.rememberError("context.transform", err);
        this.rememberCheckpoint("context.transform.error", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    this.harness.on("before_provider_request", async (event) => {
      this.providerRequestCount++;
      this.awaitingProviderFirstEvent = true;
      this.rememberCheckpoint("provider.request.ready", {
        providerRequestCount: this.providerRequestCount,
        activeToolNames: this.computeActiveTools().map((tool) => tool.name),
      });
      try {
        const result = await this.hooks.emitBeforeProviderRequest(event, {
          signal: this.activationSignal(),
        });
        if (this.currentTurnId) {
          await this.options.onTurnPhase?.({
            turnId: this.currentTurnId,
            phase: "model_start",
          });
        }
        this.rememberCheckpoint("provider.request.hooks_ok", {
          providerRequestCount: this.providerRequestCount,
          patchedStreamOptions: Boolean(result?.streamOptions),
        });
        return result;
      } catch (err) {
        this.rememberError("provider.request.hooks", err);
        this.rememberCheckpoint("provider.request.hooks_error", {
          providerRequestCount: this.providerRequestCount,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    this.harness.on("before_provider_payload", async (event) => {
      const toolNames = providerPayloadToolNames(event.payload);
      const expectedToolNames =
        this.lastHarnessToolNames ?? sortedToolNames(this.computeActiveTools());
      const payloadDiff = diffToolNames(expectedToolNames, toolNames);
      const missingExpected = missingNames(this.options.expectedChannelToolNames, toolNames);
      this.rememberCheckpoint("provider.payload.ready", {
        providerRequestCount: this.providerRequestCount,
        toolNames,
        expectedToolNames,
        rosterToolNames: this.lastRosterToolNames,
        ...(this.options.expectedChannelToolNames?.length
          ? { expectedChannelToolNames: [...this.options.expectedChannelToolNames] }
          : {}),
        ...(missingExpected.length > 0 ? { missingExpectedChannelToolNames: missingExpected } : {}),
        hasEval: toolNames.includes("eval"),
      });
      if (missingExpected.length > 0) {
        console.warn("[PiRunner] Provider payload is missing expected channel tools", {
          providerRequestCount: this.providerRequestCount,
          missingExpectedChannelToolNames: missingExpected,
          expectedChannelToolNames: this.options.expectedChannelToolNames,
          rosterToolNames: this.lastRosterToolNames,
          activeToolNames: expectedToolNames,
          payloadToolNames: toolNames,
          currentOperation: this.currentOperation,
        });
      }
      if (!sameToolNames(expectedToolNames, toolNames)) {
        console.warn("[PiRunner] Provider payload tool set differs from active harness tools", {
          providerRequestCount: this.providerRequestCount,
          missingFromPayload: payloadDiff.removed,
          unexpectedInPayload: payloadDiff.added,
          activeToolNames: expectedToolNames,
          payloadToolNames: toolNames,
          currentOperation: this.currentOperation,
        });
        this.rememberCheckpoint("provider.payload.tool_mismatch", {
          providerRequestCount: this.providerRequestCount,
          missingFromPayload: payloadDiff.removed,
          unexpectedInPayload: payloadDiff.added,
        });
      }
      const previousPayload = this.lastProviderPayloadToolNames;
      if (!sameToolNames(previousPayload, toolNames) && previousPayload) {
        const diff = diffToolNames(previousPayload, toolNames);
        console.warn("[PiRunner] Provider payload advertised tool set changed", {
          providerRequestCount: this.providerRequestCount,
          added: diff.added,
          removed: diff.removed,
          payloadToolNames: toolNames,
          currentOperation: this.currentOperation,
        });
      }
      this.lastProviderPayloadToolNames = toolNames;
      return undefined;
    });
    this.harness.on("before_agent_start", async () => {
      const signal = this.activationSignal();
      this.rememberCheckpoint("agent.before_start.resources.start", {
        signalAborted: signal?.aborted ?? false,
      });
      try {
        this.currentResources = await loadNatStackResources({ rpc: this.options.rpc, signal });
        this.rememberCheckpoint("agent.before_start.resources.ok", {
          skillCount: this.currentResources.skills.length,
        });
        return { systemPrompt: this.composeCurrentSystemPrompt() };
      } catch (err) {
        this.rememberError("agent.before_start.resources", err);
        this.rememberCheckpoint("agent.before_start.resources.error", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
    this.harness.on("tool_result", async (event) => {
      if (event.toolName === "edit" || event.toolName === "write") {
        await this.recordMutationObserved(
          event.toolCallId,
          event.isError ? "error" : "ok",
          event.isError
            ? this.summarizeToolResult({ content: event.content, details: event.details })
            : undefined
        );
      } else {
        await this.recordReadOrObservation(event.toolCallId, event.toolName, event.input, {
          content: event.content,
          details: event.details,
        });
      }
      return undefined;
    });
    this.harness.on("save_point", async () => {
      try {
        await this.flushProvenance();
        await this.prepareFollowingTurn();
        return undefined;
      } catch (err) {
        this.failActiveRun("harness.save_point", err);
        throw err;
      }
    });
    this.harness.on("settled", async () => {
      try {
        await this.flushProvenance();
        await this.maybeCompactWhenIdle();
        return undefined;
      } catch (err) {
        this.failActiveRun("harness.settled", err);
        throw err;
      }
    });
  }

  private async dispatchToolCallEvent(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<
    { block?: boolean; reason?: string; terminalToolResult?: AgentToolResult<any> } | undefined
  > {
    const needsApproval = this.toolNeedsApproval(toolCallId, toolName);
    if (needsApproval) {
      await this.recordApprovalRequested(toolCallId, toolName, input);
    }

    try {
      const result = await this.extensionRuntime!.dispatch("tool_call", {
        type: "tool_call",
        toolCallId,
        toolName,
        input,
      });
      if (needsApproval) {
        await this.recordApprovalResolved(toolCallId, result?.block ? false : true, result?.reason);
      }
      return result ?? undefined;
    } catch (err) {
      if (needsApproval) {
        await this.recordApprovalResolved(
          toolCallId,
          false,
          err instanceof Error ? err.message : String(err)
        );
      }
      if (err instanceof NatStackUiToolResultError) {
        return {
          block: true,
          reason: this.summarizeToolResult(err.result),
          terminalToolResult: err.result,
        };
      }
      throw err;
    }
  }

  private toolNeedsApproval(toolCallId: string, toolName: string): boolean {
    if (this.preApprovedCallIds.has(toolCallId)) return false;
    if (this._approvalLevel === 2) return false;
    if (this._approvalLevel === 1 && DEFAULT_SAFE_TOOL_NAMES.has(toolName)) return false;
    return true;
  }

  private async recordApprovalRequested(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<void> {
    this.provenanceQueue.push({
      event: {
        kind: "approval.requested",
        actor: this.agentActor(),
        causality: {
          approvalId: brandId<ApprovalId>(`approval:${toolCallId}`),
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          question: "Allow tool call?",
          requestedBy: this.agentActor(),
          details: { toolName, input },
        },
        createdAt: new Date().toISOString(),
      },
      publishToChannel: true,
    });
    await this.flushProvenance();
  }

  private async recordApprovalResolved(
    toolCallId: string,
    granted: boolean,
    reason?: string
  ): Promise<void> {
    const payload: Extract<AgenticEvent<"approval.resolved">["payload"], { granted: boolean }> = {
      protocol: AGENTIC_PROTOCOL_VERSION,
      granted,
      resolvedBy: { kind: "user", id: "approval-gate" },
    };
    if (reason !== undefined) payload.reason = reason;
    this.provenanceQueue.push({
      event: {
        kind: "approval.resolved",
        actor: this.agentActor(),
        causality: {
          approvalId: brandId<ApprovalId>(`approval:${toolCallId}`),
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload,
        createdAt: new Date().toISOString(),
      },
      publishToChannel: true,
    });
    await this.flushProvenance();
  }

  private composeCurrentSystemPrompt(): string {
    const resources = this.currentResources ?? {
      systemPrompt: "",
      skillIndex: "",
      skills: [],
    };
    return composeSystemPrompt({
      workspacePrompt: resources.systemPrompt,
      skillIndex: resources.skillIndex,
      systemPrompt: this.options.systemPrompt,
      systemPromptMode: this.options.systemPromptMode,
    });
  }

  private async applyHarnessTools(
    tools: AgentTool<any>[],
    reason: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const names = sortedToolNames(tools);
    const previous = this.lastHarnessToolNames;
    const changed = !sameToolNames(previous, names);
    const diff = diffToolNames(previous, names);
    this.rememberCheckpoint("tools.apply", {
      reason,
      activeToolNames: names,
      changed,
      ...(changed && previous ? { added: diff.added, removed: diff.removed } : {}),
      ...details,
    });
    if (changed && previous) {
      console.warn("[PiRunner] Model-facing tool set changed", {
        reason,
        added: diff.added,
        removed: diff.removed,
        activeToolNames: names,
        currentOperation: this.currentOperation,
        ...details,
      });
    }
    this.lastHarnessToolNames = names;
    await this.harness!.setTools(
      tools,
      tools.map((tool) => tool.name)
    );
  }

  private async refreshRuntimeTools(reason = "refreshRuntimeTools"): Promise<void> {
    const rosterToolNames = [
      ...new Set(this.options.rosterCallback().map((method) => method.name)),
    ].sort();
    this.lastRosterToolNames = rosterToolNames;
    const missingExpectedFromRoster = missingNames(
      this.options.expectedChannelToolNames,
      rosterToolNames
    );
    await this.extensionRuntime!.dispatch("session_start", { type: "session_start" });
    const rawBase = this.extensionRuntime!.getActiveTools(this.builtinTools);
    const rawCombined = [...rawBase, ...(this.options.extraTools ?? [])];
    const rawFiltered = this.options.toolFilter
      ? rawCombined.filter((tool) => this.options.toolFilter!(tool.name))
      : rawCombined;
    const { tools: uniqueTools, duplicates } = uniqueToolsByName(rawFiltered);
    const tools = uniqueTools.map((tool) => this.wrapTool(tool));
    this.rememberCheckpoint("tools.refreshed", {
      reason,
      activeToolNames: tools.map((tool) => tool.name),
      rosterToolNames,
      ...(this.options.expectedChannelToolNames?.length
        ? { expectedChannelToolNames: [...this.options.expectedChannelToolNames] }
        : {}),
      ...(missingExpectedFromRoster.length > 0
        ? { missingExpectedChannelToolNames: missingExpectedFromRoster }
        : {}),
      ...(duplicates.length > 0 ? { duplicateToolNames: duplicates } : {}),
    });
    if (missingExpectedFromRoster.length > 0) {
      console.warn("[PiRunner] Channel roster is missing expected tools before model refresh", {
        reason,
        missingExpectedChannelToolNames: missingExpectedFromRoster,
        expectedChannelToolNames: this.options.expectedChannelToolNames,
        rosterToolNames,
        activeToolNames: tools.map((tool) => tool.name),
        currentOperation: this.currentOperation,
      });
    }
    if (this.harness) {
      await this.applyHarnessTools(tools, reason);
    }
  }

  private computeActiveTools(): AgentTool<any>[] {
    const base = this.extensionRuntime!.getActiveTools(this.builtinTools);
    const combined = [...base, ...(this.options.extraTools ?? [])];
    const filtered = this.options.toolFilter
      ? combined.filter((tool) => this.options.toolFilter!(tool.name))
      : combined;
    const { tools } = uniqueToolsByName(filtered);
    return tools.map((tool) => this.wrapTool(tool));
  }

  private wrapTool(tool: AgentTool<any>): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const abortedAtEnter = signal?.aborted || this.activationSignal()?.aborted;
        if (abortedAtEnter) {
          return abortedBeforeToolExecutionResult();
        }
        const dispatchResult = await this.dispatchToolCallEvent(
          toolCallId,
          tool.name,
          this.asJsonRecord(params) ?? {}
        );
        const abortedAfterDispatch = signal?.aborted || this.activationSignal()?.aborted;
        if (abortedAfterDispatch) {
          return abortedBeforeToolExecutionResult();
        }
        if (dispatchResult?.block) {
          if (dispatchResult.terminalToolResult) return dispatchResult.terminalToolResult;
          throw new Error(dispatchResult.reason ?? `Tool "${tool.name}" blocked`);
        }
        if (tool.name === "edit" || tool.name === "write") {
          await this.writeMutationIntent(toolCallId, tool.name, params);
        }
        try {
          const result = await tool.execute(toolCallId, params, signal, onUpdate);
          return result;
        } catch (err) {
          if (err instanceof NatStackUiToolResultError) return err.result;
          throw err;
        }
      },
    } as AgentTool<any>;
  }

  private async prepareFollowingTurn(): Promise<void> {
    if (!this.options.onPrepareNextTurn || !this.harness || !this.session) {
      await this.refreshRuntimeTools("prepareFollowingTurn.no_hook");
      return;
    }
    const beforeHook = await this.buildSnapshot();
    const replacement = await this.options.onPrepareNextTurn(beforeHook);
    await this.refreshRuntimeTools("prepareFollowingTurn.after_hook");
    const refreshed = await this.buildSnapshot();
    const snapshot = replacement
      ? buildTurnSnapshot({
          sessionLeafId: replacement.sessionLeafId,
          messages: replacement.messages,
          systemPrompt: replacement.systemPrompt,
          model: replacement.model,
          thinkingLevel: replacement.thinkingLevel,
          tools: replacement.tools,
          activeToolNames: replacement.activeToolNames,
        })
      : refreshed;
    if (snapshot.model !== this.harness.getModel()) {
      await this.harness.setModel(snapshot.model);
    }
    if (snapshot.thinkingLevel !== this.harness.getThinkingLevel()) {
      await this.harness.setThinkingLevel(snapshot.thinkingLevel);
    }
    await this.applyHarnessTools(
      snapshot.tools,
      replacement ? "prepareFollowingTurn.replacement" : "prepareFollowingTurn.refreshed_snapshot",
      {
        sessionLeafId: snapshot.sessionLeafId,
      }
    );
  }

  private async buildSnapshot(): Promise<TurnSnapshot> {
    if (!this.session || !this.harness) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    const context = await this.session.buildContext();
    return buildTurnSnapshot({
      sessionLeafId: await this.session.getLeafId(),
      messages: context.messages,
      systemPrompt: this.composeCurrentSystemPrompt(),
      model: this.harness.getModel(),
      thinkingLevel: this.harness.getThinkingLevel(),
      tools: this.computeActiveTools(),
    });
  }

  private async maybeCompactWhenIdle(): Promise<void> {
    if (!this.harness || !this.session) return;
    const snapshot = await this.buildSnapshot();
    if (!this.compactionTrigger.shouldCompact(snapshot.messages, snapshot.model)) return;
    this.compactionDiagnostics.attempts += 1;
    this.compactionDiagnostics.lastAttemptAt = new Date().toISOString();
    try {
      await this.harness.compact();
      this.compactionDiagnostics.consecutiveFailures = 0;
      this.compactionDiagnostics.lastCompletedAt = new Date().toISOString();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.compactionDiagnostics.failures += 1;
      this.compactionDiagnostics.consecutiveFailures += 1;
      this.compactionDiagnostics.lastFailure = {
        message,
        at: new Date().toISOString(),
      };
      this.rememberError("compaction", err);
      this.rememberCheckpoint("compaction.failed", {
        consecutiveFailures: this.compactionDiagnostics.consecutiveFailures,
        failures: this.compactionDiagnostics.failures,
        error: message,
      });
      console.error("[PiRunner] compaction failed:", err);
    }
  }

  private enqueueHarnessEvent(event: AgentHarnessEvent, signal?: AbortSignal): void {
    const messageEndLeafId = event.type === "message_end" ? this.session?.getLeafId() : undefined;
    const next = this.harnessEventChain.then(async () =>
      this.handleHarnessEvent(
        event,
        signal,
        (messageEndLeafId ? await messageEndLeafId : undefined) ?? undefined
      )
    );
    this.harnessEventChain = next.catch((err) => {
      this.recordHarnessEventFailure(err);
    });
  }

  private recordHarnessEventFailure(err: unknown): void {
    this.harnessEventFailure ??= err;
    for (const reject of this.harnessEventFailureWaiters) reject(err);
    this.harnessEventFailureWaiters.clear();
  }

  private watchHarnessEventFailure(): { promise: Promise<never>; dispose: () => void } {
    if (this.harnessEventFailure) {
      return { promise: Promise.reject(this.harnessEventFailure), dispose: () => undefined };
    }
    let reject!: (err: unknown) => void;
    const promise = new Promise<never>((_, rej) => {
      reject = rej;
    });
    this.harnessEventFailureWaiters.add(reject);
    return {
      promise,
      dispose: () => {
        this.harnessEventFailureWaiters.delete(reject);
      },
    };
  }

  private throwHarnessEventFailure(): void {
    if (this.harnessEventFailure) throw this.harnessEventFailure;
  }

  private async runHarnessOperation(
    scope: string,
    operation: () => Promise<unknown>
  ): Promise<void> {
    await this.harnessEventChain;
    this.throwHarnessEventFailure();
    this.harnessEventFailure = null;
    const failure = this.watchHarnessEventFailure();
    const operationPromise = operation();
    try {
      await Promise.race([operationPromise, failure.promise]);
      await this.harnessEventChain;
      this.throwHarnessEventFailure();
      await operationPromise;
    } catch (err) {
      if (this.harnessEventFailure === err) {
        this.rememberCheckpoint(`${scope}.harness_event_failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.harness?.abort();
      }
      throw err;
    } finally {
      failure.dispose();
    }
  }

  private async handleHarnessEvent(
    event: AgentHarnessEvent,
    _signal?: AbortSignal,
    capturedMessageEntryId?: string
  ): Promise<void> {
    const harnessSignal = _signal ?? this.activeRunSignal ?? undefined;
    let correlatedEvent: CorrelatedAgentHarnessEvent = this.correlateHarnessEvent(event);
    let hookSignal = this.activationSignal();
    try {
      this.rememberHarnessEvent(event);
      const runSignalAborted = harnessSignal?.aborted ?? false;
      if (event.type === "agent_start") {
        if (runSignalAborted) {
          this.rememberCheckpoint("agent.start.aborted_ignored", {
            turnId: this.currentTurnId ?? null,
          });
          return;
        }
        this.activeRunSignal = harnessSignal ?? null;
        this.ensureActivation(this.currentTurnId);
        this.linkHarnessRunSignal(harnessSignal);
        hookSignal = this.activationSignal();
        this.rememberCheckpoint("agent.start", {
          signalAborted: hookSignal?.aborted ?? false,
        });
        this.running = true;
        await this.openCurrentTurn();
        this.ensureActivation(this.currentTurnId);
        hookSignal = this.activationSignal();
        this.activeOperationSawAgentStart = true;
        correlatedEvent = this.correlateHarnessEvent(event);
      }
      if (runSignalAborted && event.type === "message_start") {
        this.rememberCheckpoint("message_start.aborted_ignored", {
          role: this.messageRole((event as { message: AgentMessage }).message),
          turnId: this.currentTurnId ?? null,
        });
      } else if (event.type === "message_start") {
        await this.handleMessageStart((event as { message: AgentMessage }).message);
      }
      if (runSignalAborted && event.type === "message_update") {
        this.rememberCheckpoint("message_update.aborted_ignored", {
          role: this.messageRole((event as { message: AgentMessage }).message),
          turnId: this.currentTurnId ?? null,
        });
      } else if (event.type === "message_update") {
        await this.handleMessageUpdate((event as { message: AgentMessage }).message);
      }
      if (event.type === "message_end") {
        hookSignal = this.activationSignal();
        await this.handleMessageEnd(
          event.message,
          capturedMessageEntryId,
          runSignalAborted ? harnessSignal : hookSignal
        );
      }
      if (event.type === "agent_end") {
        hookSignal = this.activationSignal();
        if (correlatedEvent.natstack?.lifecycleMatched === false) {
          this.rememberCheckpoint("agent.end.unmatched_ignored", {
            operationId: correlatedEvent.natstack.operationId ?? null,
            turnId: correlatedEvent.natstack.turnId ?? null,
          });
        } else {
          // A pending typed suspension keeps the turn open natively — no string
          // matching needed. The option remains for any other keep-open cases.
          if (this.pendingSuspension || this.options.keepTurnOpenOnAgentEnd?.(event)) {
            this.rememberCheckpoint("agent.end.turn_kept_open", {
              operationId: correlatedEvent.natstack?.operationId ?? null,
              turnId: correlatedEvent.natstack?.turnId ?? null,
              suspended: this.pendingSuspension?.reason ?? null,
            });
          } else {
            await this.closeCurrentTurn();
          }
          this.running = false;
          this.awaitingProviderFirstEvent = false;
          this.options.uiCallbacks.setWorkingMessage(undefined);
          this.activeOperationSawAgentEnd = true;
        }
      }
      await this.hooks.emitEvent(correlatedEvent, { signal: hookSignal });
    } catch (err) {
      this.failActiveRun(`harness.event.${event.type}`, err);
      throw err;
    } finally {
      if (event.type === "agent_end") {
        if (correlatedEvent.natstack?.lifecycleMatched !== false) {
          this.activeRunSignal = null;
          this.activeOperationSawAgentStart = false;
        }
      }
    }
  }

  private correlateHarnessEvent(event: AgentHarnessEvent): CorrelatedAgentHarnessEvent {
    const operationId = this.activeOperationId ?? undefined;
    const turnId = this.currentTurnId ?? undefined;
    const lifecycleMatched =
      event.type === "agent_end" || event.type === "message_start" || event.type === "message_end"
        ? operationId
          ? this.activeOperationSawAgentStart
          : undefined
        : event.type === "agent_start"
          ? true
          : undefined;
    return {
      ...(event as Record<string, unknown>),
      natstack: {
        ...(operationId ? { operationId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(lifecycleMatched !== undefined ? { lifecycleMatched } : {}),
      },
    } as CorrelatedAgentHarnessEvent;
  }

  private failActiveRun(scope: string, err: unknown): void {
    this.rememberError(scope, err);
    this.rememberCheckpoint("agent.run.failed", {
      scope,
      error: err instanceof Error ? err.message : String(err),
    });
    this.running = false;
    this.activeAssistantMessage = null;
    this.awaitingProviderFirstEvent = false;
    this.activeRunSignal = null;
    this.activeOperationSawAgentStart = false;
    this.activeOperationSawAgentEnd = false;
    try {
      this.options.uiCallbacks.setWorkingMessage(undefined);
    } catch (callbackErr) {
      console.warn("[PiRunner] setWorkingMessage cleanup failed:", callbackErr);
    }
  }

  private assertOperationLifecycleComplete(
    scope: "prompt" | "continue",
    operationId: string
  ): void {
    if (this.activeOperationId !== operationId) return;
    if (this.activeOperationSawAgentEnd) return;
    const missing = this.activeOperationSawAgentStart ? "agent_end" : "agent_start";
    const message = `Runner ${scope} completed without ${missing}`;
    this.rememberCheckpoint(`${scope}.lifecycle_incomplete`, {
      operationId,
      missing,
      turnId: this.currentTurnId,
    });
    throw new AgentWorkerError("runner_lifecycle", message);
  }

  private async openCurrentTurn(): Promise<void> {
    if (!this.options.gad) return;
    const turnId = this.currentTurnId ?? brandId<TurnId>(uuidv7());
    this.currentTurnId = turnId;
    if (this.openedTurnIds.has(turnId)) return;
    await this.appendTrajectoryEvents([
      {
        event: {
          kind: "turn.opened",
          actor: this.agentActor(),
          turnId,
          payload: {
            protocol: "agentic.trajectory.v1",
            summary: "Agent turn started",
          },
          createdAt: new Date().toISOString(),
        },
        publishToChannel: true,
      },
    ]);
    this.openedTurnIds.add(turnId);
  }

  private async closeCurrentTurn(): Promise<void> {
    if (!this.options.gad || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
    if (this.forceClosingTurnIds.has(turnId)) return;
    await this.flushProvenance();
    await this.appendTrajectoryEvents([
      {
        event: {
          kind: "turn.closed",
          actor: this.agentActor(),
          turnId,
          payload: {
            protocol: "agentic.trajectory.v1",
            summary: "Agent turn completed",
          },
          createdAt: new Date().toISOString(),
        },
        publishToChannel: true,
      },
    ]).catch((err) => {
      this.turnCloseFailedIds.add(turnId);
      this.rememberError("trajectory.turn.close", err);
      throw err;
    });
    this.currentTurnId = null;
    this.endActivation("turn_closed", { abort: false });
    this.openedTurnIds.delete(turnId);
    this.turnCloseFailedIds.delete(turnId);
  }

  private adoptTurnId(turnId?: string): boolean {
    if (!turnId) return false;
    if (this.currentTurnId && this.currentTurnId !== turnId) {
      const channelId = this.options.gad?.channelId ?? "unknown";
      const workerRef = this.options.gad?.metadata?.["workerRef"];
      const worker =
        workerRef && typeof workerRef === "object"
          ? JSON.stringify(workerRef)
          : workerRef != null
            ? String(workerRef)
            : "unknown";
      throw new AgentWorkerError(
        "invalid_state",
        `Cannot adopt turn ${turnId}; turn ${this.currentTurnId} is already open ` +
          `(channel=${channelId}, worker=${worker})`
      );
    }
    const adoptedFromIdle = this.currentTurnId == null;
    this.currentTurnId = brandId<TurnId>(turnId);
    return adoptedFromIdle;
  }

  private async settleFailedOperationTurn(
    requestedTurnId: string | undefined,
    reason: Extract<TurnReasonCode, "work_failed">,
    summary: string
  ): Promise<void> {
    const currentTurnId = this.currentTurnId;
    if (!currentTurnId) return;
    if (requestedTurnId && currentTurnId !== requestedTurnId) return;
    if (this.forceClosingTurnIds.has(currentTurnId)) {
      this.rememberCheckpoint("turn.failed_suppressed_during_force_close", {
        turnId: currentTurnId,
        requestedTurnId: requestedTurnId ?? null,
        reason,
      });
      return;
    }
    if (!this.openedTurnIds.has(currentTurnId)) {
      this.currentTurnId = null;
      this.endActivation("turn_failed_unopened", { abort: false });
      this.rememberCheckpoint("turn.failed_unopened_cleared", {
        turnId: currentTurnId,
        requestedTurnId: requestedTurnId ?? null,
      });
      return;
    }
    if (this.turnCloseFailedIds.has(currentTurnId)) {
      this.rememberCheckpoint("turn.failed_not_cleared_after_close_failure", {
        turnId: currentTurnId,
        requestedTurnId: requestedTurnId ?? null,
      });
      return;
    }
    try {
      await this.failCurrentTurn(reason, summary);
      this.rememberCheckpoint("turn.failed_closed", {
        turnId: currentTurnId,
        requestedTurnId: requestedTurnId ?? null,
        reason,
      });
    } catch (err) {
      this.rememberError("turn.failed_close", err);
      this.rememberCheckpoint("turn.failed_close_error", {
        turnId: currentTurnId,
        requestedTurnId: requestedTurnId ?? null,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async repairDurableOpenState(
    opts: { closeOpenTurns?: boolean; recoverableInvocationIds?: ReadonlySet<string> } = {}
  ): Promise<void> {
    if (!this.options.gad || !this.restoredTrajectoryState) return;
    const closeOpenTurns = opts.closeOpenTurns ?? true;
    const recoverableInvocationIds = opts.recoverableInvocationIds;
    const now = new Date().toISOString();
    const repairs: TrajectoryQueueItem[] = [];
    for (const invocation of Object.values(this.restoredTrajectoryState.invocations)) {
      if (this.isTerminalInvocationStatus(invocation.status)) continue;
      if (this.terminalInvocationIds.has(invocation.invocationId)) continue;
      // A method call dispatched to the channel survives a runner restart: its
      // result is delivered durably (the channel persists invocation.* log
      // events; the callee re-delivers) and recovered through the suspension
      // ledger. Abandoning it here would race the suspension recovery and
      // hard-terminate a still-in-flight call, dropping its real result and
      // orphaning the turn. The owner of these invocations is the suspension
      // ledger, not this trajectory repair — so skip them.
      if (recoverableInvocationIds?.has(invocation.invocationId)) continue;
      repairs.push({
        event: {
          kind: "invocation.abandoned",
          actor: invocation.actor.kind === "agent" ? invocation.actor : this.agentActor(),
          ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
          causality: { invocationId: invocation.invocationId },
          payload: {
            ...invocationAbandonedPayload("Runner restarted before invocation completed", {
              recoverable: true,
              terminalReasonCode: "runner_restarted_before_invocation_completed",
            }),
          },
          createdAt: now,
        },
        publishToChannel: true,
      });
    }
    const repairedTurnIds = new Set<string>();
    if (closeOpenTurns) {
      for (const turn of Object.values(this.restoredTrajectoryState.turns)) {
        if (turn.status !== "open") continue;
        repairedTurnIds.add(turn.turnId);
        repairs.push({
          event: {
            kind: "turn.closed",
            actor: turn.actor.kind === "agent" ? turn.actor : this.agentActor(),
            turnId: turn.turnId,
            payload: {
              protocol: "agentic.trajectory.v1",
              summary: "Turn closed after runner restart",
              reason: "runner_restarted",
            },
            createdAt: now,
          },
          publishToChannel: true,
        });
      }
    }
    if (repairs.length > 0) await this.appendTrajectoryEvents(repairs);
    if (this.currentTurnId && repairedTurnIds.has(this.currentTurnId)) {
      this.currentTurnId = null;
      this.endActivation("turn_repaired_closed", { abort: false });
    }
    for (const turnId of repairedTurnIds) {
      this.openedTurnIds.delete(turnId);
    }
    if (repairedTurnIds.size > 0) {
      for (const [invocationId, invocation] of this.openToolInvocations.entries()) {
        if (!invocation.turnId || !repairedTurnIds.has(invocation.turnId)) continue;
        this.openToolInvocations.delete(invocationId);
        this.openInvocationIds.delete(invocationId);
      }
    }
    this.restoredTrajectoryState = null;
  }

  private isTerminalInvocationStatus(status: string | undefined): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "abandoned"
    );
  }

  private isTerminalInvocationEvent(kind: string | undefined): boolean {
    return (
      kind === "invocation.completed" ||
      kind === "invocation.failed" ||
      kind === "invocation.cancelled" ||
      kind === "invocation.abandoned"
    );
  }

  private async handleMessageEnd(
    message: AgentMessage,
    capturedMessageEntryId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.session) return;
    const rawRole = (message as { role?: string }).role;
    const role = this.messageRole(message);
    if (signal?.aborted && rawRole === "toolResult") {
      const details = (message as { details?: unknown }).details;
      if (terminalMarkerFromDetails(details) && this.currentTurnId) {
        this.rememberCheckpoint("message_end.aborted_tool_result_terminal_marker_admitted", {
          toolCallId: String((message as { toolCallId?: unknown }).toolCallId ?? ""),
          toolName: String((message as { toolName?: unknown }).toolName ?? ""),
        });
      } else {
        this.rememberCheckpoint("message_end.aborted_tool_result_ignored", {
          toolCallId: String((message as { toolCallId?: unknown }).toolCallId ?? ""),
          toolName: String((message as { toolName?: unknown }).toolName ?? ""),
        });
        return;
      }
    } else if (signal?.aborted) {
      this.rememberCheckpoint("message_end.aborted_message_ignored", {
        role,
        turnId: this.currentTurnId ?? null,
      });
      if (role === "assistant") this.activeAssistantMessage = null;
      return;
    }
    const messageEntryId = capturedMessageEntryId ?? (await this.session.getLeafId());
    if (!messageEntryId) return;
    const messageId =
      role === "assistant" && this.activeAssistantMessage
        ? this.activeAssistantMessage.messageId
        : messageEntryId;
    await this.queueSessionEntryProvenance(messageEntryId);
    this.queueMessageProvenance(message, messageEntryId, messageId);
    if (role === "assistant") this.activeAssistantMessage = null;
    await this.flushProvenance();
  }

  private async handleMessageStart(message: AgentMessage): Promise<void> {
    if (!this.options.gad || this.messageRole(message) !== "assistant") return;
    const messageId = this.activeAssistantMessage?.messageId ?? uuidv7();
    const blocks = this.messageBlocksForTrajectory(this.messageBlocks(message), messageId);
    const content = messageDisplayText(blocks);
    this.activeAssistantMessage = {
      messageId,
      lastText: content,
      lastBlocks: blocks,
      started: true,
    };
    await this.appendTrajectoryEvents([
      {
        event: {
          kind: "message.started",
          actor: this.agentActor(),
          causality: { messageId: brandId<MessageId>(messageId) },
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks,
          },
          createdAt: this.messageTimestamp(message),
        },
        publishToChannel: this.shouldPublishMessageToChannel("assistant"),
      },
    ]);
  }

  private async handleMessageUpdate(message: AgentMessage): Promise<void> {
    if (!this.options.gad || this.messageRole(message) !== "assistant") return;
    if (!this.activeAssistantMessage) {
      await this.handleMessageStart(message);
      return;
    }
    const messageId = this.activeAssistantMessage.messageId;
    const blocks = this.messageBlocksForTrajectory(this.messageBlocks(message), messageId);
    const previousBlocks = this.activeAssistantMessage.lastBlocks;
    // Stream one delta per changed text/thinking block, carrying that block's own
    // incremental fragment. Structural blocks (invocation/attachment/...) are not
    // streamed — they flow via their own events and the completed `blocks`.
    const items: TrajectoryQueueItem[] = [];
    for (const block of blocks) {
      if ((block.type !== "text" && block.type !== "thinking") || !block.blockId) continue;
      const previousContent =
        previousBlocks.find((candidate) => candidate.blockId === block.blockId)?.content ?? "";
      const nextContent = block.content ?? "";
      if (nextContent === previousContent) continue;
      const isAppendOnly = nextContent.startsWith(previousContent);
      const text = isAppendOnly ? nextContent.slice(previousContent.length) : nextContent;
      items.push({
        event: {
          kind: "message.delta",
          actor: this.agentActor(),
          causality: { messageId: brandId<MessageId>(messageId) },
          payload: {
            protocol: "agentic.trajectory.v1",
            blockId: block.blockId,
            type: block.type,
            text,
            ...(isAppendOnly ? {} : { replace: true }),
          },
          createdAt: new Date().toISOString(),
        },
        publishToChannel: this.shouldPublishMessageToChannel("assistant"),
      });
    }
    this.activeAssistantMessage.lastText = messageDisplayText(blocks);
    this.activeAssistantMessage.lastBlocks = blocks;
    if (items.length === 0) return;
    await this.appendTrajectoryEvents(items);
  }

  private queueMessageProvenance(
    message: AgentMessage,
    messageEntryId: string,
    visibleMessageId = messageEntryId
  ): void {
    const role = this.messageRole(message);
    const blocks = this.messageBlocks(message);
    const trajectoryBlocks = this.messageBlocksForTrajectory(blocks, visibleMessageId);
    const outcome = this.classifyMessageOutcome(message, trajectoryBlocks);
    const completedEvent: AgenticEvent = {
      kind: "message.completed",
      actor: this.actorForMessageRole(role),
      causality: { messageId: brandId<MessageId>(visibleMessageId) },
      payload: {
        protocol: "agentic.trajectory.v1",
        role,
        blocks: trajectoryBlocks,
        outcome,
      },
      createdAt: this.messageTimestamp(message),
    };
    this.provenanceQueue.push({
      event: completedEvent,
      eventId: this.semanticEntryEventId(messageEntryId, "message:completed", completedEvent),
      publishToChannel: this.shouldPublishMessageToChannel(role),
    });
    const failureReason = agentMessageFailureReason(message);
    if (failureReason) {
      const failedEvent: AgenticEvent = {
        kind: "message.failed",
        actor: this.actorForMessageRole(role),
        causality: { messageId: brandId<MessageId>(visibleMessageId) },
        payload: {
          protocol: "agentic.trajectory.v1",
          reason: failureReason,
          recoverable: true,
        },
        createdAt: this.messageTimestamp(message),
      };
      this.provenanceQueue.push({
        event: failedEvent,
        eventId: this.semanticEntryEventId(messageEntryId, "message:failed", failedEvent),
        // A suspended turn's failure is a PAUSE, not an error: keep the trajectory
        // record (resume reads it from the session) but never broadcast it to the
        // channel, so the panel never renders it as a red error. The turn.waiting
        // event the worker emits is the user-facing "waiting" signal.
        publishToChannel: !this.pendingSuspension && this.shouldPublishMessageToChannel(role),
      });
    }

    for (const [blockIndex, block] of this.messageBlocks(message).entries()) {
      const toolCallId = this.toolCallIdFromBlock(block);
      if (toolCallId) {
        const name = this.toolNameFromBlock(block) ?? "unknown";
        const request = this.toolInputFromBlock(block) ??
          this.asJsonRecord(block) ?? { blockIndex };
        this.openInvocationIds.add(toolCallId);
        this.openToolInvocations.set(toolCallId, {
          invocationId: toolCallId,
          modelToolCallId: toolCallId,
          name,
          request: summarizeDebugValue(request),
          messageId: visibleMessageId,
          blockIndex,
          ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          startedAt: this.messageTimestamp(message),
        });
        const startedEvent: AgenticEvent = {
          kind: "invocation.started",
          actor: this.actorForMessageRole(role),
          causality: {
            messageId: brandId<MessageId>(visibleMessageId),
            invocationId: brandId<InvocationId>(toolCallId),
            modelToolCallId: toolCallId,
          },
          payload: {
            protocol: "agentic.trajectory.v1",
            name,
            invocationType: "tool",
            request,
            transport: { kind: "local", awaiterId: toolCallId },
            userVisible: true,
          },
          createdAt: this.messageTimestamp(message),
        };
        this.provenanceQueue.push({
          event: startedEvent,
          eventId: this.semanticEntryEventId(
            messageEntryId,
            `invocation:${toolCallId}:started`,
            startedEvent
          ),
          publishToChannel: true,
        });
      }
    }

    if ((message as { role?: string }).role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      const toolName = (message as { toolName?: unknown }).toolName;
      const details = (message as { details?: unknown }).details;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        this.openInvocationIds.delete(toolCallId);
        this.openToolInvocations.delete(toolCallId);
        if (this.terminalInvocationIds.has(toolCallId)) return;
        const terminalMarker = terminalMarkerFromDetails(details);
        const isError = (message as { isError?: boolean }).isError === true;
        const terminalOutcome = terminalMarker?.outcome ?? (isError ? "tool_error" : "success");
        const terminalReasonCode =
          terminalMarker?.reasonCode ?? (isError ? "eval_exception" : undefined);
        const terminalKind = invocationTerminalKindForOutcome(terminalOutcome);
        const failureOutcome = terminalOutcome === "success" ? "tool_error" : terminalOutcome;
        const summary = this.summarizeToolResult({
          content: (message as { content?: unknown }).content ?? [],
          details,
        } as AgentToolResult<unknown>);
        const text = this.toolResultText({
          content: (message as { content?: unknown }).content ?? [],
          details,
        } as AgentToolResult<unknown>);
        const errorPayload = {
          toolCallId,
          toolName: typeof toolName === "string" ? toolName : "unknown",
          text,
          content: (message as { content?: unknown }).content ?? [],
          details,
        };
        const terminalPayload =
          terminalKind === "invocation.completed"
            ? invocationCompletedPayload({
                result: {
                  toolCallId,
                  toolName: typeof toolName === "string" ? toolName : "unknown",
                  content: (message as { content?: unknown }).content ?? [],
                  details,
                },
                summary,
                ...(terminalReasonCode ? { terminalReasonCode } : {}),
              })
            : terminalKind === "invocation.failed"
              ? invocationFailedPayload(
                  failureOutcome === "infrastructure_error" ? "infrastructure_error" : "tool_error",
                  summary,
                  {
                    error: errorPayload,
                    recoverable: true,
                    ...(terminalReasonCode ? { terminalReasonCode } : {}),
                  }
                )
              : terminalKind === "invocation.cancelled"
                ? invocationCancelledPayload(
                    failureOutcome === "stale_dispatch" ? "stale_dispatch" : "cancelled",
                    summary,
                    {
                      error: errorPayload,
                      recoverable: true,
                      ...(terminalReasonCode ? { terminalReasonCode } : {}),
                    }
                  )
                : invocationAbandonedPayload(summary, {
                    error: errorPayload,
                    recoverable: true,
                    ...(terminalReasonCode ? { terminalReasonCode } : {}),
                  });
        const terminalEvent: AgenticEvent = {
          kind: terminalKind,
          actor: this.agentActor(),
          causality: {
            messageId: brandId<MessageId>(visibleMessageId),
            invocationId: brandId<InvocationId>(toolCallId),
            modelToolCallId: toolCallId,
          },
          payload: terminalPayload,
          createdAt: this.messageTimestamp(message),
        };
        this.provenanceQueue.push({
          event: terminalEvent,
          eventId: this.semanticEntryEventId(
            messageEntryId,
            `invocation:${toolCallId}:terminal`,
            terminalEvent
          ),
          publishToChannel: true,
        });
      }
    }
  }

  private async flushProvenance(): Promise<void> {
    if (!this.options.gad || this.provenanceQueue.length === 0) return;
    const batch = this.provenanceQueue;
    this.provenanceQueue = [];
    try {
      await this.appendTrajectoryEvents(batch);
    } catch (err) {
      const outcome = await this.flushProvenanceIndividually(batch, err);
      if (outcome.sizeLimitError) {
        const error =
          outcome.sizeLimitError.error instanceof AgentWorkerError
            ? outcome.sizeLimitError.error
            : this.provenanceSizeLimitError(
                outcome.sizeLimitError.item,
                outcome.sizeLimitError.error
              );
        this.rememberError("trajectory.append.size_limit", error);
        throw error;
      }
      if (outcome.permanentError) {
        const error = this.provenancePermanentError(
          outcome.permanentError.item,
          outcome.permanentError.error
        );
        this.rememberError("trajectory.append.permanent", error);
        throw error;
      }
      if (outcome.requeued > 0 || !isPermanentProvenanceError(err)) throw err;
    }
  }

  private async flushProvenanceIndividually(
    batch: TrajectoryQueueItem[],
    batchError: unknown
  ): Promise<{
    requeued: number;
    sizeLimitError?: { item: TrajectoryQueueItem; error: unknown };
    permanentError?: { item: TrajectoryQueueItem; error: unknown };
  }> {
    if (!this.options.gad) return { requeued: 0 };
    const retry: TrajectoryQueueItem[] = [];
    let sizeLimitError: { item: TrajectoryQueueItem; error: unknown } | undefined;
    let permanentError: { item: TrajectoryQueueItem; error: unknown } | undefined;
    for (const item of batch) {
      try {
        await this.appendTrajectoryEvents([item]);
      } catch (err) {
        if (isProvenanceSizeLimitError(err)) {
          retry.push(item);
          sizeLimitError ??= { item, error: err };
          continue;
        }
        if (isPermanentProvenanceError(err)) {
          retry.push(item);
          permanentError ??= { item, error: err };
          continue;
        }
        retry.push(item);
      }
    }
    if (retry.length > 0 || permanentError || !isPermanentProvenanceError(batchError)) {
      this.provenanceQueue = [...retry, ...this.provenanceQueue];
    }
    return { requeued: retry.length, sizeLimitError, permanentError };
  }

  private provenancePermanentError(item: TrajectoryQueueItem, err: unknown): AgentWorkerError {
    const eventId = item.eventId ? ` eventId=${item.eventId}` : "";
    return new AgentWorkerError(
      "provenance",
      `Permanent provenance persistence failure:${eventId} kind=${item.event.kind}`,
      { cause: err }
    );
  }

  private provenanceSizeLimitError(item: TrajectoryQueueItem, err: unknown): AgentWorkerError {
    const payloadBytes = Buffer.byteLength(JSON.stringify(item.event.payload), "utf8");
    const eventBytes = Buffer.byteLength(JSON.stringify(item.event), "utf8");
    const eventId = item.eventId ? ` eventId=${item.eventId}` : "";
    return new AgentWorkerError(
      "provenance",
      `Provenance event is too large to store:${eventId} kind=${item.event.kind} payloadBytes=${payloadBytes} eventBytes=${eventBytes}`,
      { cause: err }
    );
  }

  private async normalizeProvenanceEvent(
    event: AgenticEvent,
    eventId?: string
  ): Promise<AgenticEvent> {
    const { event: normalized, eventBytes } = await encodeAgenticEventStoredValues(event, {
      putText: (value) => this.putRequiredGadBlob(value),
    });
    if (eventBytes <= MAX_INLINE_TRAJECTORY_EVENT_BYTES) return normalized;
    throw new AgentWorkerError(
      "provenance",
      `Provenance event remains too large after blob spilling:${eventId ? ` eventId=${eventId}` : ""} kind=${normalized.kind} eventBytes=${eventBytes} maxBytes=${MAX_INLINE_TRAJECTORY_EVENT_BYTES}`
    );
  }

  private async appendTrajectoryEvents(items: TrajectoryQueueItem[]): Promise<void> {
    if (items.length === 0 || !this.options.gad) return;
    const events = await Promise.all(
      items.map(async (item) => {
        const event = await this.normalizeProvenanceEvent(
          this.withCurrentTurnId(item.event),
          item.eventId
        );
        const publishToChannel = this.options.publicationPolicy
          ? this.options.publicationPolicy({ event, publishToChannel: item.publishToChannel })
          : item.publishToChannel;
        this.rememberTrajectoryEvent({ ...item, event, publishToChannel });
        return {
          event,
          ...(item.eventId ? { eventId: item.eventId } : {}),
          ...(this.options.gad?.channelId && publishToChannel === true
            ? { publish: { channelIds: [this.options.gad.channelId] } }
            : {}),
        };
      })
    );
    try {
      const result = await this.gad.call<AppendTrajectoryBatchResultLike>("appendTrajectoryBatch", {
        trajectoryId: this.gadTrajectoryId(),
        branchId: this.options.gad.branchId,
        owner: this.agentActor(),
        events,
      });
      for (const { event } of events) {
        const invocationId = (event as { causality?: { invocationId?: unknown } }).causality
          ?.invocationId;
        if (typeof invocationId === "string" && this.isTerminalInvocationEvent(event.kind)) {
          this.terminalInvocationIds.add(invocationId);
        }
      }
      this.schedulePublishedChannelEnvelopeBroadcasts(result?.published ?? []);
    } catch (err) {
      this.rememberError("trajectory.append", err);
      throw err;
    }
  }

  private schedulePublishedChannelEnvelopeBroadcasts(
    publications: PublishedChannelEnvelope[]
  ): void {
    if (publications.length === 0) return;
    const byChannel = new Map<string, string[]>();
    for (const publication of publications) {
      if (!publication.channelId || !publication.envelopeId) continue;
      const existing = byChannel.get(publication.channelId) ?? [];
      existing.push(publication.envelopeId);
      byChannel.set(publication.channelId, existing);
    }
    for (const [channelId, envelopeIds] of byChannel) {
      this.enqueueChannelPublicationBroadcast(channelId, envelopeIds);
    }
  }

  private enqueueChannelPublicationBroadcast(channelId: string, envelopeIds: string[]): void {
    if (envelopeIds.length === 0) return;
    const state = this.getChannelPublicationBroadcastState(channelId);
    state.pendingBatches += 1;
    state.queuedEnvelopeIds.push(...envelopeIds);
    state.lastScheduledAt = new Date().toISOString();

    const previous = this.channelPublicationBroadcastChains.get(channelId) ?? Promise.resolve();
    const next = previous.then(async () => {
      state.activeEnvelopeIds = [...envelopeIds];
      state.queuedEnvelopeIds = removeQueuedEnvelopeIds(state.queuedEnvelopeIds, envelopeIds);
      try {
        const target = await this.resolveChannelTarget(channelId);
        await this.options.rpc.call(target, "broadcastStoredEnvelopes", [envelopeIds]);
        state.lastCompletedAt = new Date().toISOString();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = {
          envelopeIds: [...envelopeIds],
          message,
          at: new Date().toISOString(),
        };
        state.failureCount = (state.failureCount ?? 0) + 1;
        this.rememberError("channel_publication.broadcast", err);
        this.rememberCheckpoint("channel_publication.broadcast.failed", {
          channelId,
          envelopeIds,
          failureCount: state.failureCount,
          error: message,
        });
        console.warn("[PiRunner] channel publication broadcast failed:", {
          channelId,
          envelopeIds,
          error: message,
        });
      } finally {
        state.pendingBatches = Math.max(0, state.pendingBatches - 1);
        state.activeEnvelopeIds = [];
        this.pruneChannelPublicationBroadcastState(channelId, state);
      }
    });

    this.channelPublicationBroadcastChains.set(channelId, next);
    void next.finally(() => {
      if (this.channelPublicationBroadcastChains.get(channelId) === next) {
        this.channelPublicationBroadcastChains.delete(channelId);
      }
    });
  }

  private getChannelPublicationBroadcastState(channelId: string): ChannelPublicationBroadcastState {
    let state = this.channelPublicationBroadcasts.get(channelId);
    if (!state) {
      state = {
        pendingBatches: 0,
        queuedEnvelopeIds: [],
        activeEnvelopeIds: [],
      };
      this.channelPublicationBroadcasts.set(channelId, state);
    }
    return state;
  }

  private pruneChannelPublicationBroadcastState(
    channelId: string,
    state: ChannelPublicationBroadcastState
  ): void {
    if (
      state.pendingBatches === 0 &&
      state.queuedEnvelopeIds.length === 0 &&
      state.activeEnvelopeIds.length === 0 &&
      !state.lastError
    ) {
      this.channelPublicationBroadcasts.delete(channelId);
    }
  }

  private async resolveChannelTarget(channelId: string): Promise<string> {
    let promise = this.channelTargetPromises.get(channelId);
    if (!promise) {
      promise = this.options.rpc
        .call<ResolvedServiceLike>("main", "workers.resolveService", [
          "natstack.channel.v1",
          channelId,
        ])
        .then((service) => {
          if (service.kind !== "durable-object" || !service.targetId) {
            throw new Error(`Channel service for ${channelId} did not resolve to a Durable Object`);
          }
          return service.targetId;
        });
      void promise.catch(() => {
        if (this.channelTargetPromises.get(channelId) === promise) {
          this.channelTargetPromises.delete(channelId);
        }
      });
      this.channelTargetPromises.set(channelId, promise);
    }
    return promise;
  }

  private withCurrentTurnId(event: AgenticEvent): AgenticEvent {
    if (
      event.turnId ||
      event.actor.kind !== "agent" ||
      !TURN_SCOPED_OWNER_KINDS.includes(event.kind as (typeof TURN_SCOPED_OWNER_KINDS)[number])
    ) {
      return event;
    }
    const turnId = this.currentTurnId ?? brandId<TurnId>(uuidv7());
    this.currentTurnId = turnId;
    return { ...event, turnId };
  }

  private async appendMessageWithProvenance(message: AgentMessage): Promise<string> {
    if (!this.harness || !this.session) {
      throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    }
    await this.harness.appendMessage(message);
    const entryId = await this.session.getLeafId();
    if (!entryId) {
      throw new AgentWorkerError("session", "appendMessage completed without a leaf entry");
    }
    await this.queueSessionEntryProvenance(entryId);
    this.queueMessageProvenance(message, entryId);
    await this.flushProvenance();
    return entryId;
  }

  async appendUserMessage(message: AgentMessage): Promise<string> {
    if ((message as { role?: string }).role !== "user") {
      throw new AgentWorkerError("invalid_argument", "appendUserMessage requires a user message");
    }
    return this.appendMessageWithProvenance(message);
  }

  async appendToolResult(message: AgentMessage): Promise<string> {
    if ((message as { role?: string }).role !== "toolResult") {
      throw new AgentWorkerError(
        "invalid_argument",
        "appendToolResult requires a toolResult message"
      );
    }
    return this.appendMessageWithProvenance(message);
  }

  private async writeMutationIntent(
    toolCallId: string,
    toolName: "edit" | "write",
    params: unknown
  ): Promise<void> {
    if (!this.options.gad) return;
    const absPath = this.toolInputPath(toolName, params);
    if (!absPath) return;
    const relativePathString = this.gadPathFromAbsolute(absPath);
    if (!relativePathString) return;

    const before = await this.snapshotMutationTarget(absPath);
    const intentEntryId = uuidv7();
    const intent: TrajectoryQueueItem = {
      eventId: intentEntryId,
      event: {
        kind: "state.file_mutation_intended",
        actor: this.agentActor(),
        causality: {
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload: {
          protocol: "agentic.trajectory.v1",
          mutationId: intentEntryId,
          path: relativePathString,
          beforeHash: before?.digest,
          operation: toolName,
          metadata: {
            toolCallId,
            beforeSize: before?.size ?? null,
            plannedTool: toolName,
            plannedParams: this.asJsonRecord(params) ?? {},
            parentEntryId: await this.currentLeafEntryId(),
          },
        },
        createdAt: new Date().toISOString(),
      },
    };

    await this.appendTrajectoryEvents([intent]);
    this.pendingMutations.set(toolCallId, {
      intentEntryId,
      path: relativePathString,
      before,
      toolCallId,
      toolName,
    });
  }

  private async recordMutationObserved(
    toolCallId: string,
    outcome: "ok" | "error",
    errorMessage?: string
  ): Promise<void> {
    const pending = this.pendingMutations.get(toolCallId);
    if (!pending) return;
    this.pendingMutations.delete(toolCallId);

    const absPath = this.absolutePathFromGadRelative(pending.path);
    const after = absPath ? await this.snapshotMutationTarget(absPath) : null;
    if (outcome === "error" && !after?.digest) {
      this.provenanceQueue.push({
        event: {
          kind: "system.event",
          actor: this.agentActor(),
          causality: {
            invocationId: brandId<InvocationId>(toolCallId),
            modelToolCallId: toolCallId,
          },
          payload: {
            protocol: "agentic.trajectory.v1",
            kind: "file_mutation_failed",
            summary: errorMessage,
            details: {
              mutationId: pending.intentEntryId,
              path: pending.path,
              operation: pending.toolName,
              toolCallId,
            },
          },
          createdAt: new Date().toISOString(),
        },
      });
      return;
    }

    const afterHash = after?.digest ?? pending.before?.digest;
    if (!afterHash) return;
    this.provenanceQueue.push({
      event: {
        kind: "state.file_mutation_applied",
        actor: this.agentActor(),
        causality: {
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload: {
          protocol: "agentic.trajectory.v1",
          mutationId: pending.intentEntryId,
          path: pending.path,
          beforeHash: pending.before?.digest,
          afterHash,
          size: after?.size ?? pending.before?.size ?? undefined,
          summary: outcome,
          operation: pending.toolName,
          metadata: { toolCallId },
          ...(errorMessage ? { error: errorMessage } : {}),
        },
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async recordReadOrObservation(
    toolCallId: string,
    toolName: string,
    params: unknown,
    result: AgentToolResult<any>
  ): Promise<void> {
    if (!this.options.gad) return;
    const absPath = this.toolInputPath(toolName, params);
    const path = this.gadPathFromAbsolute(absPath);
    if (!path) return;

    const text = this.toolResultText(result);
    const blob = await this.putGadBlob(text);
    if (!blob) return;

    const parentEntryId = await this.currentLeafEntryId();
    if (toolName === "read") {
      this.provenanceQueue.push({
        event: {
          kind: "state.file_observed",
          actor: this.agentActor(),
          causality: {
            invocationId: brandId<InvocationId>(toolCallId),
            modelToolCallId: toolCallId,
          },
          payload: {
            protocol: "agentic.trajectory.v1",
            path,
            contentHash: blob.digest,
            size: blob.size,
            metadata: { parentEntryId, observedStateHash: undefined, toolName, toolCallId },
          },
          createdAt: new Date().toISOString(),
        },
      });
    }
    this.provenanceQueue.push({
      event: {
        kind: "state.file_observed",
        actor: this.agentActor(),
        causality: {
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload: {
          protocol: "agentic.trajectory.v1",
          path,
          contentHash: blob.digest,
          size: blob.size,
          summary: this.summarizeToolResult(result),
          metadata: {
            parentEntryId,
            toolName,
            readType: toolName === "read" ? "file" : toolName,
            parameters: this.asJsonRecord(params),
            toolCallId,
          },
        },
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async snapshotMutationTarget(absPath: string): Promise<GadBlobSnapshot | null> {
    try {
      const raw = await this.options.fs.readFile(absPath);
      return await this.putGadBlob(raw);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null;
      throw err;
    }
  }

  private async putGadBlob(value: string | Uint8Array | Buffer): Promise<GadBlobSnapshot> {
    if (typeof value === "string") {
      return await this.options.rpc.call<GadBlobSnapshot>("main", "blobstore.putText", [value]);
    }
    return await this.options.rpc.call<GadBlobSnapshot>("main", "blobstore.putBase64", [
      Buffer.from(value).toString("base64"),
    ]);
  }

  private async putRequiredGadBlob(value: string | Uint8Array | Buffer): Promise<GadBlobSnapshot> {
    try {
      return await this.putGadBlob(value);
    } catch (err) {
      throw new AgentWorkerError(
        "provenance",
        "Failed to spill oversized provenance payload to blobstore",
        { cause: err }
      );
    }
  }

  private async surfaceOrphanMutationIntents(): Promise<void> {
    if (!this.options.gad) return;
    let intents: Array<{ event_id: string; payload_ref_json: string }> = [];
    let observed: Array<{ payload_ref_json: string }> = [];
    const intentResult = await this.gad.call<{
      rows: Array<{ event_id: string; payload_ref_json: string }>;
    }>(
      "query",
      "SELECT event_id, payload_ref_json FROM trajectory_events WHERE branch_id = ? AND kind = 'state.file_mutation_intended'",
      [this.options.gad.branchId]
    );
    const observedResult = await this.gad.call<{ rows: Array<{ payload_ref_json: string }> }>(
      "query",
      "SELECT payload_ref_json FROM trajectory_events WHERE branch_id = ? AND kind = 'state.file_mutation_applied'",
      [this.options.gad.branchId]
    );
    intents = intentResult.rows;
    observed = observedResult.rows;

    const observedParents = new Set(
      observed
        .map((o) => {
          try {
            const payload = JSON.parse(o.payload_ref_json) as { mutationId?: unknown };
            return typeof payload.mutationId === "string" ? payload.mutationId : null;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => typeof id === "string")
    );
    const orphans = intents.filter((intent) => !observedParents.has(intent.event_id));
    for (const orphan of orphans) {
      const payload = JSON.parse(orphan.payload_ref_json) as { path?: string };
      const path = payload.path ?? null;
      const event = {
        type: "system_event" as const,
        kind: "orphan_file_mutation_intent" as const,
        intentEntryId: orphan.event_id,
        path,
      };
      await this.hooks.emitEvent(event);
      await this.appendTrajectoryEvents([
        {
          event: {
            kind: "system.event",
            actor: { kind: "system", id: "pi-runner" },
            causality: { parentEventId: brandId<EventId>(orphan.event_id) },
            payload: {
              protocol: "agentic.trajectory.v1",
              kind: event.kind,
              details: {
                intentEntryId: event.intentEntryId,
                path,
              },
            },
            createdAt: new Date().toISOString(),
          },
        },
      ]);
    }
  }

  private toolInputPath(toolName: string, params: unknown): string | null {
    const rawPath = this.stringParam(params, "path");
    const cwd = this.options.cwd ?? "/";
    if (toolName === "read" && rawPath) return resolveReadPath(rawPath, cwd);
    if (
      (toolName === "edit" ||
        toolName === "write" ||
        toolName === "grep" ||
        toolName === "find" ||
        toolName === "ls") &&
      rawPath
    ) {
      return resolveToCwd(rawPath, cwd);
    }
    if (toolName === "grep" || toolName === "find" || toolName === "ls") {
      return resolveToCwd(".", cwd);
    }
    return null;
  }

  private gadPathFromAbsolute(filePath: string | null | undefined): string | null {
    if (!filePath) return null;
    const cwd = this.options.cwd ?? "/";
    const rel = isAbsolute(filePath) ? relativePath(cwd, filePath) : filePath;
    const normalized = rel.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      normalized.startsWith("/")
    ) {
      return null;
    }
    return normalized;
  }

  private absolutePathFromGadRelative(rel: string): string | null {
    const cwd = this.options.cwd ?? "/";
    return resolveToCwd(rel, cwd);
  }

  private summarizeToolResult(result: AgentToolResult<any>): string {
    const text = this.toolResultText(result).replace(/\s+/gu, " ").trim();
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  }

  private toolResultText(result: AgentToolResult<any>): string {
    const content = (result as { content?: unknown }).content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return String(block);
        const item = block as { type?: string; text?: string; mimeType?: string };
        if (item.type === "text") return item.text ?? "";
        if (item.type === "image") return `[image ${item.mimeType ?? "unknown"}]`;
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringParam(params: unknown, key: string): string | null {
    if (!params || typeof params !== "object") return null;
    const value = (params as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }

  private asJsonRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : null;
  }

  private async currentLeafEntryId(): Promise<string | null> {
    return (await this.session?.getLeafId()) ?? null;
  }

  private messageRole(message: AgentMessage): MessageRole {
    const role = (message as { role?: string }).role;
    if (role === "assistant" || role === "system" || role === "user") return role;
    if (role === "tool" || role === "toolResult") return "tool";
    if (role === "panel") return "panel";
    return "system";
  }

  private actorForMessageRole(role: MessageRole): AgenticEvent["actor"] {
    if (role === "user") return { kind: "user", id: "user" };
    if (role === "panel") return { kind: "panel", id: "panel" };
    if (role === "tool") return this.agentActor({ idSuffix: ":tool", displayNameSuffix: " tool" });
    if (role === "assistant") return this.agentActor();
    return { kind: "system", id: this.agentActor().id };
  }

  private agentActor(opts?: {
    idSuffix?: string;
    displayNameSuffix?: string;
  }): AgenticEvent["actor"] {
    const base = this.options.agentActor ?? {
      kind: "agent" as const,
      id: "pi",
      displayName: "AI Agent",
    };
    return {
      ...base,
      id: `${base.id}${opts?.idSuffix ?? ""}`,
      ...(base.displayName || opts?.displayNameSuffix
        ? { displayName: `${base.displayName ?? base.id}${opts?.displayNameSuffix ?? ""}` }
        : {}),
    };
  }

  private shouldPublishMessageToChannel(role: MessageRole): boolean {
    // User messages are already durably published by PubSubClient.send().
    // Tool results are represented in the transcript by invocation events.
    return role === "assistant" || role === "panel" || role === "system";
  }

  private messageTimestamp(message: AgentMessage): string {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
    if (typeof timestamp === "string") {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
    return new Date().toISOString();
  }

  private classifyMessageOutcome(
    message: AgentMessage,
    blocks: MessageBlockInput[]
  ): MessageOutcome {
    const stopReason = agentMessageStopReason(message);
    if (stopReason === "aborted") return "interrupted";
    const summary = summarizeMessageBlocks(blocks);
    if (summary.isEmpty) return "empty";
    if (
      summary.hasInvocations &&
      !summary.hasText &&
      !summary.hasThinking &&
      !summary.hasAttachmentOrData
    ) {
      return "tool_calls_only";
    }
    return "completed";
  }

  private messageBlocksForTrajectory(blocks: unknown[], messageId: string): MessageBlockInput[] {
    return blocks.map((block, index) => {
      const blockId = brandId<BlockId>(`${messageId}:block:${index}`);
      const type = this.classifyBlock(block);
      const toolCallId = this.toolCallIdFromBlock(block);
      const record = this.asJsonRecord(block);
      if (type === "invocation" && toolCallId) {
        return {
          blockId,
          type: "invocation",
          invocationId: brandId<InvocationId>(toolCallId),
          metadata: record ?? undefined,
        };
      }
      if (type === "thinking") {
        return {
          blockId,
          type: "thinking",
          content: this.extractGeneratedText(record, [
            "thinking",
            "text",
            "content",
            "summary",
            "reasoning_content",
            "reasoning",
            "reasoning_text",
          ]),
          metadata: record ?? undefined,
        };
      }
      return {
        blockId,
        type: "text",
        content:
          this.extractGeneratedText(record, ["text", "content", "output_text", "refusal"]) ||
          (typeof block === "string" ? block : ""),
        metadata: record ?? undefined,
      };
    });
  }

  private classifyBlock(block: unknown): "text" | "thinking" | "invocation" {
    if (!block || typeof block !== "object") return "text";
    const type = (block as { type?: unknown }).type;
    if (type === "thinking" || type === "reasoning") return "thinking";
    const camelToolBlockType = "tool" + "Call";
    if (type === camelToolBlockType || type === "tool_call") return "invocation";
    return "text";
  }

  private extractGeneratedText(
    record: Record<string, unknown> | null,
    keys: readonly string[]
  ): string {
    if (!record) return "";
    for (const key of keys) {
      const text = this.extractTextValue(record[key]);
      if (text) return text;
    }
    return "";
  }

  private extractTextValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((item) => this.extractTextValue(item))
        .filter((item) => item.length > 0)
        .join("\n\n");
    }
    const record = this.asJsonRecord(value);
    if (!record) return "";
    return this.extractGeneratedText(record, ["text", "content", "thinking", "refusal"]);
  }

  private toolCallIdFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    if (typeof item["id"] === "string") return item["id"];
    if (typeof item["toolCallId"] === "string") return item["toolCallId"];
    if (typeof item["tool_call_id"] === "string") return item["tool_call_id"];
    if (typeof item["callId"] === "string") return item["callId"];
    return null;
  }

  private toolNameFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    if (typeof item["name"] === "string") return item["name"];
    if (typeof item["toolName"] === "string") return item["toolName"];
    if (typeof item["tool_name"] === "string") return item["tool_name"];
    if (typeof item["tool"] === "string") return item["tool"];
    const fn = this.asJsonRecord(item["function"]);
    if (typeof fn?.["name"] === "string") return fn["name"];
    return null;
  }

  private toolInputFromBlock(block: unknown): unknown {
    if (!block || typeof block !== "object") return undefined;
    const item = block as Record<string, unknown>;
    for (const key of ["input", "args", "arguments", "parameters"]) {
      if (key in item) return this.parseMaybeJson(item[key]);
    }
    const fn = this.asJsonRecord(item["function"]);
    if (fn && "arguments" in fn) return this.parseMaybeJson(fn["arguments"]);
    return undefined;
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private messageBlocks(message: AgentMessage): unknown[] {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content;
    return [];
  }

  subscribe(listener: EventListener): () => void {
    return this.hooks.on("event", listener);
  }

  onTransformContext(listener: TransformContextListener): () => void {
    return this.hooks.on("transform_context", listener);
  }

  async prompt(input: RunnerTurnInput, opts: RunnerTurnOptions = {}): Promise<void> {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    this.adoptTurnId(opts.turnId);
    this.pendingSuspension = null; // a new operation supersedes any prior suspension
    const operationId = uuidv7();
    this.activeOperationId = operationId;
    this.activeOperationSawAgentStart = false;
    this.activeOperationSawAgentEnd = false;
    this.beginActivation(this.currentTurnId);
    this.currentOperation = {
      kind: "prompt",
      operationId,
      turnId: this.currentTurnId,
      startedAt: new Date().toISOString(),
      input: {
        contentLength: input.content.length,
        contentPreview: previewText(input.content),
        imageCount: input.images?.length ?? 0,
      },
    };
    this.rememberCheckpoint("prompt.start", this.currentOperation.input);
    try {
      this.rememberCheckpoint("prompt.refresh_tools.start");
      await this.refreshRuntimeTools("prompt.preflight");
      this.rememberCheckpoint("prompt.refresh_tools.ok");
      this.rememberCheckpoint("prompt.harness.start");
      await this.runHarnessOperation("prompt", () =>
        this.harness!.prompt(input.content, input.images ? { images: input.images } : undefined)
      );
      this.assertOperationLifecycleComplete("prompt", operationId);
      this.rememberCheckpoint("prompt.harness.ok");
    } catch (err) {
      const suspension = isTurnSuspensionSignal(err) ? err : this.pendingSuspension;
      if (suspension) {
        this.rememberCheckpoint("prompt.suspended", {
          reason: suspension.reason,
          turnId: this.currentTurnId ?? null,
        });
      } else {
        await this.settleFailedOperationTurn(
          opts.turnId,
          "work_failed",
          "Agent turn failed before completion"
        );
        this.rememberError("prompt", err);
      }
      this.rememberCheckpoint("prompt.error", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (this.activeOperationId === operationId) {
        this.activeOperationId = null;
        this.activeOperationSawAgentStart = false;
        this.activeOperationSawAgentEnd = false;
      }
      this.currentOperation = null;
    }
  }

  buildUserMessage(input: RunnerTurnInput): AgentMessage {
    return {
      role: "user",
      content: [{ type: "text", text: input.content }, ...(input.images ?? [])],
      timestamp: Date.now(),
    } as AgentMessage;
  }

  async steerMessage(message: AgentMessage): Promise<void> {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    const harness = this.harness as unknown as AgentHarnessQueueAccess;
    this.rememberCheckpoint("steer.queue.push", {
      queuedBefore: harness.steerQueue.length,
      role: (message as { role?: unknown }).role,
    });
    harness.steerQueue.push(message);
    try {
      this.rememberCheckpoint("steer.queue_update.start", {
        queuedAfter: harness.steerQueue.length,
      });
      await harness.emitQueueUpdate();
      this.rememberCheckpoint("steer.queue_update.ok", {
        queuedAfter: harness.steerQueue.length,
      });
    } catch (err) {
      this.rememberError("steer.queue_update", err);
      this.rememberCheckpoint("steer.queue_update.error", {
        error: err instanceof Error ? err.message : String(err),
        queuedAfter: harness.steerQueue.length,
      });
      throw err;
    }
  }

  async clearSteeringQueue(): Promise<void> {
    if (!this.harness) return;
    const harness = this.harness as unknown as AgentHarnessQueueAccess;
    if (harness.steerQueue.length === 0) return;
    this.rememberCheckpoint("steer.clear.start", {
      queuedBefore: harness.steerQueue.length,
    });
    harness.steerQueue.splice(0);
    try {
      await harness.emitQueueUpdate();
      this.rememberCheckpoint("steer.clear.ok");
    } catch (err) {
      this.rememberError("steer.clear", err);
      this.rememberCheckpoint("steer.clear.error", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async continueAgent(opts: RunnerTurnOptions = {}): Promise<void> {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    this.adoptTurnId(opts.turnId);
    this.pendingSuspension = null; // resuming the turn clears its suspension
    const operationId = uuidv7();
    this.activeOperationId = operationId;
    this.activeOperationSawAgentStart = false;
    this.activeOperationSawAgentEnd = false;
    this.ensureActivation(this.currentTurnId);
    this.currentOperation = {
      kind: "continue",
      operationId,
      turnId: this.currentTurnId,
      startedAt: new Date().toISOString(),
    };
    this.rememberCheckpoint("continue.start");
    try {
      this.rememberCheckpoint("continue.preflight.start");
      await this.prepareSessionForContinue();
      this.rememberCheckpoint("continue.preflight.ok");
      this.rememberCheckpoint("continue.refresh_tools.start");
      await this.refreshRuntimeTools("continue.preflight");
      this.rememberCheckpoint("continue.refresh_tools.ok");
      this.rememberCheckpoint("continue.harness.start");
      await this.runHarnessOperation("continue", () => this.harness!.continue());
      this.assertOperationLifecycleComplete("continue", operationId);
      this.rememberCheckpoint("continue.harness.ok");
    } catch (err) {
      const suspension = isTurnSuspensionSignal(err) ? err : this.pendingSuspension;
      if (suspension) {
        this.rememberCheckpoint("continue.suspended", {
          reason: suspension.reason,
          turnId: this.currentTurnId ?? null,
        });
      } else {
        await this.settleFailedOperationTurn(
          opts.turnId,
          "work_failed",
          "Agent turn failed before completion"
        );
        this.rememberError("continue", err);
      }
      this.rememberCheckpoint("continue.error", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (this.activeOperationId === operationId) {
        this.activeOperationId = null;
        this.activeOperationSawAgentStart = false;
        this.activeOperationSawAgentEnd = false;
      }
      this.currentOperation = null;
    }
  }

  async getContinueReadiness(): Promise<{
    continuable: boolean;
    reason?: string;
    lastRole?: string | null;
    lastStopReason?: string | null;
    leafId?: string | null;
  }> {
    if (!this.session) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    const [leafId, branch, context] = await Promise.all([
      this.session.getLeafId(),
      this.session.getBranch(),
      this.session.buildContext(),
    ]);
    const last = context.messages[context.messages.length - 1] as
      | ({ role?: string; stopReason?: string } & AgentMessage)
      | undefined;
    if (!last) return { continuable: false, reason: "empty_context", leafId };
    if (last.role === "user" || last.role === "toolResult") {
      return { continuable: true, lastRole: last.role, leafId };
    }
    const leafEntry = branch[branch.length - 1] as
      | { type?: string; id?: string; message?: AgentMessage }
      | undefined;
    if (
      last.role === "assistant" &&
      last.stopReason === "aborted" &&
      !this.assistantMessageHasVisibleContent(last) &&
      leafEntry?.type === "message" &&
      leafEntry.id === leafId
    ) {
      return {
        continuable: true,
        reason: "repairable_empty_aborted_assistant_leaf",
        lastRole: last.role,
        lastStopReason: last.stopReason,
        leafId,
      };
    }
    return {
      continuable: false,
      reason: "unsupported_last_role",
      lastRole: last.role ?? null,
      lastStopReason: last.stopReason ?? null,
      leafId,
    };
  }

  private async prepareSessionForContinue(): Promise<void> {
    if (!this.session) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    const [leafId, branch, context] = await Promise.all([
      this.session.getLeafId(),
      this.session.getBranch(),
      this.session.buildContext(),
    ]);
    const last = context.messages[context.messages.length - 1] as
      | ({ role?: string; stopReason?: string } & AgentMessage)
      | undefined;
    if (!last) {
      this.lastContinueDiagnostic = {
        status: "invalid",
        reason: "empty_context",
        leafId,
        at: new Date().toISOString(),
      };
      throw new AgentWorkerError(
        "session",
        "Cannot continue: session context is empty. Send a new prompt instead."
      );
    }
    if (last.role === "user" || last.role === "toolResult") {
      this.lastContinueDiagnostic = {
        status: "ok",
        lastRole: last.role,
        leafId,
        at: new Date().toISOString(),
      };
      return;
    }
    const leafEntry = branch[branch.length - 1] as
      | { type?: string; id?: string; parentId?: string | null; message?: AgentMessage }
      | undefined;
    if (
      last.role === "assistant" &&
      last.stopReason === "aborted" &&
      !this.assistantMessageHasVisibleContent(last) &&
      leafEntry?.type === "message" &&
      leafEntry.id === leafId
    ) {
      const repairedLeafId = leafEntry.parentId ?? null;
      await this.session.moveTo(repairedLeafId);
      this.lastContinueDiagnostic = {
        status: "repaired",
        reason: "empty_aborted_assistant_leaf",
        fromLeafId: leafId,
        toLeafId: repairedLeafId,
        at: new Date().toISOString(),
      };
      this.rememberCheckpoint("continue.preflight.repaired", this.lastContinueDiagnostic);
      return;
    }
    this.lastContinueDiagnostic = {
      status: "invalid",
      reason: "unsupported_last_role",
      lastRole: last.role ?? null,
      lastStopReason: last.stopReason ?? null,
      leafId,
      at: new Date().toISOString(),
    };
    throw new AgentWorkerError(
      "session",
      `Cannot continue: session context ends with ${last.role ?? "an unknown role"}. Send a new prompt instead.`
    );
  }

  async abort(
    terminalReason?: Extract<
      TurnReasonCode,
      "user_interrupted" | "channel_unsubscribe" | "turn_superseded"
    >
  ): Promise<{ clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[] }> {
    if (terminalReason && this.currentTurnId) {
      this.forceClosingTurnIds.add(this.currentTurnId);
    }
    this.activation?.controller.abort(new Error("Agent run aborted"));
    if (!this.harness) {
      return { clearedSteer: [], clearedFollowUp: [] };
    }
    return this.harness.abort();
  }

  async interrupt(): Promise<void> {
    await this.abort();
    await this.settleOpenInvocations("User interrupted execution", "cancelled", "user_interrupted");
  }

  private async settleOpenInvocations(
    reason: string,
    outcome: Extract<InvocationOutcome, "cancelled" | "abandoned" | "infrastructure_error">,
    reasonCode: string,
    turnId?: string
  ): Promise<void> {
    if (this.openInvocationIds.size === 0) return;
    const now = new Date().toISOString();
    const kind = invocationTerminalKindForOutcome(outcome);
    const items = [...this.openInvocationIds].map(
      (toolCallId): TrajectoryQueueItem => ({
        event: {
          kind,
          actor: this.agentActor(),
          ...(turnId ? { turnId: brandId<TurnId>(turnId) } : {}),
          causality: {
            invocationId: brandId<InvocationId>(toolCallId),
            modelToolCallId: toolCallId,
          },
          payload: {
            ...(outcome === "abandoned"
              ? invocationAbandonedPayload(reason, {
                  recoverable: true,
                  terminalReasonCode: reasonCode,
                })
              : outcome === "infrastructure_error"
                ? invocationFailedPayload("infrastructure_error", reason, {
                    recoverable: true,
                    terminalReasonCode: reasonCode,
                  })
                : invocationCancelledPayload("cancelled", reason, {
                    recoverable: true,
                    terminalReasonCode: reasonCode,
                  })),
          },
          createdAt: now,
        },
        publishToChannel: true,
      })
    );
    await this.appendTrajectoryEvents(items);
    for (const toolCallId of items.map((item) => item.event.causality?.invocationId)) {
      if (typeof toolCallId === "string") this.openInvocationIds.delete(toolCallId);
    }
    this.openToolInvocations.clear();
  }

  markToolCallPreApproved(toolCallId: string): void {
    this.preApprovedCallIds.add(toolCallId);
  }

  async executeToolDirect(
    toolName: string,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<AgentToolResult<any>> {
    const tool = this.computeActiveTools().find((candidate) => candidate.name === toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool "${toolName}" not available at resume time` }],
        details: { __natstack_tool_missing: true },
        isError: true,
      } as AgentToolResult<any>;
    }
    if (
      (tool as AgentTool<any> & HibernationResumableTool).natstackResume?.safeAcrossHibernation !==
      true
    ) {
      return {
        content: [
          {
            type: "text",
            text:
              `Tool "${toolName}" cannot be resumed safely after hibernation; ` +
              "please retry the tool call.",
          },
        ],
        details: { __natstack_resume_disabled: true },
        isError: true,
      } as AgentToolResult<any>;
    }

    try {
      this.markToolCallPreApproved(toolCallId);
      const result = await tool.execute(toolCallId, params as never, signal, undefined);
      if (toolName === "edit" || toolName === "write") {
        await this.recordMutationObserved(toolCallId, "ok");
      } else {
        await this.recordReadOrObservation(toolCallId, toolName, params, result);
      }
      await this.flushProvenance();
      return result;
    } catch (err) {
      if (toolName === "edit" || toolName === "write") {
        await this.recordMutationObserved(
          toolCallId,
          "error",
          err instanceof Error ? err.message : String(err)
        );
        await this.flushProvenance();
      }
      throw err;
    }
  }

  trimTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1] as
      | {
          role?: string;
          stopReason?: string;
          content?: unknown;
        }
      | undefined;
    if (!last || last.role !== "assistant" || last.stopReason !== "aborted") {
      return messages;
    }
    return this.assistantMessageHasVisibleContent(last) ? messages : messages.slice(0, -1);
  }

  private assistantMessageHasVisibleContent(message: { content?: unknown }): boolean {
    const content = Array.isArray(message.content) ? message.content : [];
    const blocks = this.messageBlocksForTrajectory(content, "trim-check");
    const summary = summarizeMessageBlocks(blocks);
    return !summary.isEmpty;
  }

  async getStateSnapshot(): Promise<PiStateSnapshot> {
    const context = await this.session?.buildContext();
    return {
      messages: context?.messages ?? [],
      isStreaming: this.running,
    };
  }

  setApprovalLevel(level: ApprovalLevel): void {
    this._approvalLevel = level;
  }

  get approvalLevel(): ApprovalLevel {
    return this._approvalLevel;
  }

  get isStreaming(): boolean {
    return this.running;
  }

  dispose(): void {
    this.endActivation("PiRunner disposed", { abort: true });
    void this.harness?.abort().catch((err) => {
      console.warn("[PiRunner] abort during dispose failed:", err);
    });
    this.harnessUnsub?.();
    this.harnessUnsub = null;
    this.harness = null;
    this.extensionRuntime = null;
    this.hooks.clear();
    this.provenanceQueue = [];
    this.pendingMutations.clear();
    this.session = null;
    this.storage = null;
    this.running = false;
    this.activeRunSignal = null;
    this.awaitingProviderFirstEvent = false;
    this.currentOperation = null;
  }
}

function resolveModel(modelName: string): Model<any> {
  const colonIdx = modelName.indexOf(":");
  if (colonIdx < 0) {
    throw new AgentWorkerError(
      "invalid_argument",
      `PiRunner: model must be "provider:model", got: ${modelName}`
    );
  }
  const provider = modelName.slice(0, colonIdx);
  const modelId = modelName.slice(colonIdx + 1);
  const model = piGetModel(provider as never, modelId as never);
  if (!model) {
    throw new AgentWorkerError("invalid_argument", `PiRunner: unknown model: ${modelName}`);
  }
  return model;
}

function createExecutionEnv(cwd: string, fs: RuntimeFs): ExecutionEnv {
  return {
    cwd,
    async absolutePath(path) {
      return ok(resolveToCwd(path, cwd));
    },
    async joinPath(parts) {
      return ok(resolveToCwd(parts.join("/"), cwd));
    },
    async readTextFile(path) {
      try {
        const value = await fs.readFile(resolveToCwd(path, cwd), "utf8");
        return ok(typeof value === "string" ? value : value.toString("utf8"));
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async readTextLines(path, options) {
      const result = await this.readTextFile(path);
      if (!result.ok) return result;
      const lines = result.value.split(/\r?\n/u);
      return ok(options?.maxLines ? lines.slice(0, options.maxLines) : lines);
    },
    async readBinaryFile(path) {
      try {
        const value = await fs.readFile(resolveToCwd(path, cwd));
        return ok(Buffer.isBuffer(value) ? new Uint8Array(value) : new TextEncoder().encode(value));
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async writeFile(path, content) {
      try {
        await fs.writeFile(resolveToCwd(path, cwd), content);
        return ok(undefined);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async appendFile(path, content) {
      try {
        const abs = resolveToCwd(path, cwd);
        let existing: string | Buffer = "";
        try {
          existing = await fs.readFile(abs);
        } catch (err) {
          if (
            !err ||
            typeof err !== "object" ||
            !("code" in err) ||
            (err as { code?: unknown }).code !== "ENOENT"
          ) {
            throw err;
          }
        }
        const next = Buffer.concat([
          Buffer.isBuffer(existing) ? existing : Buffer.from(existing),
          typeof content === "string" ? Buffer.from(content) : Buffer.from(content),
        ]);
        await fs.writeFile(abs, next);
        return ok(undefined);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async fileInfo(path) {
      try {
        const abs = resolveToCwd(path, cwd);
        const stat = await fs.stat(abs);
        return ok({
          name: basename(abs),
          path: abs,
          kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
          size: stat.size,
          mtimeMs: Date.parse(stat.mtime),
        } satisfies FileInfo);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async listDir(path) {
      try {
        const abs = resolveToCwd(path, cwd);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return ok(
          entries.map(
            (entry) =>
              ({
                name: entry.name,
                path: resolveToCwd(entry.name, abs),
                kind: entry.isDirectory()
                  ? "directory"
                  : entry.isSymbolicLink()
                    ? "symlink"
                    : "file",
                size: 0,
                mtimeMs: 0,
              }) satisfies FileInfo
          )
        );
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async canonicalPath(path) {
      try {
        const abs = resolveToCwd(path, cwd);
        return ok(fs.realpath ? await fs.realpath(abs) : abs);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async exists(path) {
      try {
        if (fs.exists) return ok(await fs.exists(resolveToCwd(path, cwd)));
        await fs.access(resolveToCwd(path, cwd), fs.constants.F_OK);
        return ok(true);
      } catch {
        return ok(false);
      }
    },
    async createDir(path, options) {
      try {
        await fs.mkdir(resolveToCwd(path, cwd), { recursive: options?.recursive ?? true });
        return ok(undefined);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async remove(path, options) {
      try {
        const abs = resolveToCwd(path, cwd);
        if (fs.rm) await fs.rm(abs, options);
        else if (options?.recursive) await fs.rmdir?.(abs);
        else await fs.unlink?.(abs);
        return ok(undefined);
      } catch (err) {
        return fileErr("unknown", path, err);
      }
    },
    async createTempDir(prefix) {
      try {
        const path = await fs.mktemp(prefix ?? "tmp-");
        await fs.mkdir(path, { recursive: true });
        return ok(path);
      } catch (err) {
        return fileErr("unknown", cwd, err);
      }
    },
    async createTempFile(options) {
      try {
        const path = await fs.mktemp(`${options?.prefix ?? ""}${options?.suffix ?? ""}`);
        await fs.writeFile(path, "");
        return ok(path);
      } catch (err) {
        return fileErr("unknown", cwd, err);
      }
    },
    async cleanup() {},
    async exec() {
      return {
        ok: false,
        error: new ExecutionError(
          "shell_unavailable",
          "Shell execution is not exposed through PiRunner env"
        ),
      };
    },
  };
}

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function isPermanentProvenanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /GAD event id collision with different content/u.test(message) ||
    /Cannot (?:resolve|abandon) unknown dispatch/u.test(message) ||
    /Cannot (?:resolve|abandon) dispatch .* from status/u.test(message) ||
    /Cannot resolve unknown approval/u.test(message) ||
    /Cannot resolve approval .* more than once/u.test(message)
  );
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function isProvenanceSizeLimitError(err: unknown): boolean {
  if (err instanceof AgentWorkerError && err.code === "provenance") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_TOOBIG/u.test(message) || /string or blob too big/u.test(message);
}

function fileErr<T>(code: FileError["code"], path: string, cause: unknown): Result<T, FileError> {
  return {
    ok: false,
    error: new FileError(
      code,
      cause instanceof Error ? cause.message : String(cause),
      path,
      cause instanceof Error ? cause : undefined
    ),
  };
}
