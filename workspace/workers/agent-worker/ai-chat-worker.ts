import {
  AgentWorkerBase,
  type ModelCredentialSetupProps,
  type ModelCredentialSummary,
} from "@workspace/agentic-do";
import type { ApprovalLevel, ThinkingLevel } from "@natstack/harness";
import type { ParticipantDescriptor } from "@natstack/harness/types";
import {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";

type ChatAgentConfig = {
  handle?: string;
  name?: string;
  systemPrompt?: string;
  systemPromptMode?: "replace" | "append";
  respondPolicy?: "all" | "mentioned" | "mentioned-strict" | "from-participants";
  respondFrom?: string[];
};

function asChatAgentConfig(config: unknown): ChatAgentConfig {
  return config && typeof config === "object" ? (config as ChatAgentConfig) : {};
}

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Pi-native: embeds `@earendil-works/pi-agent-core`'s `Agent` in-process via
 * the `PiRunner` harness (see `AgentWorkerBase`). The system prompt is
 * loaded from `meta/AGENTS.md` via the workspace.* RPC service;
 * skill metadata is merged in from each skill's SKILL.md.
 *
 * The model, thinking level, and approval level can be customized via the
 * `getModel`/`getThinkingLevel`/`getApprovalLevel` overridable hooks. The
 * default is `openai-codex:gpt-5.5` at "medium" thinking with full-auto
 * approval. Model credentials are URL-bound and injected by the host egress
 * path after user approval.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  /** Default to OpenAI Codex / gpt-5.5. The worker owns provider-specific
   *  credential setup; host egress injects the resulting URL-bound credential. */
  protected override getDefaultModel(): string {
    return DEFAULT_MODEL;
  }

  protected override getDefaultThinkingLevel(): ThinkingLevel {
    return DEFAULT_THINKING_LEVEL;
  }

  protected override getDefaultApprovalLevel(): ApprovalLevel {
    return DEFAULT_APPROVAL_LEVEL;
  }

  protected override getDefaultRespondPolicy():
    | "all"
    | "mentioned"
    | "mentioned-strict"
    | "from-participants" {
    return DEFAULT_RESPOND_POLICY;
  }

  protected override getModelCredentialSetupProps(
    providerId: string
  ): ModelCredentialSetupProps | null {
    return PROVIDER_CREDENTIAL_SETUPS[providerId] ?? null;
  }

  protected override getModelCredentialTokenClaims(
    providerId: string,
    credential: ModelCredentialSummary
  ): Record<string, unknown> {
    if (providerId !== "openai-codex") {
      return {};
    }
    const accountId =
      credential.accountIdentity?.providerUserId ?? credential.metadata?.["accountId"];
    return accountId ? { [OPENAI_CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } } : {};
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = asChatAgentConfig(config);
    return {
      handle: cfg.handle ?? "ai-chat",
      name: cfg.name ?? "AI Chat",
      type: "agent",
      metadata: {},
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
        { name: "credentialConnected", description: "Resume after model credential connection" },
        {
          name: "connectModelCredential",
          description: "Connect a model credential for the current provider",
        },
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
          name: "getAgentSettings",
          description: "Read effective model, effort, approval, and chattiness settings",
        },
        { name: "getDebugState", description: "Read agent DO persisted and in-memory debug state" },
      ],
    };
  }

  override async onMethodCall(
    channelId: string,
    _callId: string,
    methodName: string,
    _args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    const modelCredentialResult = await this.handleModelCredentialMethodCall(
      channelId,
      methodName,
      _args
    );
    if (modelCredentialResult) return modelCredentialResult;

    switch (methodName) {
      case "pause":
        await this.interruptRunner(channelId);
        return { result: { paused: true } };
      case "resume":
        // No-op: the next user message resumes the conversation naturally.
        return { result: { resumed: true } };
      case "credentialConnected":
        return {
          result: {
            resumed: await this.resumeAfterModelCredentialConnected(
              channelId,
              _args as { providerId?: string; modelBaseUrl?: string }
            ),
          },
        };
      case "setThinkingLevel": {
        const level = (_args as { level?: unknown } | null)?.level;
        if (level !== "minimal" && level !== "low" && level !== "medium" && level !== "high") {
          return {
            result: { error: "setThinkingLevel requires level: minimal, low, medium, or high" },
            isError: true,
          };
        }
        this.setThinkingLevel(channelId, level);
        return { result: this.getAgentSettings(channelId) };
      }
      case "setApprovalLevel": {
        const level = (_args as { level?: unknown } | null)?.level;
        if (level !== 0 && level !== 1 && level !== 2) {
          return {
            result: { error: "setApprovalLevel requires level: 0, 1, or 2" },
            isError: true,
          };
        }
        this.setApprovalLevel(channelId, level);
        return { result: this.getAgentSettings(channelId) };
      }
      case "setRespondPolicy": {
        const args = _args as { policy?: unknown; from?: unknown } | null;
        const policy = args?.policy;
        if (
          policy !== "all" &&
          policy !== "mentioned" &&
          policy !== "mentioned-strict" &&
          policy !== "from-participants"
        ) {
          return {
            result: {
              error:
                "setRespondPolicy requires policy: all, mentioned, mentioned-strict, or from-participants",
            },
            isError: true,
          };
        }
        const from = Array.isArray(args?.from)
          ? args.from.filter((id): id is string => typeof id === "string")
          : undefined;
        this.setRespondPolicy(channelId, policy, from);
        return { result: this.getAgentSettings(channelId) };
      }
      case "getAgentSettings":
        return { result: this.getAgentSettings(channelId) };
      case "getDebugState":
        return { result: await this.getDebugState(channelId) };
      default:
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
    }
  }
}
