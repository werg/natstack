/**
 * AgentWorkerBase — workspace-default channel agent DO base.
 *
 * The reusable event-sourced vessel lives in `AgentVesselBase`; this subclass
 * binds the workspace defaults (model, credential presets) and the standard
 * agent method roster.
 */

import { createRpcFs, type DurableObjectContext } from "@workspace/runtime/worker";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  createCloseTurnWithoutResponseTool,
  createWebTools,
  createToolVcs,
  loadNatStackResources,
} from "@workspace/harness";
import type { AgentTool } from "@workspace/pi-core";
import type { ParticipantDescriptor } from "@workspace/harness";
import type { AgentTurnContextPolicy, ThinkingLevel } from "@workspace/agent-loop";
import { AgentVesselBase, type AgentPromptResources, type ApprovalLevel } from "./agent-vessel.js";
import {
  AgentHeartbeatLoop,
  type AgentHeartbeatLoopDeps,
} from "./agent-heartbeat-loop.js";
import {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";
import type { RespondPolicy } from "@workspace/agent-loop";

type StandardAgentMethodName =
  | "pause"
  | "resume"
  | "scheduleResumeAtReset"
  | "credentialConnected"
  | "connectModelCredential"
  | "setModel"
  | "setThinkingLevel"
  | "setApprovalLevel"
  | "setRespondPolicy"
  | "setModelStreamIdleTimeoutMs"
  | "refreshPromptArtifacts"
  | "getAgentSettings"
  | "getDebugState"
  | "inspectMethodSuspensions";

type StandardAgentMethodOptions = {
  include?: readonly StandardAgentMethodName[];
  exclude?: readonly StandardAgentMethodName[];
};

const PROMPT_RESOURCE_CACHE_TTL_MS = 5_000;
const DEFAULT_WORKSPACE_AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS = 90_000;

export abstract class AgentWorkerBase extends AgentVesselBase {
  private promptResourceCache:
    | { value: AgentPromptResources; expiresAt: number }
    | null = null;
  private promptResourceLoad: Promise<AgentPromptResources> | null = null;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  protected override getDefaultThinkingLevel(): ThinkingLevel {
    return DEFAULT_THINKING_LEVEL as ThinkingLevel;
  }

  protected override getDefaultApprovalLevel(): ApprovalLevel {
    return DEFAULT_APPROVAL_LEVEL as ApprovalLevel;
  }

  protected override getDefaultRespondPolicy(): RespondPolicy {
    return DEFAULT_RESPOND_POLICY as RespondPolicy;
  }

  protected override getDefaultModelStreamIdleTimeoutMs(): number | null {
    return DEFAULT_WORKSPACE_AGENT_MODEL_STREAM_IDLE_TIMEOUT_MS;
  }

  protected override getModelCredentialSetupProps(
    providerId: string
  ): Record<string, unknown> | null {
    return (PROVIDER_CREDENTIAL_SETUPS as Record<string, Record<string, unknown>>)[providerId] ??
      null;
  }

  protected override async loadPromptResources(_channelId: string): Promise<AgentPromptResources> {
    const now = Date.now();
    if (this.promptResourceCache && this.promptResourceCache.expiresAt > now) {
      return this.promptResourceCache.value;
    }
    if (this.promptResourceLoad) return this.promptResourceLoad;

    const load = loadNatStackResources({ rpc: this.rpc })
      .then((resources): AgentPromptResources => ({
        workspacePrompt: resources.systemPrompt,
        skillIndex: resources.skillIndex,
      }))
      .then((value) => {
        this.promptResourceCache = {
          value,
          expiresAt: Date.now() + PROMPT_RESOURCE_CACHE_TTL_MS,
        };
        return value;
      })
      .finally(() => {
        if (this.promptResourceLoad === load) this.promptResourceLoad = null;
      });
    this.promptResourceLoad = load;
    return load;
  }

  protected override invalidatePromptResources(_channelId?: string): void {
    this.promptResourceCache = null;
    this.promptResourceLoad = null;
  }

  protected createHeartbeatLoop(options: {
    namespace: string;
    defaultPromptText?: string;
    evaluate: AgentHeartbeatLoopDeps["evaluate"];
    channelId: () => string | null;
    registry?: {
      participantHandle?: () => string | null;
      enabled?: boolean;
    };
  }): AgentHeartbeatLoop {
    const sourceId = `heartbeat:${options.namespace.replace(/[^a-zA-Z0-9_]/gu, "_")}`;
    const loop = new AgentHeartbeatLoop({
      sql: this.sql,
      namespace: options.namespace,
      defaultPromptText: options.defaultPromptText,
      evaluate: options.evaluate,
      scheduleWakeAt: (id, timeMs) => this.scheduleAgentAlarm(id, timeMs),
      clearWake: (id) => this.clearAgentAlarm(id),
      isTurnInFlight: () => {
        const channelId = options.channelId();
        return channelId ? this.driver.hasOpenTurn(channelId) : false;
      },
      enqueueTurn: async (turn) => {
        const channelId = options.channelId();
        if (!channelId) throw new Error(`heartbeat ${options.namespace} has no bound channel`);
        const content =
          turn.kind === "prompt"
            ? turn.promptText
            : (options.defaultPromptText ?? "Continue this heartbeat turn.");
        const contextPolicy = await this.resolveHeartbeatContextPolicy(turn.decision.contextPolicy);
        await this.submitAgentInitiatedTurn(
          channelId,
          { content },
          {
            mode: "sequential",
            steeringId: `${sourceId}:${turn.trigger.kind}:${Date.now()}`,
            origin: "heartbeat",
            delivery: turn.decision.delivery ?? "none",
            ...(turn.decision.ackToken ? { ackToken: turn.decision.ackToken } : {}),
            ...(turn.decision.silentOk !== undefined ? { silentOk: turn.decision.silentOk } : {}),
            ...(turn.decision.maxModelCalls !== undefined
              ? { loopConfigPatch: { maxModelCallsPerTurn: turn.decision.maxModelCalls } }
              : { loopConfigPatch: { maxModelCallsPerTurn: 1 } }),
            contextPolicy,
          }
        );
        if (options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    this.registerAgentAlarmSource({
      id: sourceId,
      nextWakeAt: () => loop.nextWakeAt(),
      fire: async (now) => {
        await loop.onAlarm(now);
        const channelId = options.channelId();
        if (channelId && options.registry?.enabled !== false) {
          await this.registerGenericHeartbeat(options.namespace, channelId, loop, options);
        }
      },
    });
    return loop;
  }

  private async registerGenericHeartbeat(
    namespace: string,
    channelId: string,
    loop: AgentHeartbeatLoop,
    options?: {
      registry?: {
        participantHandle?: () => string | null;
      };
    }
  ): Promise<void> {
    const state = loop.getState();
    const ref = this.identity.ref;
    await this.rpc
      .call("main", "workspace-state.heartbeatRegister", [
        {
          name: `${namespace}-${channelId}`,
          source: ref.source,
          className: ref.className,
          objectKey: ref.objectKey,
          channelId,
          participantHandle: options?.registry?.participantHandle?.() ?? null,
          kind: "code-owned",
          status: state.status,
          nextRunAt: state.nextRunAt,
          lastWakeAt: state.lastWakeAt || null,
          lastActionSummary: state.lastActionSummary || null,
          lastError: state.lastError || null,
          specHash: state.specHash || null,
          updatedAt: Date.now(),
        },
      ])
      .catch((err) => {
        console.warn("[AgentWorkerBase] heartbeat registry update failed:", err);
      });
  }

  private async resolveHeartbeatContextPolicy(
    decisionPolicy?: AgentTurnContextPolicy
  ): Promise<AgentTurnContextPolicy> {
    const contextPolicy: AgentTurnContextPolicy = {
      mode: "heartbeat",
      includeWorkspacePrompt: false,
      includeSkillIndex: false,
      tokenBudget: 12_000,
      ...decisionPolicy,
    };
    if (contextPolicy.promptFile) {
      try {
        const fs = createRpcFs(this.rpc as never);
        const path = contextPolicy.promptFile.startsWith("/")
          ? contextPolicy.promptFile
          : `/${contextPolicy.promptFile}`;
        const raw = await fs.readFile(path, "utf8");
        contextPolicy.promptFileContent = typeof raw === "string" ? raw : raw.toString("utf8");
      } catch (err) {
        console.warn(
          "[AgentWorkerBase] failed to read heartbeat promptFile:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    return contextPolicy;
  }

  /** The six workerd-clean file tools over the agent's context folder
   *  (fs RPC scopes paths to the caller's context). Without them, agents
   *  whose prompts say `read("skills/...")` can only flail. */
  protected override getLoopTools(_channelId: string): AgentTool[] {
    const fs = createRpcFs(this.rpc as never);
    const cwd = "/";
    // Reads come from the materialized working tree (fs RPC, scoped to the
    // caller's context); writes go through GAD's edit-first commit so the head
    // is authoritative and disk is its projection.
    const vcs = createToolVcs(<T>(method: string, methodArgs: unknown[]) =>
      this.rpc.call<T>("main", method, methodArgs)
    );
    return [
      createReadTool(cwd, fs),
      createLsTool(cwd, fs),
      createGrepTool(cwd, fs),
      createFindTool(cwd, fs),
      createEditTool(cwd, vcs),
      createWriteTool(cwd, vcs),
      createCloseTurnWithoutResponseTool(),
      this.createAskUserTool(),
      ...createWebTools({
        rpc: {
          call: (target, method, args) => this.rpc.call(target, method, args),
        },
        hasCredentialForOrigin: async (origin) => {
          try {
            const credential = await this.rpc.call<unknown>("main", "credentials.resolveCredential", [
              { url: origin },
            ]);
            return credential != null;
          } catch {
            return false;
          }
        },
      }),
    ] as unknown as AgentTool[];
  }

  private createAskUserTool(): AgentTool {
    return {
      name: "ask_user",
      label: "ask_user",
      description:
        "Ask the user a concise question and wait for their response. Use this only when the answer is needed to continue.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to show the user." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional short options; mutually exclusive unless multiSelect is true.",
          },
          allowFreeform: {
            type: "boolean",
            description:
              "Whether the user may type a custom answer. Defaults to true for option prompts; set false to require one of the options.",
          },
          multiSelect: {
            type: "boolean",
            description:
              "Whether multiple options may be selected. When true, the prompt shows checkboxes and an explicit submit button.",
          },
        },
        required: ["question"],
      } as never,
      execute: async () => {
        throw new Error("ask_user requires a channel user participant");
      },
    } as AgentTool;
  }

  protected override getModelCredentialTokenClaims(
    providerId: string,
    credential: import("@workspace/runtime/credentials").StoredCredentialSummary
  ): Record<string, unknown> {
    if (providerId !== "openai-codex") return {};
    const accountId =
      credential.accountIdentity?.providerUserId ?? credential.metadata?.["accountId"];
    return accountId ? { [OPENAI_CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } } : {};
  }

  protected getStandardAgentMethods(
    opts?: StandardAgentMethodOptions
  ): NonNullable<ParticipantDescriptor["methods"]> {
    const methods: NonNullable<ParticipantDescriptor["methods"]> = [
      { name: "pause", description: "Pause the current AI turn" },
      { name: "resume", description: "Resume after pause" },
      {
        name: "scheduleResumeAtReset",
        description: "Schedule a paused model turn to resume when its usage limit resets",
      },
      { name: "credentialConnected", description: "Resume after model credential connection" },
      {
        name: "connectModelCredential",
        description: "Connect a model credential for the current provider",
      },
      { name: "setModel", description: "Set the live model in provider:model format" },
      {
        name: "setThinkingLevel",
        description: "Set live effort level: minimal, low, medium, or high",
      },
      {
        name: "setApprovalLevel",
        description: "Set live approval level: 0=manual, 1=auto-safe, 2=full-auto",
      },
      {
        name: "setRespondPolicy",
        description: "Set live chattiness policy and optional participant allow-list",
      },
      {
        name: "setModelStreamIdleTimeoutMs",
        description: "Set model stream idle watchdog milliseconds, or null to disable",
      },
      {
        name: "refreshPromptArtifacts",
        description: "Reload workspace prompt resources and refresh model prompt/tool artifacts",
      },
      {
        name: "getAgentSettings",
        description: "Read effective model, effort, approval, chattiness, and stream watchdog settings",
      },
      { name: "getDebugState", description: "Read agent DO persisted and in-memory debug state" },
      {
        name: "inspectMethodSuspensions",
        description: "Inspect the pending effect outbox (dispatch cache over the log)",
      },
    ];
    const include = opts?.include ? new Set<string>(opts.include) : null;
    const exclude = opts?.exclude ? new Set<string>(opts.exclude) : null;
    return methods.filter(
      (method) => (!include || include.has(method.name)) && !exclude?.has(method.name)
    );
  }
}
