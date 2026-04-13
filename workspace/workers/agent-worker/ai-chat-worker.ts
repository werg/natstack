import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness/types";

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
 * default is `openai-codex:gpt-5` at "medium" thinking with full-auto
 * approval. OpenAI Codex uses the OAuth flow from the auth service, so no
 * API key is required.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 5;

  /** Default to OpenAI Codex / gpt-5.4 — the strongest non-codex variant in
   *  pi-ai 0.66's openai-codex registry. The auth service supplies an OAuth
   *  token at Agent call time via `auth.getProviderToken("openai-codex")`. */
  protected override getModel(): string {
    return "openai-codex:gpt-5.4";
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
      default:
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
    }
  }
}
