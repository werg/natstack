import type { WebhookEvent } from "../../webhooks/types.js";

type EventHandler = (event: WebhookEvent) => void | Promise<void>;

interface MockRelayOpts {
  handlers?: Record<string, EventHandler>;
}

export class MockWebhookRelay {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly deliveredEvents: { eventType: string; event: WebhookEvent; deliveredAt: number }[] = [];

  constructor(opts: MockRelayOpts = {}) {
    if (opts.handlers) {
      for (const [eventType, handler] of Object.entries(opts.handlers)) {
        this.handlers.set(eventType, handler);
      }
    }
  }

  on(eventType: string, handler: EventHandler): void {
    this.handlers.set(eventType, handler);
  }

  off(eventType: string): void {
    this.handlers.delete(eventType);
  }

  async inject(eventType: string, event: WebhookEvent): Promise<void> {
    this.deliveredEvents.push({ eventType, event, deliveredAt: Date.now() });
    const handler = this.handlers.get(eventType);
    if (handler) {
      await handler(event);
    }
  }

  async injectRaw(payload: {
    providerId: string;
    eventType: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<void> {
    const event: WebhookEvent = {
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      providerId: payload.providerId,
      eventType: payload.eventType,
      headers: payload.headers,
      body: payload.body,
      receivedAt: Date.now(),
    };
    await this.inject(payload.eventType, event);
  }

  get delivered(): { eventType: string; event: WebhookEvent; deliveredAt: number }[] {
    return [...this.deliveredEvents];
  }

  get deliveredCount(): number {
    return this.deliveredEvents.length;
  }

  clear(): void {
    this.deliveredEvents.length = 0;
  }
}
