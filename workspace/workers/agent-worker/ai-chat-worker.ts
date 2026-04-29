import { AgentWorkerBase, type ModelCredentialSetupProps, type ModelCredentialSummary } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness/types";

const OPENAI_CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Pi-native: embeds `@mariozechner/pi-agent-core`'s `Agent` in-process via
 * the `PiRunner` harness (see `AgentWorkerBase`). The system prompt is
 * loaded from `meta/AGENTS.md` via the workspace.* RPC service;
 * skill metadata is merged in from each skill's SKILL.md.
 *
 * The model, thinking level, and approval level can be customized via the
 * `getModel`/`getThinkingLevel`/`getApprovalLevel` overridable hooks. The
 * default is `openai-codex:gpt-5.4` at "medium" thinking with full-auto
 * approval. Model credentials are URL-bound and injected by the host egress
 * path after user approval.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 5;

  /** Default to OpenAI Codex / gpt-5.4. The worker owns provider-specific
   *  credential setup; host egress injects the resulting URL-bound credential. */
  protected override getModel(): string {
    return "openai-codex:gpt-5.4";
  }

  protected override getModelCredentialSetupProps(providerId: string): ModelCredentialSetupProps | null {
    if (providerId !== "openai-codex") {
      return null;
    }
    return {
      credentialLabel: "ChatGPT Codex model credential",
      accountIdentityJwtClaimRoot: OPENAI_CODEX_ACCOUNT_CLAIM,
      accountIdentityJwtClaimField: "chatgpt_account_id",
      loopback: {
        host: "localhost",
        port: 1455,
        callbackPath: "/auth/callback",
      },
      oauth: {
        authorizeUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        scopes: ["openid", "profile", "email", "offline_access"],
        extraAuthorizeParams: {
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          originator: "codex_cli_rs",
        },
      },
    };
  }

  protected override getModelCredentialTokenClaims(
    providerId: string,
    credential: ModelCredentialSummary,
  ): Record<string, unknown> {
    if (providerId !== "openai-codex") {
      return {};
    }
    const accountId = credential.accountIdentity?.providerUserId ?? credential.metadata?.["accountId"];
    return accountId
      ? { [OPENAI_CODEX_ACCOUNT_CLAIM]: { chatgpt_account_id: accountId } }
      : {};
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "ai-chat",
      name: "AI Chat",
      type: "agent",
      metadata: {},
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
        { name: "credentialConnected", description: "Resume after model credential connection" },
      ],
    };
  }

  override async onMethodCall(
    channelId: string,
    _callId: string,
    methodName: string,
    _args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
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
            resumed: await this.resumeAfterModelCredentialConnected(channelId),
          },
        };
      default:
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
    }
  }
}
