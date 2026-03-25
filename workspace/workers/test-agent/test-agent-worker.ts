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
 * distinctive system prompt. All side effects via RPC calls.
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
    const activeHarnessId = this.getActiveHarness();

    if (!activeHarnessId) {
      const contextId = this.getContextId(channelId);
      const harnessId = `harness-${crypto.randomUUID()}`;

      this.registerHarness(harnessId, this.getHarnessType());
      this.recordTurnStart(harnessId, channelId, input, event.messageId, event.id);

      await this.rpc.call("main", "harness.spawn", {
        doRef: this.doRef,
        harnessId,
        type: this.getHarnessType(),
        contextId,
        config: this.getHarnessConfig(),
        initialInput: input,
      });
    } else if (this.getActiveTurn(activeHarnessId)) {
      // Turn in progress — send to harness first, only enqueue on success
      await this.rpc.call("main", "harness.sendCommand", activeHarnessId, {
        type: "start-turn",
        input,
      });
      this.enqueueTurn(channelId, activeHarnessId, event.messageId, event.id, event.senderId, input);
      this.advanceCheckpoint(channelId, activeHarnessId, event.id);
    } else {
      // Harness idle — start immediately
      this.setActiveTurn(activeHarnessId, channelId, event.messageId);
      this.setInFlightTurn(channelId, activeHarnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, activeHarnessId, event.id);

      await this.rpc.call("main", "harness.sendCommand", activeHarnessId, {
        type: "start-turn",
        input,
      });
    }
  }

  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<void> {
    if (event.type === "ready") {
      this.sql.exec(
        `UPDATE harnesses SET status = 'active' WHERE id = ?`,
        harnessId,
      );
      return;
    }

    const turn = this.getActiveTurn(harnessId);
    const channelId = turn?.channelId;

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

        // Dequeue next turn if any
        const next = this.dequeueNextTurn(harnessId);
        if (next) {
          this.setActiveTurn(harnessId, next.channelId, next.messageId, undefined, next.senderId);
          this.setInFlightTurn(next.channelId, harnessId, next.messageId, next.pubsubId, next.turnInput);
        }
        return; // Skip final persistStreamState
      }
    }

    this.persistStreamState(harnessId, writer);
  }
}
