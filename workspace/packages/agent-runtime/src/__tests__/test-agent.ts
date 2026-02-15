/**
 * Test agent example - validates types and API work correctly.
 *
 * This file is not actually run but used to verify TypeScript types.
 */

import { Agent, runAgent } from "../index.js";
import type { AgentState, AgentContext, AgentConnectOptions } from "../index.js";
import type { EventStreamItem, EventStreamOptions } from "@workspace/agentic-messaging";
import { z } from "zod";

// Test: Define a custom state interface
interface TestState extends AgentState {
  messageCount: number;
  lastMessageId?: string;
  processingQueue: string[];
}

// Test: Create an agent class
class TestAgent extends Agent<TestState> {
  // State must be JSON-serializable
  state: TestState = {
    messageCount: 0,
    processingQueue: [],
  };

  private queue: EventStreamItem[] = [];
  private processing = false;

  async onWake(): Promise<void> {
    this.ctx.log.info("TestAgent woke up with state:", this.state);

    // Test: Access context properties
    const { agentId, channel, handle, config, client, log } = this.ctx;
    log.debug(`Agent ${agentId} on channel ${channel} as ${handle}`);
    log.info("Config:", config);

    // Start background queue processor
    this.processQueue();
  }

  async onEvent(event: EventStreamItem): Promise<void> {
    // Test: Filter events
    if (event.type !== "message") return;
    if ("kind" in event && event.kind === "replay") return;

    // Test: Enqueue for async processing
    this.queue.push(event);
    this.processQueue();
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    void (async () => {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        await this.handleMessage(event);
      }
      this.processing = false;
    })();
  }

  private async handleMessage(event: EventStreamItem): Promise<void> {
    if (event.type !== "message") return;

    this.state.messageCount++;
    this.state.lastMessageId = event.id;

    // Test: Use client to send messages (client is always available after connection)
    await this.ctx.client!.send(`Echo: ${event.content} (message #${this.state.messageCount})`, {
      replyTo: event.id,
    });

    this.ctx.log.info(`Processed message ${event.id}`);
  }

  async onSleep(): Promise<void> {
    this.ctx.log.info("TestAgent going to sleep with state:", this.state);

    // Finish processing queue
    while (this.queue.length > 0) {
      const event = this.queue.shift()!;
      await this.handleMessage(event);
    }
  }

  // Test: Override connect options
  getConnectOptions(): AgentConnectOptions {
    return {
      name: "Test Agent",
      type: "assistant",
      replayMode: "collect",
      extraMetadata: {
        version: "1.0.0",
      },
      methods: {
        ping: {
          description: "Ping the agent",
          parameters: z.object({}),
          execute: async () => ({ pong: true, messageCount: this.state.messageCount }),
        },
      },
    };
  }

  // Test: Override events options
  getEventsOptions(): EventStreamOptions {
    return {
      targetedOnly: true,
      respondWhenSolo: true,
      includeReplay: false,
    };
  }
}

// Test: runAgent is callable
export function runTestAgent() {
  void runAgent(TestAgent);
}

// Test: Type-only validation (this code is never run, just type-checked)
export function validateTypes() {
  // AgentContext has required properties
  const _ctx: AgentContext = {
    agentId: "test",
    channel: "test-channel",
    handle: "assistant",
    config: {},
    client: {} as AgentContext["client"],
    log: {} as AgentContext["log"],
    pubsubUrl: "http://localhost:8787",
    pubsubToken: "test-token",
  };

  // AgentState is an index signature type
  const _state: AgentState = {
    foo: "bar",
    count: 123,
    nested: { a: 1 },
  };

  return { _ctx, _state };
}
