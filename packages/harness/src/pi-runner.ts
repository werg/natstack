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
  GadSessionStorage,
  type GadSessionMetadata,
  type TranscriptShapeError,
} from "./gad-session-storage.js";
import type { GadEventSpec, GadJsonRecord } from "./gad-types.js";
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
    onStreamUpdate?: StreamUpdateCallback
  ) => Promise<AgentToolResult<any>>;
  askUserCallback: (
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined
  ) => Promise<AgentToolResult<any> | string>;
  model: string;
  getApiKey: () => Promise<string>;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  systemPromptMode?: SystemPromptMode;
  approvalLevel: ApprovalLevel;
  cwd?: string;
  gad?: PiRunnerGadProvenance;
  sessionStorage?: GadSessionStorage;
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

export class PiRunner {
  private harness: AgentHarness | null = null;
  private extensionRuntime: PiExtensionRuntime | null = null;
  private builtinTools: AgentTool<any>[] = [];
  private harnessUnsub: (() => void) | null = null;
  private _approvalLevel: ApprovalLevel;
  private readonly preApprovedCallIds = new Set<string>();
  readonly hooks = new HookBus();
  private readonly compactionTrigger: CompactionTrigger;
  session: Session<GadSessionMetadata | SessionMetadata> | null = null;
  private storage: GadSessionStorage | null = null;
  private currentResources: NatStackResources | null = null;
  private resolvedModel: Model<any> | null = null;
  private provenanceQueue: GadEventSpec[] = [];
  private readonly pendingMutations = new Map<string, PendingMutation>();
  private readonly gad: DurableObjectServiceClient;
  private running = false;

  constructor(private readonly options: PiRunnerOptions) {
    this._approvalLevel = options.approvalLevel;
    this.compactionTrigger = new CompactionTrigger(options.compactionPolicy);
    this.gad = createGadServiceClient(options.rpc);
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
        callMethod: this.options.callMethodCallback,
        builtinToolNames: [...BUILTIN_TOOL_NAMES],
      }),
      createAskUserExtension({
        askUser: this.options.askUserCallback,
      }),
      createWebToolsExtension({
        rpc: this.options.rpc,
        hasCredentialForOrigin: this.options.hasCredentialForOrigin,
        fetcher: this.options.fetcher,
      }),
    ]);

    this.builtinTools = [
      createReadTool(cwd, this.options.fs, { rpc: this.options.rpc }),
      createEditTool(cwd, this.options.fs),
      createWriteTool(cwd, this.options.fs),
      createGrepTool(cwd, this.options.fs),
      createFindTool(cwd, this.options.fs),
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
  }

  private async createSession(): Promise<Session<GadSessionMetadata | SessionMetadata>> {
    if (this.options.sessionStorage) {
      this.storage = this.options.sessionStorage;
      return new Session(this.storage);
    }
    if (this.options.gad) {
      this.storage = this.buildSessionStorage();
      return new Session(this.storage);
    }
    this.storage = null;
    const repo = new InMemorySessionRepo();
    return repo.create({ id: "natstack-memory-session" });
  }

  private buildSessionStorage(): GadSessionStorage {
    const gad = this.options.gad!;
    return new GadSessionStorage({
      rpc: this.options.rpc,
      branchId: gad.branchId,
      workspaceId: gad.workspaceId ?? null,
      channelId: gad.channelId ?? null,
      contextId: gad.contextId ?? null,
      onTranscriptShapeError: (err) => this.handleTranscriptShapeError(err),
    });
  }

  private handleTranscriptShapeError(err: TranscriptShapeError): void {
    console.error("[PiRunner] transcript shape error:", err);
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
    const result = await this.extensionRuntime!.dispatch("tool_call", {
      type: "tool_call",
      toolCallId,
      toolName,
      input,
    });
    return result ?? undefined;
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
    if (event.type === "agent_start") this.running = true;
    if (event.type === "message_end") {
      await this.handleMessageEnd(event.message);
    }
    if (event.type === "agent_end") this.running = false;
    await this.hooks.emitEvent(event);
  }

  private async handleMessageEnd(message: AgentMessage): Promise<void> {
    if (!this.session) return;
    const messageEntryId = await this.session.getLeafId();
    if (!messageEntryId) return;
    this.queueMessageProvenance(message, messageEntryId);
    await this.flushProvenance();
  }

  private queueMessageProvenance(message: AgentMessage, messageEntryId: string): void {
    const role = (message as { role?: string }).role;
    for (const [blockIndex, block] of this.messageBlocks(message).entries()) {
      const toolCallId = this.toolCallIdFromBlock(block);
      if (toolCallId) {
        this.provenanceQueue.push({
          eventId: uuidv7(),
          kind: "dispatch_pending",
          anchorKind: "tool_call",
          anchorId: toolCallId,
          payload: {
            toolCallId,
            dispatchCallId: toolCallId,
            dispatchKind: "model-tool-call",
            methodName: this.toolNameFromBlock(block) ?? "unknown",
            blockIndex,
          },
          metadata: { messageEntryId, role: role ?? "unknown" },
        });
      }
    }

    if (role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      const toolName = (message as { toolName?: unknown }).toolName;
      const details = (message as { details?: unknown }).details;
      if (typeof toolCallId === "string" && toolCallId.length > 0) {
        this.provenanceQueue.push({
          eventId: uuidv7(),
          kind: "dispatch_resolved",
          anchorKind: "tool_call",
          anchorId: toolCallId,
          payload: {
            toolCallId,
            dispatchCallId: toolCallId,
            resultEntryId: messageEntryId,
            isError: (message as { isError?: boolean }).isError === true,
            toolName: typeof toolName === "string" ? toolName : "unknown",
            summary: this.summarizeToolResult({
              content: (message as { content?: unknown }).content ?? [],
              details,
            } as AgentToolResult<unknown>),
          },
        });
      }
    }
  }

  private async flushProvenance(): Promise<void> {
    if (!this.storage || this.provenanceQueue.length === 0) return;
    const batch = this.provenanceQueue;
    this.provenanceQueue = [];
    try {
      await this.storage.appendBatch(batch);
    } catch (err) {
      const outcome = await this.flushProvenanceIndividually(batch, err);
      if (outcome.requeued > 0 || !isPermanentProvenanceError(err)) {
        console.warn("[PiRunner] provenance flush failed:", err);
      }
    }
  }

  private async flushProvenanceIndividually(
    batch: GadEventSpec[],
    batchError: unknown
  ): Promise<{ dropped: number; requeued: number }> {
    if (!this.storage) return { dropped: 0, requeued: 0 };
    const retry: GadEventSpec[] = [];
    let dropped = 0;
    for (const event of batch) {
      try {
        await this.storage.appendBatch([event]);
      } catch (err) {
        if (isPermanentProvenanceError(err)) {
          dropped += 1;
          console.warn("[PiRunner] dropping invalid provenance event:", {
            eventId: event.eventId,
            kind: event.kind,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        retry.push(event);
      }
    }
    if (retry.length > 0 || !isPermanentProvenanceError(batchError)) {
      this.provenanceQueue = retry.concat(this.provenanceQueue);
    }
    return { dropped, requeued: retry.length };
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
    if (!this.storage || !this.options.gad) return;
    const absPath = this.toolInputPath(toolName, params);
    if (!absPath) return;
    const relativePathString = this.gadPathFromAbsolute(absPath);
    if (!relativePathString) return;

    const before = await this.snapshotMutationTarget(absPath);
    const intentEntryId = uuidv7();
    const intent: GadEventSpec = {
      eventId: intentEntryId,
      kind: "file_mutation_planned",
      anchorKind: "tool_call",
      anchorId: toolCallId,
      payload: {
        mutationId: intentEntryId,
        path: relativePathString,
        beforeHash: before?.digest ?? null,
        beforeSize: before?.size ?? null,
        toolCallId,
        operation: toolName,
        plannedTool: toolName,
        plannedParams: this.asJsonRecord(params) ?? {},
      },
      metadata: { parentEntryId: await this.currentLeafEntryId() },
    };

    await this.storage.appendBatch([intent]);
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
    this.provenanceQueue.push({
      eventId: uuidv7(),
      kind: "file_mutation_observed",
      anchorKind: "tool_call",
      anchorId: toolCallId,
      payload: {
        mutationId: pending.intentEntryId,
        path: pending.path,
        afterHash: after?.digest ?? null,
        afterSize: after?.size ?? null,
        outcome,
        toolCallId,
        operation: pending.toolName,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
  }

  private async recordReadOrObservation(
    toolCallId: string,
    toolName: string,
    params: unknown,
    result: AgentToolResult<any>
  ): Promise<void> {
    if (!this.storage || !this.options.gad) return;
    const absPath = this.toolInputPath(toolName, params);
    const path = this.gadPathFromAbsolute(absPath);
    if (!path) return;

    const text = this.toolResultText(result);
    const blob = await this.putGadBlob(text);
    if (!blob) return;

    const parentEntryId = await this.currentLeafEntryId();
    if (toolName === "read") {
      this.provenanceQueue.push({
        eventId: uuidv7(),
        kind: "file_observation_recorded",
        anchorKind: "tool_call",
        anchorId: toolCallId,
        payload: {
          path,
          contentHash: blob.digest,
          size: blob.size,
          toolName,
          toolCallId,
          observedStateHash: undefined,
        },
        metadata: { parentEntryId },
      });
    }
    this.provenanceQueue.push({
      eventId: uuidv7(),
      kind: "file_observation_recorded",
      anchorKind: "tool_call",
      anchorId: toolCallId,
      payload: {
        path,
        contentHash: blob.digest,
        size: blob.size,
        readType: toolName === "read" ? "file" : toolName,
        summary: this.summarizeToolResult(result),
        toolCallId,
      },
      metadata: {
        parentEntryId,
        toolName,
        parameters: this.asJsonRecord(params),
        toolCallId,
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
        return await this.options.rpc.call<GadBlobSnapshot>("main", "blobstore.putText", value);
      }
      return await this.options.rpc.call<GadBlobSnapshot>(
        "main",
        "blobstore.putBase64",
        Buffer.from(value).toString("base64")
      );
    } catch (err) {
      console.warn("[PiRunner] blobstore put failed:", err);
      return null;
    }
  }

  private async surfaceOrphanMutationIntents(): Promise<void> {
    if (!this.storage || !this.options.gad) return;
    let intents: Array<{ event_id: string; payload_json: string }> = [];
    let observed: Array<{ payload_json: string }> = [];
    try {
      const intentResult = await this.gad.call<{
        rows: Array<{ event_id: string; payload_json: string }>;
      }>(
        "query",
        "SELECT event_id, payload_json FROM gad_events WHERE kind = 'file_mutation_planned'",
        []
      );
      const observedResult = await this.gad.call<{ rows: Array<{ payload_json: string }> }>(
        "query",
        "SELECT payload_json FROM gad_events WHERE kind = 'file_mutation_observed'",
        []
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
      await this.storage.appendBatch([
        {
          eventId: uuidv7(),
          kind: "system_event",
          anchorKind: "system",
          anchorId: orphan.event_id,
          payload: {
            kind: event.kind,
            intentEntryId: event.intentEntryId,
            path,
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

  private classifyBlock(block: unknown): "text" | "thinking" | "toolCall" {
    if (!block || typeof block !== "object") return "text";
    const type = (block as { type?: unknown }).type;
    if (type === "thinking") return "thinking";
    if (type === "toolCall" || type === "tool_call") return "toolCall";
    return "text";
  }

  private toolCallIdFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    if (typeof item["id"] === "string") return item["id"];
    if (typeof item["toolCallId"] === "string") return item["toolCallId"];
    return null;
  }

  private toolNameFromBlock(block: unknown): string | null {
    if (!block || typeof block !== "object") return null;
    const item = block as Record<string, unknown>;
    if (typeof item["name"] === "string") return item["name"];
    if (typeof item["toolName"] === "string") return item["toolName"];
    return null;
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
