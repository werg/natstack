import * as crypto from "node:crypto";
import type { WebhookSubscription, WebhookWatchLease } from "./types.js";

export interface DbAdapter {
  run(sql: string, params?: unknown[]): void;
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
}

interface WebhookSubscriptionRow {
  subscription_id: string;
  caller_id: string;
  provider_id: string;
  event_type: string;
  connection_id: string;
  handler: string;
  delivery: WebhookSubscription["delivery"];
  watch_type: string | null;
  lease_id: string | null;
  secret: string | null;
  created_at: number;
  updated_at: number;
}

interface WebhookWatchLeaseRow {
  lease_id: string;
  provider_id: string;
  event_type: string;
  connection_id: string;
  delivery: WebhookWatchLease["delivery"];
  watch_type: string;
  identity_key: string | null;
  callback_path: string | null;
  remote_channel_id: string | null;
  remote_resource_id: string | null;
  cursor: string | null;
  secret: string | null;
  expires_at: number | null;
  last_renewed_at: number | null;
  last_delivery_at: number | null;
  state_json: string | null;
  created_at: number;
  updated_at: number;
}

export class WebhookSubscriptionStore {
  constructor(private db: DbAdapter) {}

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        handler TEXT NOT NULL,
        delivery TEXT NOT NULL,
        watch_type TEXT,
        lease_id TEXT,
        secret TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    const subscriptionColumns = this.db.all<{ name: string }>("PRAGMA table_info(webhook_subscriptions)");
    if (!subscriptionColumns.some((column) => column.name === "handler")) {
      this.db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN handler TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_watch_leases (
        lease_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        delivery TEXT NOT NULL,
        watch_type TEXT NOT NULL,
        identity_key TEXT,
        callback_path TEXT,
        remote_channel_id TEXT,
        remote_resource_id TEXT,
        cursor TEXT,
        secret TEXT,
        expires_at INTEGER,
        last_renewed_at INTEGER,
        last_delivery_at INTEGER,
        state_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS webhook_subscriptions_unique_target_idx
      ON webhook_subscriptions(caller_id, provider_id, event_type, connection_id, handler)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS webhook_subscriptions_provider_event_idx
      ON webhook_subscriptions(provider_id, event_type, connection_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS webhook_subscriptions_lease_idx
      ON webhook_subscriptions(lease_id)
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS webhook_watch_leases_provider_event_conn_watch_idx
      ON webhook_watch_leases(provider_id, event_type, connection_id, watch_type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS webhook_watch_leases_identity_idx
      ON webhook_watch_leases(provider_id, identity_key)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS webhook_watch_leases_remote_channel_idx
      ON webhook_watch_leases(provider_id, remote_channel_id)
    `);
  }

  upsertSubscription(
    sub: Omit<WebhookSubscription, "subscriptionId" | "createdAt" | "updatedAt">,
  ): WebhookSubscription {
    const existing = this.listSubscriptions({
      callerId: sub.callerId,
      providerId: sub.providerId,
      eventType: sub.eventType,
      connectionId: sub.connectionId,
      handler: sub.handler,
    })[0];
    const now = Date.now();
    const subscription: WebhookSubscription = {
      ...sub,
      subscriptionId: existing?.subscriptionId ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.db.run(
      `
        INSERT INTO webhook_subscriptions (
          subscription_id,
          caller_id,
          provider_id,
          event_type,
          connection_id,
          handler,
          delivery,
          watch_type,
          lease_id,
          secret,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          caller_id = excluded.caller_id,
          provider_id = excluded.provider_id,
          event_type = excluded.event_type,
          connection_id = excluded.connection_id,
          handler = excluded.handler,
          delivery = excluded.delivery,
          watch_type = excluded.watch_type,
          lease_id = excluded.lease_id,
          secret = excluded.secret,
          updated_at = excluded.updated_at
      `,
      [
        subscription.subscriptionId,
        subscription.callerId,
        subscription.providerId,
        subscription.eventType,
        subscription.connectionId,
        subscription.handler,
        subscription.delivery,
        subscription.watchType ?? null,
        subscription.leaseId ?? null,
        subscription.secret ?? null,
        subscription.createdAt,
        subscription.updatedAt,
      ]
    );

    return subscription;
  }

  deleteSubscription(subscriptionId: string): void {
    this.db.run("DELETE FROM webhook_subscriptions WHERE subscription_id = ?", [subscriptionId]);
  }

  getSubscription(subscriptionId: string): WebhookSubscription | null {
    const row = this.db.all<WebhookSubscriptionRow>(
      `
        SELECT
          subscription_id,
          caller_id,
          provider_id,
          event_type,
          connection_id,
          handler,
          delivery,
          watch_type,
          lease_id,
          secret,
          created_at,
          updated_at
        FROM webhook_subscriptions
        WHERE subscription_id = ?
      `,
      [subscriptionId],
    )[0];
    return row ? this.subscriptionFromRow(row) : null;
  }

  listSubscriptions(filter?: {
    callerId?: string;
    providerId?: string;
    eventType?: string;
    connectionId?: string;
    handler?: string;
    leaseId?: string;
  }): WebhookSubscription[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.callerId) {
      clauses.push("caller_id = ?");
      params.push(filter.callerId);
    }

    if (filter?.providerId) {
      clauses.push("provider_id = ?");
      params.push(filter.providerId);
    }

    if (filter?.eventType) {
      clauses.push("event_type = ?");
      params.push(filter.eventType);
    }

    if (filter?.connectionId) {
      clauses.push("connection_id = ?");
      params.push(filter.connectionId);
    }

    if (filter?.handler) {
      clauses.push("handler = ?");
      params.push(filter.handler);
    }

    if (filter?.leaseId) {
      clauses.push("lease_id = ?");
      params.push(filter.leaseId);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.all<WebhookSubscriptionRow>(
      `
        SELECT
          subscription_id,
          caller_id,
          provider_id,
          event_type,
          connection_id,
          handler,
          delivery,
          watch_type,
          lease_id,
          secret,
          created_at,
          updated_at
        FROM webhook_subscriptions${where}
        ORDER BY created_at ASC, rowid ASC
      `,
      params
    );

    return rows.map((row) => this.subscriptionFromRow(row));
  }

  countSubscriptionsForLease(leaseId: string): number {
    const row = this.db.all<{ count: number }>(
      `
        SELECT COUNT(*) as count
        FROM webhook_subscriptions
        WHERE lease_id = ?
      `,
      [leaseId],
    )[0];
    return row?.count ?? 0;
  }

  upsertLease(
    lease: Omit<WebhookWatchLease, "createdAt" | "updatedAt"> & { createdAt?: number; updatedAt?: number },
  ): WebhookWatchLease {
    const existing = this.getLease(lease.leaseId);
    const now = Date.now();
    const normalized: WebhookWatchLease = {
      ...lease,
      state: lease.state ?? existing?.state,
      createdAt: lease.createdAt ?? existing?.createdAt ?? now,
      updatedAt: lease.updatedAt ?? now,
    };

    this.db.run(
      `
        INSERT INTO webhook_watch_leases (
          lease_id,
          provider_id,
          event_type,
          connection_id,
          delivery,
          watch_type,
          identity_key,
          callback_path,
          remote_channel_id,
          remote_resource_id,
          cursor,
          secret,
          expires_at,
          last_renewed_at,
          last_delivery_at,
          state_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lease_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          event_type = excluded.event_type,
          connection_id = excluded.connection_id,
          delivery = excluded.delivery,
          watch_type = excluded.watch_type,
          identity_key = excluded.identity_key,
          callback_path = excluded.callback_path,
          remote_channel_id = excluded.remote_channel_id,
          remote_resource_id = excluded.remote_resource_id,
          cursor = excluded.cursor,
          secret = excluded.secret,
          expires_at = excluded.expires_at,
          last_renewed_at = excluded.last_renewed_at,
          last_delivery_at = excluded.last_delivery_at,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `,
      [
        normalized.leaseId,
        normalized.providerId,
        normalized.eventType,
        normalized.connectionId,
        normalized.delivery,
        normalized.watchType,
        normalized.identityKey ?? null,
        normalized.callbackPath ?? null,
        normalized.remoteChannelId ?? null,
        normalized.remoteResourceId ?? null,
        normalized.cursor ?? null,
        normalized.secret ?? null,
        normalized.expiresAt ?? null,
        normalized.lastRenewedAt ?? null,
        normalized.lastDeliveryAt ?? null,
        normalized.state ? JSON.stringify(normalized.state) : null,
        normalized.createdAt,
        normalized.updatedAt,
      ],
    );

    return normalized;
  }

  getLease(leaseId: string): WebhookWatchLease | null {
    const row = this.db.all<WebhookWatchLeaseRow>(
      `
        SELECT
          lease_id,
          provider_id,
          event_type,
          connection_id,
          delivery,
          watch_type,
          identity_key,
          callback_path,
          remote_channel_id,
          remote_resource_id,
          cursor,
          secret,
          expires_at,
          last_renewed_at,
          last_delivery_at,
          state_json,
          created_at,
          updated_at
        FROM webhook_watch_leases
        WHERE lease_id = ?
      `,
      [leaseId],
    )[0];
    return row ? this.leaseFromRow(row) : null;
  }

  listLeases(filter?: {
    providerId?: string;
    eventType?: string;
    connectionId?: string;
    watchType?: string;
  }): WebhookWatchLease[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.providerId) {
      clauses.push("provider_id = ?");
      params.push(filter.providerId);
    }

    if (filter?.eventType) {
      clauses.push("event_type = ?");
      params.push(filter.eventType);
    }

    if (filter?.connectionId) {
      clauses.push("connection_id = ?");
      params.push(filter.connectionId);
    }

    if (filter?.watchType) {
      clauses.push("watch_type = ?");
      params.push(filter.watchType);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.all<WebhookWatchLeaseRow>(
      `
        SELECT
          lease_id,
          provider_id,
          event_type,
          connection_id,
          delivery,
          watch_type,
          identity_key,
          callback_path,
          remote_channel_id,
          remote_resource_id,
          cursor,
          secret,
          expires_at,
          last_renewed_at,
          last_delivery_at,
          state_json,
          created_at,
          updated_at
        FROM webhook_watch_leases${where}
        ORDER BY created_at ASC, rowid ASC
      `,
      params,
    );

    return rows.map((row) => this.leaseFromRow(row));
  }

  findLeaseByIdentity(providerId: string, identityKey: string): WebhookWatchLease | null {
    const row = this.db.all<WebhookWatchLeaseRow>(
      `
        SELECT
          lease_id,
          provider_id,
          event_type,
          connection_id,
          delivery,
          watch_type,
          identity_key,
          callback_path,
          remote_channel_id,
          remote_resource_id,
          cursor,
          secret,
          expires_at,
          last_renewed_at,
          last_delivery_at,
          state_json,
          created_at,
          updated_at
        FROM webhook_watch_leases
        WHERE provider_id = ? AND identity_key = ?
        ORDER BY updated_at DESC
      `,
      [providerId, identityKey],
    )[0];
    return row ? this.leaseFromRow(row) : null;
  }

  findLeaseByRemoteChannel(providerId: string, remoteChannelId: string): WebhookWatchLease | null {
    const row = this.db.all<WebhookWatchLeaseRow>(
      `
        SELECT
          lease_id,
          provider_id,
          event_type,
          connection_id,
          delivery,
          watch_type,
          identity_key,
          callback_path,
          remote_channel_id,
          remote_resource_id,
          cursor,
          secret,
          expires_at,
          last_renewed_at,
          last_delivery_at,
          state_json,
          created_at,
          updated_at
        FROM webhook_watch_leases
        WHERE provider_id = ? AND remote_channel_id = ?
        ORDER BY updated_at DESC
      `,
      [providerId, remoteChannelId],
    )[0];
    return row ? this.leaseFromRow(row) : null;
  }

  deleteLease(leaseId: string): void {
    this.db.run("DELETE FROM webhook_watch_leases WHERE lease_id = ?", [leaseId]);
  }

  touchLeaseDelivery(
    leaseId: string,
    updates: { cursor?: string; lastDeliveryAt?: number },
  ): WebhookWatchLease | null {
    const existing = this.getLease(leaseId);
    if (!existing) {
      return null;
    }

    const next = this.upsertLease({
      ...existing,
      cursor: updates.cursor ?? existing.cursor,
      lastDeliveryAt: updates.lastDeliveryAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    return next;
  }

  private subscriptionFromRow(row: WebhookSubscriptionRow): WebhookSubscription {
    return {
      subscriptionId: row.subscription_id,
      callerId: row.caller_id,
      providerId: row.provider_id,
      eventType: row.event_type,
      connectionId: row.connection_id,
      handler: row.handler,
      delivery: row.delivery,
      watchType: row.watch_type ?? undefined,
      leaseId: row.lease_id ?? undefined,
      secret: row.secret ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private leaseFromRow(row: WebhookWatchLeaseRow): WebhookWatchLease {
    return {
      leaseId: row.lease_id,
      providerId: row.provider_id,
      eventType: row.event_type,
      connectionId: row.connection_id,
      delivery: row.delivery,
      watchType: row.watch_type,
      identityKey: row.identity_key ?? undefined,
      callbackPath: row.callback_path ?? undefined,
      remoteChannelId: row.remote_channel_id ?? undefined,
      remoteResourceId: row.remote_resource_id ?? undefined,
      cursor: row.cursor ?? undefined,
      secret: row.secret ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      lastRenewedAt: row.last_renewed_at ?? undefined,
      lastDeliveryAt: row.last_delivery_at ?? undefined,
      state: row.state_json ? JSON.parse(row.state_json) as Record<string, unknown> : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
