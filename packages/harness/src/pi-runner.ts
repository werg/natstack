/**
 * PiRunner — In-process Pi `AgentSession` wrapper for the agent worker DO.
 *
 * Replaces the entire harness child-process layer. The worker DO instantiates
 * one PiRunner per chat lifetime, runs Pi in-process, and forwards Pi events
 * to the channel as ephemeral messages (state snapshots + text deltas).
 *
 * Key choices:
 * - **Hermetic sandbox**: noExtensions/noSkills/noPromptTemplates/noThemes
 *   are all true; only `additionalSkillPaths` and `extensionFactories` are
 *   used. Pi never auto-discovers anything from `~/.pi/agent/` or
 *   `<cwd>/.pi/extensions/`. AGENTS.md and settings.json still load via
 *   Pi's normal cwd-walk for context files.
 * - **Auth via setRuntimeApiKey**: NatStack-supplied keys are priority #1
 *   in Pi's auth resolution chain.
 * - **`createCodingTools(cwd)` factory**: built-in tools resolve paths
 *   relative to the contextFolder, not `process.cwd()`.
 * - **Closure-bound extensions**: approval gate, channel tools, and ask-user
 *   are factory functions that capture the worker's callbacks. They are not
 *   Pi-package-portable and never will be.
 */

import { join } from "path";
import {
  AuthStorage,
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  createCodingTools,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, Api } from "@mariozechner/pi-ai";
import {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
} from "./extensions/approval-gate.js";
import {
  createChannelToolsExtension,
  type ChannelToolMethod,
} from "./extensions/channel-tools.js";
import {
  createAskUserExtension,
  type AskUserParams,
} from "./extensions/ask-user.js";
import {
  NatStackExtensionUIContext,
  type NatStackUIBridgeCallbacks,
} from "./natstack-extension-context.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Built-in Pi tool names that are always active alongside roster tools. */
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export interface PiRunnerOptions {
  /** Working directory: the contextFolder root, includes .pi/. */
  contextFolderPath: string;
  /** Pi config sandbox dir (e.g. <NATSTACK_APP_ROOT>/.natstack-pi-agent). */
  piAgentDir: string;
  /** API keys bridged via setRuntimeApiKey at session creation. Provider id → key. */
  apiKeys: Record<string, string>;
  /** Bridge for Pi extension UI primitives (select, confirm, notify, etc.). */
  uiCallbacks: NatStackUIBridgeCallbacks;
  /** Returns the current channel roster's tool list. Lazily read on every reconcile. */
  rosterCallback: () => ChannelToolMethod[];
  /** Execute a method on a channel participant, resolved by handle. */
  callMethodCallback: (
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<unknown>;
  /** Bridge for the ask_user extension. */
  askUserCallback: (
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ) => Promise<string>;
  /** Resume from this JSONL file path; omit for a new session. */
  resumeSessionFile?: string;
  /** Pi Model object — the worker resolves "provider:model" via @natstack/shared/ai/resolve-model.ts before constructing the runner. */
  model: Model<Api>;
  /** Default thinking level for new sessions. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Initial approval level. The worker can mutate `runner.approvalLevel`
   * at any time and the approval-gate extension will read the new value
   * on the next tool_call.
   */
  approvalLevel: ApprovalLevel;
}

/** Snapshot of Pi state forwarded as a `natstack-state-snapshot` ephemeral. */
export interface PiStateSnapshot {
  messages: AgentMessage[];
  isStreaming: boolean;
}

export class PiRunner {
  private session: AgentSession | null = null;
  private listeners: Array<(event: AgentSessionEvent) => void> = [];
  private _approvalLevel: ApprovalLevel;
  private _modelFallbackMessage: string | undefined;

  constructor(private readonly options: PiRunnerOptions) {
    this._approvalLevel = options.approvalLevel;
  }

  /**
   * Initialize Pi: build auth, resolve model, build hermetic resource loader,
   * create the agent session, bind the UI context, and subscribe to events.
   */
  async init(): Promise<void> {
    // 1. Auth — runtime overrides take priority over file-based auth.
    const authStorage = AuthStorage.create();
    for (const [provider, key] of Object.entries(this.options.apiKeys)) {
      if (key) authStorage.setRuntimeApiKey(provider, key);
    }

    // 2. Use the pre-resolved model from the worker.
    const model = this.options.model;

    // 3. SessionManager: resume an existing JSONL or create a new one.
    const sessionManager = this.options.resumeSessionFile
      ? SessionManager.open(this.options.resumeSessionFile)
      : SessionManager.create(this.options.contextFolderPath);

    // 4. Hermetic resource loader. Disable Pi's auto-discovery, opt back in
    //    only to the workspace skills directory and the inline NatStack
    //    extension factories.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.contextFolderPath,
      agentDir: this.options.piAgentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [
        join(this.options.contextFolderPath, ".pi/skills"),
      ],
      extensionFactories: [
        createApprovalGateExtension({
          getApprovalLevel: () => this._approvalLevel,
          safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
        }),
        createChannelToolsExtension({
          getRoster: this.options.rosterCallback,
          callMethod: this.options.callMethodCallback,
          builtinToolNames: BUILTIN_TOOL_NAMES,
        }),
        createAskUserExtension({
          askUser: this.options.askUserCallback,
        }),
      ],
    });
    await resourceLoader.reload();

    // 5. Create the AgentSession. Built-in coding tools must be created with
    //    the explicit cwd factory or they'll fall back to process.cwd().
    const result = await createAgentSession({
      cwd: this.options.contextFolderPath,
      agentDir: this.options.piAgentDir,
      model,
      thinkingLevel: this.options.thinkingLevel ?? "medium",
      tools: createCodingTools(this.options.contextFolderPath),
      authStorage,
      sessionManager,
      resourceLoader,
    });

    this.session = result.session;
    this._modelFallbackMessage = result.modelFallbackMessage;

    // 6. Bind the UI context so extensions can call ctx.ui.confirm/select/...
    const uiContext = new NatStackExtensionUIContext(this.options.uiCallbacks);
    await this.session.bindExtensions({ uiContext });

    // 7. Subscribe to the session's event stream and fan out to listeners.
    this.session.subscribe((event) => this.notifyListeners(event));
  }

  /** Subscribe to Pi events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[PiRunner] listener threw:", err);
      }
    }
  }

  /** Send a user message to start (or continue) a turn. */
  async runTurn(content: string, images?: ImageContent[]): Promise<void> {
    const session = this.requireSession();
    await session.prompt(content, images ? { images } : undefined);
  }

  /**
   * Steer the agent mid-stream with a follow-up message. Use when the user
   * sends a message while the agent is already streaming.
   */
  async steer(content: string, images?: ImageContent[]): Promise<void> {
    const session = this.requireSession();
    await session.steer(content, images);
  }

  /** Abort the current operation. */
  async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Fork the session at a given entry id. Pi's `fork` calls
   * `sessionManager.createBranchedSession` internally and switches to the
   * new file. Returns the new session file path (or null if not persisted).
   */
  async fork(entryId: string): Promise<string | null> {
    const session = this.requireSession();
    const result = await session.fork(entryId);
    if (result.cancelled) return null;
    return session.sessionFile ?? null;
  }

  /** Snapshot of the session state for the snapshot ephemeral channel stream. */
  getStateSnapshot(): PiStateSnapshot {
    const session = this.requireSession();
    return {
      messages: [...session.state.messages],
      isStreaming: session.isStreaming,
    };
  }

  /** Fallback message surfaced if the resumed session was created with a now-unavailable model. */
  get modelFallbackMessage(): string | undefined {
    return this._modelFallbackMessage;
  }

  /**
   * Update the approval level. The approval-gate extension reads this lazily
   * via closure, so changes are visible on the next tool_call without a
   * session reload.
   */
  setApprovalLevel(level: ApprovalLevel): void {
    this._approvalLevel = level;
  }

  get approvalLevel(): ApprovalLevel {
    return this._approvalLevel;
  }

  get sessionFile(): string | undefined {
    return this.session?.sessionFile;
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Whether Pi is currently streaming a response. */
  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  /** Tear down the session. Idempotent. */
  dispose(): void {
    this.session?.dispose();
    this.session = null;
    this.listeners.length = 0;
  }

  private requireSession(): AgentSession {
    if (!this.session) {
      throw new Error("PiRunner not initialized — call init() before use");
    }
    return this.session;
  }
}
