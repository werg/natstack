import * as crypto from "node:crypto";
import type { WebhookSubscription } from "./types.js";

export interface DbAdapter {
  run(sql: string, params?: unknown[]): void;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
}

interface WebhookSubscriptionRow {
  subscription_id: string;
  worker_id: string;
  provider_id: string;
  event_type: string;
  delivery: WebhookSubscription["delivery"];
  secret: string | null;
  created_at: number;
}

export class WebhookSubscriptionStore {
  constructor(private db: DbAdapter) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        delivery TEXT NOT NULL,
        secret TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  add(sub: Omit<WebhookSubscription, "subscriptionId" | "createdAt">): WebhookSubscription {
    const subscription: WebhookSubscription = {
      ...sub,
      subscriptionId: crypto.randomUUID(),
      createdAt: Date.now(),
    };

    this.db.run(
      `
        INSERT INTO webhook_subscriptions (
          subscription_id,
          worker_id,
          provider_id,
          event_type,
          delivery,
          secret,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        subscription.subscriptionId,
        subscription.workerId,
        subscription.providerId,
        subscription.eventType,
        subscription.delivery,
        subscription.secret ?? null,
        subscription.createdAt,
      ]
    );

    return subscription;
  }

  remove(subscriptionId: string): void {
    this.db.run("DELETE FROM webhook_subscriptions WHERE subscription_id = ?", [subscriptionId]);
  }

  list(filter?: {
    workerId?: string;
    providerId?: string;
    eventType?: string;
  }): WebhookSubscription[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.workerId) {
      clauses.push("worker_id = ?");
      params.push(filter.workerId);
    }

    if (filter?.providerId) {
      clauses.push("provider_id = ?");
      params.push(filter.providerId);
    }

    if (filter?.eventType) {
      clauses.push("event_type = ?");
      params.push(filter.eventType);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.all<WebhookSubscriptionRow>(
      `
        SELECT
          subscription_id,
          worker_id,
          provider_id,
          event_type,
          delivery,
          secret,
          created_at
        FROM webhook_subscriptions${where}
        ORDER BY created_at ASC, rowid ASC
      `,
      params
    );

    return rows.map((row) => this.fromRow(row));
  }

  findForEvent(providerId: string, eventType: string): WebhookSubscription[] {
    return this.list({ providerId, eventType });
  }

  private fromRow(row: WebhookSubscriptionRow): WebhookSubscription {
    return {
      subscriptionId: row.subscription_id,
      workerId: row.worker_id,
      providerId: row.provider_id,
      eventType: row.event_type,
      delivery: row.delivery,
      secret: row.secret ?? undefined,
      createdAt: row.created_at,
    };
  }
}
