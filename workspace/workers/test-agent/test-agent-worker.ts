import { AgentWorkerBase } from "@workspace/runtime/worker";
import type {
  ChannelEvent,
  HarnessConfig,
  HarnessOutput,
  ParticipantDescriptor,
  WorkerActions,
} from "@natstack/harness";

/**
 * TestAgentWorker — Minimal agent DO for testing the harness pipeline.
 *
 * Overrides only getHarnessConfig() and getParticipantInfo() to inject a
 * distinctive system prompt. All channel/harness event handling is inherited
 * from the default AiChatWorker-style logic (delegated to AgentWorkerBase hooks).
 */
export class TestAgentWorker extends AgentWorkerBase {
  static override schemaVersion = 1;

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
  // These delegate to the base class hooks for filtering, turn building, etc.

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
  ): Promise<WorkerActions> {
    const $ = this.actions();

    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return $.result();
    }

    const input = this.buildTurnInput(event);
    const harnessId = this.getHarnessForChannel(channelId);

    if (!harnessId) {
      const contextId = this.getContextId(channelId);
      $.spawnHarness({
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
      $.harness(harnessId).startTurn(input);
      this.setActiveTurn(harnessId, channelId, event.messageId);
      this.setInFlightTurn(
        channelId,
        harnessId,
        event.messageId,
        event.id,
        input,
      );
      this.advanceCheckpoint(channelId, harnessId, event.id);
    }

    return $.result();
  }

  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<WorkerActions> {
    const $ = this.actions();
    const turn = this.getActiveTurn(harnessId);
    const channelId =
      turn?.channelId ?? this.getChannelForHarness(harnessId);

    if (!channelId) return $.result();

    if (turn) {
      const writer = $.channel(channelId).streamFor(harnessId, turn);

      switch (event.type) {
        case "text-start":
          writer.startText();
          break;
        case "text-delta":
          writer.updateText(event.content);
          break;
        case "text-end":
          writer.completeText();
          break;
        case "turn-complete": {
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
          break;
        }
        case "ready":
          this.sql.exec(
            `UPDATE harnesses SET status = 'active' WHERE id = ?`,
            harnessId,
          );
          break;
      }
    }

    return $.result();
  }
}
