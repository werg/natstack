/**
 * Test Echo Agent - Simple agent for testing AgentHost functionality.
 *
 * Echoes received messages back with a count.
 */

import { Agent, runAgent } from "@natstack/agent-runtime";
import type { EventStreamItem } from "@natstack/agentic-messaging";

interface TestEchoState {
  messageCount: number;
}

class TestEchoAgent extends Agent<TestEchoState> {
  state: TestEchoState = { messageCount: 0 };

  async onWake(): Promise<void> {
    this.ctx.log.info("Test Echo Agent started", {
      channel: this.ctx.channel,
      handle: this.ctx.handle,
    });
  }

  async onEvent(event: EventStreamItem): Promise<void> {
    // Only respond to new messages (not replays)
    if (event.type === "message" && event.kind !== "replay") {
      this.state.messageCount++;
      await this.ctx.client.send(`Echo #${this.state.messageCount}: ${String(event.content)}`);
    }
  }

  async onSleep(): Promise<void> {
    this.ctx.log.info("Test Echo Agent shutting down", {
      totalMessages: this.state.messageCount,
    });
  }
}

runAgent(TestEchoAgent);
