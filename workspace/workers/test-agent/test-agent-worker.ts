import { AgentWorkerBase } from "@workspace/agentic-do";
import type {
  ChannelEvent,
  HarnessConfig,
  HarnessOutput,
  ParticipantDescriptor,
} from "@natstack/harness/types";

/**
 * TestAgentWorker — Minimal agent DO for testing the harness pipeline.
 *
 * Overrides only getHarnessConfig() and getParticipantInfo() to inject a
 * distinctive system prompt. All side effects via direct PubSub/server calls.
 */
export class TestAgentWorker extends AgentWorkerBase {
  static override schemaVersion = 3;

  protected override getHarnessConfig(): HarnessConfig {
    return {
      systemPrompt:
        'You MUST begin every response with exactly "the agent says: " (including the colon and space). Then provide your normal helpful response. Keep responses concise.',
    };
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "test-agent",
      name: "Test Agent",
      type: "agent",
    };
  }

  // --- Minimal event handlers ---

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
  ): Promise<void> {
    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return;
    }

    const input = this.buildTurnInput(event);
    const harnessId = this.getHarnessForChannel(channelId);

    if (!harnessId) {
      const contextId = this.getContextId(channelId);
      await this.server.spawnHarness({
        doRef: this.doRef,
        harnessId: `harness-${crypto.randomUUID()}`,
        type: this.getHarnessType(),
        channelId,
        contextId,
        config: this.getHarnessConfig(),
        initialTurn: {
          input,
          triggerMessageId: event.messageId,
          triggerPubsubId: event.id,
        },
      });
    } else {
      this.setActiveTurn(harnessId, channelId, event.messageId);
      this.setInFlightTurn(channelId, harnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, harnessId, event.id);

      await this.server.sendHarnessCommand(harnessId, {
        type: "start-turn",
        input,
      });
    }
  }

  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<void> {
    const turn = this.getActiveTurn(harnessId);
    const channelId =
      turn?.channelId ?? this.getChannelForHarness(harnessId);

    if (!channelId || !turn) return;

    const writer = this.createWriter(channelId, turn);

    switch (event.type) {
      case "text-start":
        await writer.startText();
        break;
      case "text-delta":
        await writer.updateText(event.content);
        break;
      case "text-end":
        await writer.completeText();
        break;
      case "turn-complete": {
        this.persistStreamState(harnessId, writer);
        const activeTurn = this.getActiveTurn(harnessId);
        if (activeTurn?.turnMessageId) {
          const inFlight = this.getInFlightTurn(channelId, harnessId);
          this.recordTurn(
            harnessId,
            activeTurn.turnMessageId,
            inFlight?.triggerPubsubId ?? 0,
            event.sessionId,
          );
        }
        this.clearActiveTurn(harnessId);
        this.clearInFlightTurn(channelId, harnessId);
        return; // Skip final persistStreamState
      }
      case "ready":
        this.sql.exec(
          `UPDATE harnesses SET status = 'active' WHERE id = ?`,
          harnessId,
        );
        break;
    }

    this.persistStreamState(harnessId, writer);
  }
}
