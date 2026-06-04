/**
 * AgentWorkerBase — workspace-default channel agent DO base.
 *
 * The reusable channel-agent vessel lives in `TrajectoryVesselBase`.
 * This subclass preserves the public import path used by existing AiChat
 * agents while leaving room for concrete workers, such as Gmail, to extend
 * the vessel directly.
 */

import type { DurableObjectContext } from "@workspace/runtime/worker";
import type { ApprovalLevel, ThinkingLevel } from "@workspace/harness";
import type { ParticipantDescriptor } from "@workspace/harness";

import {
  TrajectoryVesselBase,
  type ModelCredentialSetupProps,
  type ModelCredentialSummary,
} from "./trajectory-vessel-base.js";
import {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";

export type { ModelCredentialSetupProps, ModelCredentialSummary };

type StandardAgentMethodName =
  | "pause"
  | "resume"
  | "credentialConnected"
  | "connectModelCredential"
  | "setThinkingLevel"
  | "setApprovalLevel"
  | "setRespondPolicy"
  | "getAgentSettings"
  | "getDebugState"
  | "inspectMethodSuspensions";

type StandardAgentMethodOptions = {
  include?: readonly StandardAgentMethodName[];
  exclude?: readonly StandardAgentMethodName[];
};

export abstract class AgentWorkerBase extends TrajectoryVesselBase {
  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

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
      {
        name: "inspectMethodSuspensions",
        description: "Compare local method suspensions with GAD invocation projection state",
      },
    ];
    const include = opts?.include ? new Set<string>(opts.include) : null;
    const exclude = opts?.exclude ? new Set<string>(opts.exclude) : null;
    return methods.filter(
      (method) => (!include || include.has(method.name)) && !exclude?.has(method.name)
    );
  }

  protected async handleStandardAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    const modelCredentialResult = await this.handleModelCredentialMethodCall(
      channelId,
      methodName,
      args
    );
    if (modelCredentialResult) return modelCredentialResult;

    switch (methodName) {
      case "pause":
        await this.interruptRunner(channelId);
        return { result: { paused: true } };
      case "resume":
        return { result: { resumed: true } };
      case "credentialConnected":
        return {
          result: {
            resumed: await this.resumeAfterModelCredentialConnected(
              channelId,
              args as { providerId?: string; modelBaseUrl?: string }
            ),
          },
        };
      case "setThinkingLevel": {
        const level = (args as { level?: unknown } | null)?.level;
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
        const level = (args as { level?: unknown } | null)?.level;
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
        const methodArgs = args as { policy?: unknown; from?: unknown } | null;
        const policy = methodArgs?.policy;
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
        const from = Array.isArray(methodArgs?.from)
          ? methodArgs.from.filter((id): id is string => typeof id === "string")
          : undefined;
        this.setRespondPolicy(channelId, policy, from);
        return { result: this.getAgentSettings(channelId) };
      }
      case "getAgentSettings":
        return { result: this.getAgentSettings(channelId) };
      case "getDebugState":
        return { result: await this.getDebugState(channelId) };
      case "inspectMethodSuspensions":
        return { result: await this.inspectMethodSuspensions(channelId) };
      default:
        return null;
    }
  }

  override async onMethodCall(
    channelId: string,
    _transportCallId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean }> {
    return (
      (await this.handleStandardAgentMethodCall(channelId, methodName, args)) ?? {
        result: { error: `unknown method: ${methodName}` },
        isError: true,
      }
    );
  }
}
