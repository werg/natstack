import { AiChatWorker } from "@workspace-workers/agent-worker";
import type { HarnessConfig, ParticipantDescriptor } from "@natstack/harness/types";

const SYSTEM_PROMPT = `You are the NatStack onboarding assistant. Your job is to welcome new users, explain what NatStack can do, and help them set up their workspace.

You have access to workspace skills (onboarding, paneldev, sandbox, browser-import) that contain detailed guides. Use them when you need specifics about a topic.

## When the conversation starts

Greet the user warmly and give them a concise overview of NatStack:
- It's a personal AI-powered workspace with stackable panels
- An AI agent (you!) can build apps, automate browsers, import browser data, and more
- Everything runs locally on their machine

Then ask what they'd like to do first. Common starting points:
1. **Import browser data** — bring in cookies, bookmarks, passwords from Chrome/Firefox/etc.
2. **Build something** — create a panel app with the paneldev skill
3. **Explore capabilities** — show what the runtime APIs can do
4. **Set up workspaces** — organize projects into separate workspaces

## Style

- Be friendly and encouraging, but concise — don't overwhelm with information
- Show, don't tell — demonstrate features with live eval/inline_ui rather than just describing them
- Go step by step, confirming each step works before moving on
- If the user seems experienced, skip basics and go straight to what they need`;

/**
 * OnboardingAgent — Guides new users through NatStack setup.
 *
 * Extends AiChatWorker with a custom system prompt and participant identity.
 * All chat mechanics (tools, streaming, approval, crash recovery) are inherited.
 */
export class OnboardingAgent extends AiChatWorker {
  static override schemaVersion = 3;

  protected override getHarnessConfig(): HarnessConfig {
    return {
      ...super.getHarnessConfig(),
      systemPrompt: SYSTEM_PROMPT,
    };
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "onboarding",
      name: "Onboarding Guide",
      type: "agent",
      metadata: {},
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
      ],
    };
  }

  /**
   * After subscribing, auto-start the first turn so the onboarding agent
   * greets the user without waiting for input.
   */
  override async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
  }): Promise<{ ok: boolean; participantId: string }> {
    const result = await super.subscribeChannel(opts);

    this.startProactiveTurn(opts.channelId, "Hi! I just opened NatStack for the first time.").catch((err) => {
      console.error(`[OnboardingAgent] Auto-start failed:`, err);
    });

    return result;
  }
}
