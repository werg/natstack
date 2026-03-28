/**
 * StreamWriter — Async streaming message lifecycle manager.
 *
 * Uses a ChannelClient for delivery — sends messages directly to the
 * channel DO via callDO(). No intermediate sink abstraction.
 */

import type { SendMessageOptions } from "@natstack/harness/types";
import type { ChannelClient } from "./channel-client.js";

export interface PersistedStreamState {
  responseMessageId: string | null;
  thinkingMessageId: string | null;
  actionMessageId: string | null;
  typingMessageId: string | null;
}

export class StreamWriter {
  private state: PersistedStreamState;

  constructor(
    private channel: ChannelClient,
    private participantId: string,
    private channelId: string,
    private replyToId: string | undefined,
    private typingContent: string,
    initialState: PersistedStreamState,
  ) {
    this.state = { ...initialState };
  }

  private async send(messageId: string, content: string, options?: SendMessageOptions): Promise<void> {
    await this.channel.send(this.participantId, messageId, content, {
      ...options,
      idempotencyKey: `${messageId}:send`,
    });
  }

  private async update(messageId: string, content: string): Promise<void> {
    // No idempotency key for streaming updates — content changes each call,
    // and duplicate updates are harmless (same content overwrites itself)
    await this.channel.update(this.participantId, messageId, content);
  }

  private async complete(messageId: string): Promise<void> {
    await this.channel.complete(this.participantId, messageId, `${messageId}:complete`);
  }

  async startTyping(): Promise<void> {
    if (this.state.typingMessageId) return;
    const messageId = crypto.randomUUID();
    this.state.typingMessageId = messageId;
    await this.send(messageId, this.typingContent, {
      contentType: "typing",
      // Persist busy-state typing so reconnect/replay can recover it.
      persist: true,
      ...(this.replyToId && { replyTo: this.replyToId }),
    });
  }

  async stopTyping(): Promise<void> {
    if (!this.state.typingMessageId) return;
    await this.complete(this.state.typingMessageId);
    this.state.typingMessageId = null;
  }

  async startThinking(): Promise<void> {
    if (this.state.thinkingMessageId) {
      await this.endThinking();
    }
    const messageId = crypto.randomUUID();
    this.state.thinkingMessageId = messageId;
    await this.send(messageId, "", {
      contentType: "thinking",
      persist: true,
      ...(this.replyToId && { replyTo: this.replyToId }),
    });
  }

  async updateThinking(content: string): Promise<void> {
    if (!this.state.thinkingMessageId || !content) return;
    await this.update(this.state.thinkingMessageId, content);
  }

  async endThinking(): Promise<void> {
    if (!this.state.thinkingMessageId) return;
    await this.complete(this.state.thinkingMessageId);
    this.state.thinkingMessageId = null;
  }

  async startText(metadata?: unknown): Promise<void> {
    if (this.state.responseMessageId) return;
    const messageId = crypto.randomUUID();
    const options: SendMessageOptions = { persist: true, ...(this.replyToId && { replyTo: this.replyToId }) };
    if (metadata) options.senderMetadata = metadata as Record<string, unknown>;
    this.state.responseMessageId = messageId;
    await this.send(messageId, "", options);
  }

  async updateText(content: string): Promise<void> {
    if (!this.state.responseMessageId) return;
    await this.update(this.state.responseMessageId, content);
  }

  async completeText(): Promise<void> {
    if (!this.state.responseMessageId) return;
    await this.complete(this.state.responseMessageId);
    this.state.responseMessageId = null;
  }

  async startAction(tool: string, description: string, toolUseId?: string): Promise<void> {
    if (this.state.actionMessageId) {
      await this.endAction();
    }
    const messageId = crypto.randomUUID();
    this.state.actionMessageId = messageId;
    await this.send(
      messageId,
      JSON.stringify({ type: tool, description, toolUseId, status: "pending" }),
      {
        contentType: "action",
        persist: true,
        ...(this.replyToId && { replyTo: this.replyToId }),
      },
    );
  }

  async endAction(): Promise<void> {
    if (!this.state.actionMessageId) return;
    await this.complete(this.state.actionMessageId);
    this.state.actionMessageId = null;
  }

  async sendInlineUi(data: unknown): Promise<void> {
    const messageId = crypto.randomUUID();
    await this.send(messageId, JSON.stringify(data), {
      contentType: "inline_ui",
      persist: true,
    });
  }

  getState(): PersistedStreamState {
    return { ...this.state };
  }
}
