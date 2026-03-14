/**
 * PubSubDOClient — HTTP client for Durable Objects to call PubSub directly.
 *
 * Used by DOs to send/update/complete messages, subscribe/unsubscribe to
 * channels, call methods on other participants, and manage metadata.
 *
 * All operations are HTTP POST to the PubSub server's HTTP API.
 */

export interface PubSubSendOptions {
  contentType?: string;
  persist?: boolean;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
}

export class PubSubDOClient {
  constructor(
    private baseUrl: string,
    private authToken: string,
  ) {}

  // ── Channel operations ──────────────────────────────────────────────────

  async send(
    participantId: string,
    channelId: string,
    messageId: string,
    content: string,
    opts?: PubSubSendOptions,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/send`, {
      participantId,
      messageId,
      content,
      ...opts,
    });
  }

  async update(
    participantId: string,
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/update`, {
      participantId,
      messageId,
      content,
    });
  }

  async complete(
    participantId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/complete`, {
      participantId,
      messageId,
    });
  }

  async sendEphemeral(
    participantId: string,
    channelId: string,
    content: string,
    contentType?: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/send-ephemeral`, {
      participantId,
      content,
      contentType,
    });
  }

  async updateMetadata(
    participantId: string,
    channelId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/update-metadata`, {
      participantId,
      metadata,
    });
  }

  // ── Subscription management ─────────────────────────────────────────────

  async subscribe(
    channelId: string,
    participantId: string,
    metadata: Record<string, unknown>,
    callbackUrl: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/subscribe`, {
      participantId,
      metadata,
      callbackUrl,
    });
  }

  async unsubscribe(
    channelId: string,
    participantId: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/unsubscribe`, {
      participantId,
    });
  }

  // ── Inter-participant method calls ──────────────────────────────────────

  async callMethod(
    channelId: string,
    callerParticipantId: string,
    callerCallbackUrl: string,
    targetParticipantId: string,
    callId: string,
    method: string,
    args: unknown,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/call-method`, {
      callerParticipantId,
      callerCallbackUrl,
      targetParticipantId,
      callId,
      method,
      args,
    });
  }

  async cancelCall(
    channelId: string,
    callId: string,
  ): Promise<void> {
    await this.post(`/channel/${enc(channelId)}/cancel-call`, {
      callId,
    });
  }

  // ── Roster ──────────────────────────────────────────────────────────────

  async getParticipants(
    channelId: string,
  ): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    const resp = await this.get(`/channel/${enc(channelId)}/participants`);
    return resp as Array<{ participantId: string; metadata: Record<string, unknown> }>;
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private async post(path: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`PubSub HTTP ${resp.status}: ${text}`);
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return resp.json();
    }
    return undefined;
  }

  private async get(path: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.authToken}`,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`PubSub HTTP ${resp.status}: ${text}`);
    }
    return resp.json();
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
