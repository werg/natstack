import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness/types";

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Pi-native: embeds `@mariozechner/pi-coding-agent` in-process via PiRunner
 * (see `AgentWorkerBase`). The system prompt lives in
 * `<contextFolder>/.pi/AGENTS.md` (loaded automatically by Pi). Workspace
 * skills live under `<contextFolder>/.pi/skills/`.
 *
 * The model, thinking level, and approval level can be customized via the
 * `getModel`/`getThinkingLevel`/`getApprovalLevel` overridable hooks. The
 * default is `anthropic:claude-sonnet-4-20250514` at "medium" thinking with
 * full-auto approval.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 4;

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
