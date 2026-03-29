import { AiChatWorker } from "@workspace-workers/agent-worker";
import type { HarnessConfig, ParticipantDescriptor } from "@natstack/harness/types";

/**
 * PersonalityAgentWorker — Generic config-driven agent.
 *
 * Derives its entire identity (name, handle, personality, model, tools)
 * from subscription config rather than hardcoding it in TypeScript.
 * Extends AiChatWorker to inherit all event handling, crash recovery,
 * approval flow, turn queuing, and memory tools.
 *
 * Used by the agents skill to spawn personality agents from YAML manifests.
 */
export class PersonalityAgentWorker extends AiChatWorker {
  static override schemaVersion = 6;

  // Minimal base — personality comes entirely from subscription config
  protected override getHarnessConfig(): HarnessConfig {
    return {
      toolAllowlist: ["eval", "set_title"],
    };
  }

  // Identity from subscription config
  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "personality-agent",
      name: (cfg?.["name"] as string) ?? "AI Agent",
      type: "agent",
      metadata: { personality: cfg?.["personality"] as string },
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
      ],
    };
  }

  // Greeting support on first subscribe
  override async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);
    const cfg = opts.config as Record<string, unknown> | undefined;
    const greeting = cfg?.["greeting"] as string | undefined;
    if (greeting && result.ok) {
      await this.startProactiveTurn(opts.channelId, greeting);
    }
    return result;
  }
}
