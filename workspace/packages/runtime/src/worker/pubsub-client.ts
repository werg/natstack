/**
 * PubSubDOClient — HTTP client for Durable Objects to call PubSub directly.
 *
 * Used by DOs to send/update/complete messages, subscribe/unsubscribe to
 * channels, call methods on other participants, and manage metadata.
 *
 * All operations are HTTP POST to the PubSub server's HTTP API.
 */

import type { SendMessageOptions } from "@natstack/harness/types";
import { HttpClient } from "./http-client.js";

export class PubSubDOClient extends HttpClient {
  constructor(baseUrl: string, authToken: string) {
    super(baseUrl, authToken, "PubSub HTTP");
  }

  // ── Channel operations ──────────────────────────────────────────────────

  async send(
    participantId: string,
    channelId: string,
    messageId: string,
    content: string,
    opts?: SendMessageOptions,
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
  ): Promise<{ channelConfig?: Record<string, unknown> }> {
    const result = await this.post(`/channel/${enc(channelId)}/subscribe`, {
      participantId,
      metadata,
      callbackUrl,
    });
    return (result as { channelConfig?: Record<string, unknown> }) ?? {};
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
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
