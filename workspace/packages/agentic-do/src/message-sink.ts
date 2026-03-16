/**
 * MessageSink — Delivery-agnostic interface for sending messages to a channel.
 *
 * Decouples StreamWriter from PubSubDOClient so it can be tested
 * or used with alternative transports (WebSocket, file, mock).
 */

import type { SendMessageOptions } from "@natstack/harness/types";
import type { PubSubDOClient } from "@workspace/runtime/worker";

export interface MessageSink {
  send(channelId: string, messageId: string, content: string, opts?: SendMessageOptions): Promise<void>;
  update(channelId: string, messageId: string, content: string): Promise<void>;
  complete(channelId: string, messageId: string): Promise<void>;
}

/** PubSub HTTP implementation of MessageSink. */
export class PubSubMessageSink implements MessageSink {
  constructor(
    private pubsub: PubSubDOClient,
    private participantId: string,
  ) {}

  async send(channelId: string, messageId: string, content: string, opts?: SendMessageOptions): Promise<void> {
    await this.pubsub.send(this.participantId, channelId, messageId, content, opts);
  }

  async update(channelId: string, messageId: string, content: string): Promise<void> {
    await this.pubsub.update(this.participantId, channelId, messageId, content);
  }

  async complete(channelId: string, messageId: string): Promise<void> {
    await this.pubsub.complete(this.participantId, channelId, messageId);
  }
}
