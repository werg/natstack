/**
 * Test Echo Agent - Simple agent for testing AgentHost functionality.
 *
 * Echoes received messages back with a count.
 */

import { Agent, runAgent } from "@natstack/agent-runtime";
import type { EventStreamItem } from "@natstack/agentic-messaging";

interface TestEchoState {
  messageCount: number;
  [key: string]: unknown;
}

class TestEchoAgent extends Agent<TestEchoState> {
  state: TestEchoState = { messageCount: 0 };

  getConnectOptions() {
    return {
      name: "Test Echo",
      type: "agent" as const,
      // Resume from last checkpoint to avoid replaying already-seen events
      replaySinceId: this.lastCheckpoint,
    };
  }

  async onWake(): Promise<void> {
    this.log.info("Test Echo Agent started", {
      channel: this.channel,
      handle: this.handle,
    });
  }

  async onEvent(event: EventStreamItem): Promise<void> {
    // Only respond to new messages (not replays)
    if (event.type === "message" && event.kind !== "replay") {
      // Use setState() to ensure state is persisted
      const newCount = this.state.messageCount + 1;
      this.setState({ messageCount: newCount });
      await this.client.send(`Echo #${newCount}: ${String(event.content)}`);
    }
  }

  async onSleep(): Promise<void> {
    this.log.info("Test Echo Agent shutting down", {
      totalMessages: this.state.messageCount,
    });
  }
}

runAgent(TestEchoAgent);
