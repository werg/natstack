import type { WorkerAction, SendOptions } from "@natstack/harness";

export interface PersistedStreamState {
  responseMessageId: string | null;
  thinkingMessageId: string | null;
  actionMessageId: string | null;
  typingMessageId: string | null;
}

/**
 * StreamWriter mirrors the old tracker semantics while keeping state
 * durable across DO invocations.
 */
export class StreamWriter {
  private state: PersistedStreamState;

  constructor(
    private channelId: string,
    private replyToId: string,
    private typingContent: string,
    initialState: PersistedStreamState,
    private actions: WorkerAction[],
  ) {
    this.state = { ...initialState };
  }

  private send(messageId: string, content: string, options?: SendOptions): void {
    this.actions.push({
      target: "channel",
      channelId: this.channelId,
      op: "send",
      messageId,
      content,
      ...(options ? { options } : {}),
    });
  }

  private update(messageId: string, content: string): void {
    this.actions.push({
      target: "channel",
      channelId: this.channelId,
      op: "update",
      messageId,
      content,
    });
  }

  private complete(messageId: string): void {
    this.actions.push({
      target: "channel",
      channelId: this.channelId,
      op: "complete",
      messageId,
    });
  }

  startTyping(): void {
    if (this.state.typingMessageId) return;
    const messageId = crypto.randomUUID();
    this.state.typingMessageId = messageId;
    this.send(messageId, this.typingContent, {
      type: "typing",
      persist: false,
      replyTo: this.replyToId,
    });
  }

  stopTyping(): void {
    if (!this.state.typingMessageId) return;
    this.complete(this.state.typingMessageId);
    this.state.typingMessageId = null;
  }

  startThinking(): void {
    this.stopTyping();
    if (this.state.thinkingMessageId) {
      this.endThinking();
    }
    const messageId = crypto.randomUUID();
    this.state.thinkingMessageId = messageId;
    this.send(messageId, "", {
      type: "thinking",
      persist: true,
      replyTo: this.replyToId,
    });
  }

  updateThinking(content: string): void {
    if (!this.state.thinkingMessageId || !content) return;
    this.update(this.state.thinkingMessageId, content);
  }

  endThinking(): void {
    if (!this.state.thinkingMessageId) return;
    this.complete(this.state.thinkingMessageId);
    this.state.thinkingMessageId = null;
  }

  startText(metadata?: unknown): void {
    this.stopTyping();
    if (this.state.responseMessageId) return;
    const messageId = crypto.randomUUID();
    const options: SendOptions = { persist: true, replyTo: this.replyToId };
    if (metadata) options.metadata = metadata as Record<string, unknown>;
    this.state.responseMessageId = messageId;
    this.send(messageId, "", options);
  }

  updateText(content: string): void {
    if (!this.state.responseMessageId) return;
    this.update(this.state.responseMessageId, content);
  }

  completeText(): void {
    if (!this.state.responseMessageId) return;
    this.complete(this.state.responseMessageId);
    this.state.responseMessageId = null;
  }

  startAction(tool: string, description: string, toolUseId?: string): void {
    this.stopTyping();
    if (this.state.actionMessageId) {
      this.endAction();
    }
    const messageId = crypto.randomUUID();
    this.state.actionMessageId = messageId;
    this.send(
      messageId,
      JSON.stringify({ type: tool, description, toolUseId, status: "pending" }),
      {
        type: "action",
        persist: true,
        replyTo: this.replyToId,
      },
    );
  }

  endAction(): void {
    if (!this.state.actionMessageId) return;
    this.complete(this.state.actionMessageId);
    this.state.actionMessageId = null;
  }

  sendInlineUi(data: unknown): void {
    const messageId = crypto.randomUUID();
    this.send(messageId, JSON.stringify(data), {
      type: "inline_ui",
      persist: true,
    });
  }

  getState(): PersistedStreamState {
    return { ...this.state };
  }
}
