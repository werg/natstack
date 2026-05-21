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
import type { NatStackScopedUiContext } from "./natstack-extension-context.js";
import {
  TrajectoryBackedSessionStorage,
  materializeSessionTree,
  type TrajectorySessionMetadata,
} from "@workspace/pi-adapter";
import {
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  createInitialTrajectoryState,
  reduceTrajectory,
  TURN_SCOPED_OWNER_KINDS,
  type AgenticEvent,
  type ApprovalId,
  type EventId,
  type EventKind,
  type InvocationId,
  type MessageBlockInput,
  type MessageId,
  type MessageRole,
  type TrajectoryState,
  type TrajectoryEvent,
  type TurnId,
} from "@workspace/agentic-protocol";
import { buildTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import { HookBus, type EventListener, type TransformContextListener } from "./hook-bus.js";
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

export interface PiStateSnapshot {
    messages: AgentMessage[];
    isStreaming: boolean;
}

export interface RunnerTurnInput {
  content: string;
  images?: ImageContent[];
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

export class PiRunner {
  private harness: AgentHarness | null = null;
  private extensionRuntime: PiExtensionRuntime | null = null;
  private builtinTools: AgentTool<any>[] = [];
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
  private readonly channelTargetPromises = new Map<string, Promise<string>>();
  private readonly openInvocationIds = new Set<string>();
  private restoredTrajectoryState: TrajectoryState | null = null;
  private activeAssistantMessage: { messageId: string; lastText: string; started: boolean } | null = null;

  constructor(private readonly options: PiRunnerOptions) {
    this._approvalLevel = options.approvalLevel;
    this.compactionTrigger = new CompactionTrigger(options.compactionPolicy);
    this.gad = createGadServiceClient(options.rpc);
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  forgetOpenInvocation(invocationId: string): void {
    this.openInvocationIds.delete(invocationId);
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
            this.currentTurnId ?? undefined,
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
    await this.refreshRuntimeTools();

    this.harness = new AgentHarness({
      env: createExecutionEnv(cwd, this.options.fs),
      session: this.session,
      tools: this.computeActiveTools(),
      activeToolNames: this.computeActiveTools().map((tool) => tool.name),
      model: this.resolvedModel,
      thinkingLevel: this.options.thinkingLevel ?? "medium",
      getApiKeyAndHeaders: async () => ({ apiKey: await this.options.getApiKey() }),
      systemPrompt: () => this.composeCurrentSystemPrompt(),
    });

    this.wireHarness();
    await this.surfaceOrphanMutationIntents();
    await this.repairDurableOpenState();
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
    const state = events.reduce(reduceTrajectory, createInitialTrajectoryState());
    this.restoredTrajectoryState = state;
    return new TrajectoryBackedSessionStorage({
      trajectoryId,
      branchId: gad.branchId,
      entries: materializeSessionTree(state),
      appendEvent: async (event) => {
        await this.appendTrajectoryEvents([{ event }]);
      },
    });
  }

  private gadTrajectoryId(): string {
    const gad = this.options.gad;
    if (!gad) throw new AgentWorkerError("invalid_state", "GAD provenance is not configured");
    return gad.trajectoryId ?? gad.workspaceId ?? gad.branchId;
  }

  private wireHarness(): void {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");

    this.harnessUnsub = this.harness.subscribe((event, signal) =>
      this.handleHarnessEvent(event, signal)
    );

    this.harness.on("context", async (event) => ({
      messages: await this.hooks.emitTransformContext(event.messages),
    }));
    this.harness.on("before_provider_request", (event) =>
      this.hooks.emitBeforeProviderRequest(event)
    );
    this.harness.on("before_agent_start", async () => {
      this.currentResources = await loadNatStackResources({ rpc: this.options.rpc });
      return { systemPrompt: this.composeCurrentSystemPrompt() };
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
      await this.flushProvenance();
      await this.prepareFollowingTurn();
      return undefined;
    });
    this.harness.on("settled", async () => {
      await this.flushProvenance();
      await this.maybeCompactWhenIdle();
      return undefined;
    });
  }

  private async dispatchToolCallEvent(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
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
        await this.recordApprovalResolved(
          toolCallId,
          result?.block ? false : true,
          result?.reason,
        );
      }
      return result ?? undefined;
    } catch (err) {
      if (needsApproval) {
        await this.recordApprovalResolved(
          toolCallId,
          false,
          err instanceof Error ? err.message : String(err),
        );
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
    input: Record<string, unknown>,
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
    reason?: string,
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

  private async refreshRuntimeTools(): Promise<void> {
    await this.extensionRuntime!.dispatch("session_start", { type: "session_start" });
    if (this.harness) {
      const tools = this.computeActiveTools();
      await this.harness.setTools(
        tools,
        tools.map((tool) => tool.name)
      );
    }
  }

  private computeActiveTools(): AgentTool<any>[] {
    return this.extensionRuntime!.getActiveTools(this.builtinTools).map((tool) =>
      this.wrapTool(tool)
    );
  }

  private wrapTool(tool: AgentTool<any>): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const dispatchResult = await this.dispatchToolCallEvent(
          toolCallId,
          tool.name,
          this.asJsonRecord(params) ?? {}
        );
        if (dispatchResult?.block) {
          throw new Error(dispatchResult.reason ?? `Tool "${tool.name}" blocked`);
        }
        if (tool.name === "edit" || tool.name === "write") {
          await this.writeMutationIntent(toolCallId, tool.name, params);
        }
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    } as AgentTool<any>;
  }

  private async prepareFollowingTurn(): Promise<void> {
    await this.refreshRuntimeTools();
    if (!this.options.onPrepareNextTurn || !this.harness || !this.session) return;
    let snapshot = await this.buildSnapshot();
    const replacement = await this.options.onPrepareNextTurn(snapshot);
    if (replacement) snapshot = replacement;
    if (snapshot.model !== this.harness.getModel()) {
      await this.harness.setModel(snapshot.model);
    }
    if (snapshot.thinkingLevel !== this.harness.getThinkingLevel()) {
      await this.harness.setThinkingLevel(snapshot.thinkingLevel);
    }
    await this.harness.setTools(
      snapshot.tools,
      snapshot.tools.map((tool) => tool.name)
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
    try {
      await this.harness.compact();
    } catch (err) {
      console.error("[PiRunner] compaction failed:", err);
    }
  }

  private async handleHarnessEvent(event: AgentHarnessEvent, _signal?: AbortSignal): Promise<void> {
    if (event.type === "agent_start") {
      this.running = true;
      await this.openCurrentTurn();
    }
    if (event.type === "message_start") {
      await this.handleMessageStart((event as { message: AgentMessage }).message);
    }
    if (event.type === "message_update") {
      await this.handleMessageUpdate((event as { message: AgentMessage }).message);
    }
    if (event.type === "message_end") {
      await this.handleMessageEnd(event.message);
    }
    if (event.type === "agent_end") {
      await this.closeCurrentTurn();
      this.running = false;
    }
    await this.hooks.emitEvent(event);
  }

  private async openCurrentTurn(): Promise<void> {
    if (!this.options.gad || this.currentTurnId) return;
    const turnId = brandId<TurnId>(uuidv7());
    this.currentTurnId = turnId;
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
  }

  private async closeCurrentTurn(): Promise<void> {
    if (!this.options.gad || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
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
    ]);
    this.currentTurnId = null;
  }

  private async repairDurableOpenState(): Promise<void> {
    if (!this.options.gad || !this.restoredTrajectoryState) return;
    const now = new Date().toISOString();
    const repairs: TrajectoryQueueItem[] = [];
    for (const invocation of Object.values(this.restoredTrajectoryState.invocations)) {
      if (this.isTerminalInvocationStatus(invocation.status)) continue;
      repairs.push({
        event: {
          kind: "invocation.abandoned",
          actor: invocation.actor.kind === "agent" ? invocation.actor : this.agentActor(),
          ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
          causality: { invocationId: invocation.invocationId },
          payload: {
            protocol: "agentic.trajectory.v1",
            reason: "Runner restarted before invocation completed",
            recoverable: true,
          },
          createdAt: now,
        },
        publishToChannel: true,
      });
    }
    for (const turn of Object.values(this.restoredTrajectoryState.turns)) {
      if (turn.status !== "open") continue;
      repairs.push({
        event: {
          kind: "turn.closed",
          actor: turn.actor.kind === "agent" ? turn.actor : this.agentActor(),
          turnId: turn.turnId,
          payload: {
            protocol: "agentic.trajectory.v1",
            summary: "Runner restarted before turn closed",
            reason: "runner_restarted",
          },
          createdAt: now,
        },
        publishToChannel: true,
      });
    }
    if (repairs.length > 0) await this.appendTrajectoryEvents(repairs);
    this.restoredTrajectoryState = null;
  }

  private isTerminalInvocationStatus(status: string | undefined): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "abandoned";
  }

  private async handleMessageEnd(message: AgentMessage): Promise<void> {
    if (!this.session) return;
    const messageEntryId = await this.session.getLeafId();
    if (!messageEntryId) return;
    const role = this.messageRole(message);
    const messageId = role === "assistant" && this.activeAssistantMessage
      ? this.activeAssistantMessage.messageId
      : messageEntryId;
    this.queueMessageProvenance(message, messageEntryId, messageId);
    if (role === "assistant") this.activeAssistantMessage = null;
    await this.flushProvenance();
  }

  private async handleMessageStart(message: AgentMessage): Promise<void> {
    if (!this.options.gad || this.messageRole(message) !== "assistant") return;
    const content = this.messageText(message);
    const messageId = this.activeAssistantMessage?.messageId ?? uuidv7();
    this.activeAssistantMessage = { messageId, lastText: content, started: true };
    await this.appendTrajectoryEvents([
      {
        event: {
          kind: "message.started",
          actor: this.agentActor(),
          causality: { messageId: brandId<MessageId>(messageId) },
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            content,
            blocks: this.messageBlocksForTrajectory(this.messageBlocks(message)),
          },
          createdAt: this.messageTimestamp(message),
        },
        publishToChannel: this.shouldPublishMessageToChannel("assistant", content),
      },
    ]);
  }

  private async handleMessageUpdate(message: AgentMessage): Promise<void> {
    if (!this.options.gad || this.messageRole(message) !== "assistant") return;
    if (!this.activeAssistantMessage) {
      await this.handleMessageStart(message);
      return;
    }
    const content = this.messageText(message);
    const previous = this.activeAssistantMessage.lastText;
    const isAppendOnly = content.startsWith(previous);
    const delta = isAppendOnly ? content.slice(previous.length) : content;
    this.activeAssistantMessage.lastText = content;
    if (!delta) return;
    await this.appendTrajectoryEvents([
      {
        event: {
          kind: "message.delta",
          actor: this.agentActor(),
          causality: { messageId: brandId<MessageId>(this.activeAssistantMessage.messageId) },
          payload: {
            protocol: "agentic.trajectory.v1",
            delta,
            ...(isAppendOnly ? {} : { replace: true }),
          },
          createdAt: new Date().toISOString(),
        },
        publishToChannel: true,
      },
    ]);
  }

  private queueMessageProvenance(message: AgentMessage, messageEntryId: string, visibleMessageId = messageEntryId): void {
    const role = this.messageRole(message);
    const blocks = this.messageBlocks(message);
    const content = this.messageText(message);
    this.provenanceQueue.push({
      event: {
        kind: "message.completed",
        actor: this.actorForMessageRole(role),
        causality: { messageId: brandId<MessageId>(visibleMessageId) },
        payload: {
          protocol: "agentic.trajectory.v1",
          role,
          content,
          blocks: this.messageBlocksForTrajectory(blocks),
        },
        createdAt: this.messageTimestamp(message),
      },
      eventId: messageEntryId,
      publishToChannel: this.shouldPublishMessageToChannel(role, content),
    });

    for (const [blockIndex, block] of this.messageBlocks(message).entries()) {
      const toolCallId = this.toolCallIdFromBlock(block);
      if (toolCallId) {
        this.openInvocationIds.add(toolCallId);
        this.provenanceQueue.push({
          event: {
            kind: "invocation.started",
            actor: this.actorForMessageRole(role),
            causality: {
              messageId: brandId<MessageId>(visibleMessageId),
              invocationId: brandId<InvocationId>(toolCallId),
              modelToolCallId: toolCallId,
            },
            payload: {
              protocol: "agentic.trajectory.v1",
              name: this.toolNameFromBlock(block) ?? "unknown",
              invocationType: "tool",
              request: this.toolInputFromBlock(block) ?? this.asJsonRecord(block) ?? { blockIndex },
              transport: { kind: "local", awaiterId: toolCallId },
              userVisible: true,
            },
            createdAt: this.messageTimestamp(message),
          },
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
        this.provenanceQueue.push({
          event: {
            kind: (message as { isError?: boolean }).isError === true
              ? "invocation.failed"
              : "invocation.completed",
            actor: this.agentActor(),
            causality: {
              messageId: brandId<MessageId>(visibleMessageId),
              invocationId: brandId<InvocationId>(toolCallId),
              modelToolCallId: toolCallId,
            },
            payload: (message as { isError?: boolean }).isError === true
              ? {
                  protocol: "agentic.trajectory.v1",
                  reason: this.summarizeToolResult({
                    content: (message as { content?: unknown }).content ?? [],
                    details,
                  } as AgentToolResult<unknown>),
                  recoverable: true,
                }
              : {
                  protocol: "agentic.trajectory.v1",
                  result: {
                    toolCallId,
                    toolName: typeof toolName === "string" ? toolName : "unknown",
                    content: (message as { content?: unknown }).content ?? [],
                    details,
                  },
                  summary: this.summarizeToolResult({
                    content: (message as { content?: unknown }).content ?? [],
                    details,
                  } as AgentToolResult<unknown>),
                },
            createdAt: this.messageTimestamp(message),
          },
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
      if (outcome.requeued > 0 || !isPermanentProvenanceError(err)) {
        console.warn("[PiRunner] provenance flush failed:", err);
      }
    }
  }

  private async flushProvenanceIndividually(
    batch: TrajectoryQueueItem[],
    batchError: unknown
  ): Promise<{ dropped: number; requeued: number }> {
    if (!this.options.gad) return { dropped: 0, requeued: 0 };
    const retry: TrajectoryQueueItem[] = [];
    let dropped = 0;
    for (const item of batch) {
      try {
        await this.appendTrajectoryEvents([item]);
      } catch (err) {
        if (isPermanentProvenanceError(err)) {
          dropped += 1;
          console.warn("[PiRunner] dropping invalid provenance event:", {
            eventId: item.eventId,
            kind: item.event.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        retry.push(item);
      }
    }
    if (retry.length > 0 || !isPermanentProvenanceError(batchError)) {
      this.provenanceQueue = retry.concat(this.provenanceQueue);
    }
    return { dropped, requeued: retry.length };
  }

  private async appendTrajectoryEvents(items: TrajectoryQueueItem[]): Promise<void> {
    if (items.length === 0 || !this.options.gad) return;
    const result = await this.gad.call<AppendTrajectoryBatchResultLike>("appendTrajectoryBatch", {
      trajectoryId: this.gadTrajectoryId(),
      branchId: this.options.gad.branchId,
      owner: this.agentActor(),
        events: items.map((item) => ({
          event: this.withCurrentTurnId(item.event),
          ...(item.eventId ? { eventId: item.eventId } : {}),
        ...(this.options.gad?.channelId && item.publishToChannel === true
          ? { publish: { channelIds: [this.options.gad.channelId] } }
          : {}),
      })),
    });
    await this.broadcastPublishedChannelEnvelopes(result?.published ?? []);
  }

  private async broadcastPublishedChannelEnvelopes(publications: PublishedChannelEnvelope[]): Promise<void> {
    if (publications.length === 0) return;
    const byChannel = new Map<string, string[]>();
    for (const publication of publications) {
      if (!publication.channelId || !publication.envelopeId) continue;
      const existing = byChannel.get(publication.channelId) ?? [];
      existing.push(publication.envelopeId);
      byChannel.set(publication.channelId, existing);
    }
    await Promise.all(Array.from(byChannel, async ([channelId, envelopeIds]) => {
      try {
        const target = await this.resolveChannelTarget(channelId);
        await this.options.rpc.call(target, "broadcastStoredEnvelopes", [envelopeIds]);
      } catch (err) {
        console.warn("[PiRunner] channel publication broadcast failed:", {
          channelId,
          envelopeIds,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }));
  }

  private async resolveChannelTarget(channelId: string): Promise<string> {
    let promise = this.channelTargetPromises.get(channelId);
    if (!promise) {
      promise = this.options.rpc
        .call<ResolvedServiceLike>("main", "workers.resolveService", ["natstack.channel.v1", channelId])
        .then((service) => {
          if (service.kind !== "durable-object" || !service.targetId) {
            throw new Error(`Channel service for ${channelId} did not resolve to a Durable Object`);
          }
          return service.targetId;
        });
      this.channelTargetPromises.set(channelId, promise);
    }
    return promise;
  }

  private withCurrentTurnId(event: AgenticEvent): AgenticEvent {
    if (
      event.turnId ||
      event.actor.kind !== "agent" ||
      !TURN_SCOPED_OWNER_KINDS.includes(event.kind as typeof TURN_SCOPED_OWNER_KINDS[number])
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
      const blob = await this.putGadBlob(raw);
      return blob ?? null;
    } catch {
      return null;
    }
  }

  private async putGadBlob(value: string | Uint8Array | Buffer): Promise<GadBlobSnapshot | null> {
    try {
      if (typeof value === "string") {
        return await this.options.rpc.call<GadBlobSnapshot>("main", "blobstore.putText", [value]);
      }
      return await this.options.rpc.call<GadBlobSnapshot>(
        "main",
        "blobstore.putBase64",
        [Buffer.from(value).toString("base64")]
      );
    } catch (err) {
      console.warn("[PiRunner] blobstore put failed:", err);
      return null;
    }
  }

  private async surfaceOrphanMutationIntents(): Promise<void> {
    if (!this.options.gad) return;
    let intents: Array<{ event_id: string; payload_json: string }> = [];
    let observed: Array<{ payload_json: string }> = [];
    try {
      const intentResult = await this.gad.call<{
        rows: Array<{ event_id: string; payload_json: string }>;
      }>(
        "query",
        "SELECT event_id, payload_json FROM trajectory_events WHERE branch_id = ? AND kind = 'state.file_mutation_intended'",
        [this.options.gad.branchId]
      );
      const observedResult = await this.gad.call<{ rows: Array<{ payload_json: string }> }>(
        "query",
        "SELECT payload_json FROM trajectory_events WHERE branch_id = ? AND kind = 'state.file_mutation_applied'",
        [this.options.gad.branchId]
      );
      intents = intentResult.rows;
      observed = observedResult.rows;
    } catch (err) {
      console.warn("[PiRunner] orphan-intent scan failed:", err);
      return;
    }

    const observedParents = new Set(
      observed
        .map((o) => {
          try {
            const payload = JSON.parse(o.payload_json) as { mutationId?: unknown };
            return typeof payload.mutationId === "string" ? payload.mutationId : null;
          } catch {
            return null;
          }
        })
        .filter((id): id is string => typeof id === "string")
    );
    const orphans = intents.filter((intent) => !observedParents.has(intent.event_id));
    for (const orphan of orphans) {
      const payload = JSON.parse(orphan.payload_json) as { path?: string };
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

  private agentActor(opts?: { idSuffix?: string; displayNameSuffix?: string }): AgenticEvent["actor"] {
    const base = this.options.agentActor ?? { kind: "agent" as const, id: "pi", displayName: "AI Agent" };
    return {
      ...base,
      id: `${base.id}${opts?.idSuffix ?? ""}`,
      ...(base.displayName || opts?.displayNameSuffix
        ? { displayName: `${base.displayName ?? base.id}${opts?.displayNameSuffix ?? ""}` }
        : {}),
    };
  }

  private shouldPublishMessageToChannel(role: MessageRole, content: string): boolean {
    if (!content.trim()) return false;
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

  private messageText(message: AgentMessage): string {
    return this.messageBlocks(message)
      .map((block) => {
        if (this.classifyBlock(block) !== "text") return "";
        if (!block || typeof block !== "object") return String(block);
        const item = block as Record<string, unknown>;
        if (typeof item["text"] === "string") return item["text"];
        if (typeof item["content"] === "string") return item["content"];
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private messageBlocksForTrajectory(blocks: unknown[]): MessageBlockInput[] {
    return blocks.map((block) => {
      const type = this.classifyBlock(block);
      const toolCallId = this.toolCallIdFromBlock(block);
      const record = this.asJsonRecord(block);
      if (type === "invocation" && toolCallId) {
        return {
          type: "invocation",
          invocationId: brandId<InvocationId>(toolCallId),
          metadata: record ?? undefined,
        };
      }
      if (type === "thinking") {
        return {
          type: "thinking",
          content: typeof record?.["thinking"] === "string" ? record["thinking"] : undefined,
          metadata: record ?? undefined,
        };
      }
      return {
        type: "text",
        content: typeof record?.["text"] === "string"
          ? record["text"]
          : typeof block === "string"
            ? block
            : undefined,
        metadata: record ?? undefined,
      };
    });
  }

  private classifyBlock(block: unknown): "text" | "thinking" | "invocation" {
    if (!block || typeof block !== "object") return "text";
    const type = (block as { type?: unknown }).type;
    if (type === "thinking") return "thinking";
    const camelToolBlockType = "tool" + "Call";
    if (type === camelToolBlockType || type === "tool_call") return "invocation";
    return "text";
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

  async prompt(input: RunnerTurnInput): Promise<void> {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    await this.refreshRuntimeTools();
    await this.harness.prompt(input.content, input.images ? { images: input.images } : undefined);
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
    harness.steerQueue.push(message);
    await harness.emitQueueUpdate();
  }

  async clearSteeringQueue(): Promise<void> {
    if (!this.harness) return;
    const harness = this.harness as unknown as AgentHarnessQueueAccess;
    if (harness.steerQueue.length === 0) return;
    harness.steerQueue.splice(0);
    await harness.emitQueueUpdate();
  }

  async continueAgent(): Promise<void> {
    if (!this.harness) throw new AgentWorkerError("invalid_state", "PiRunner not initialized");
    await this.refreshRuntimeTools();
    await this.harness.continue();
  }

  async abort(): Promise<{ clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[] }> {
    if (!this.harness) return { clearedSteer: [], clearedFollowUp: [] };
    return this.harness.abort();
  }

  async interrupt(): Promise<void> {
    await this.abort();
    await this.abandonOpenInvocations("User interrupted execution");
  }

  private async abandonOpenInvocations(reason: string): Promise<void> {
    if (this.openInvocationIds.size === 0) return;
    const now = new Date().toISOString();
    const items = [...this.openInvocationIds].map((toolCallId): TrajectoryQueueItem => ({
      event: {
        kind: "invocation.abandoned",
        actor: this.agentActor(),
        causality: {
          invocationId: brandId<InvocationId>(toolCallId),
          modelToolCallId: toolCallId,
        },
        payload: {
          protocol: "agentic.trajectory.v1",
          reason,
          recoverable: true,
        },
        createdAt: now,
      },
      publishToChannel: true,
    }));
    this.openInvocationIds.clear();
    await this.appendTrajectoryEvents(items);
  }

  markToolCallPreApproved(toolCallId: string): void {
    this.preApprovedCallIds.add(toolCallId);
  }

  async executeToolDirect(
    toolName: string,
    toolCallId: string,
    params: unknown
  ): Promise<AgentToolResult<any>> {
    this.markToolCallPreApproved(toolCallId);
    const tool = this.computeActiveTools().find((candidate) => candidate.name === toolName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool "${toolName}" not available at resume time` }],
        details: { __natstack_tool_missing: true },
      };
    }

    try {
      const result = await tool.execute(
        toolCallId,
        params as never,
        new AbortController().signal,
        undefined
      );
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
    const content = Array.isArray(last.content) ? last.content : [];
    const hasVisibleContent = content.some((block) => {
      if (!block || typeof block !== "object") return true;
      if ((block as { type?: string }).type === "text") {
        return Boolean((block as { text?: string }).text);
      }
      if ((block as { type?: string }).type === "thinking") {
        return Boolean((block as { thinking?: string }).thinking);
      }
      return true;
    });
    return hasVisibleContent ? messages : messages.slice(0, -1);
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
        const existing = await fs.readFile(abs).catch(() => "");
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
