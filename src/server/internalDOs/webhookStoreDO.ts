import { DurableObjectBase, type DurableObjectContext } from "../../../workspace/packages/runtime/src/worker/durable-base.js";
import type { WebhookIngressSubscription } from "../../../packages/shared/src/webhooks/ingress.js";

interface WebhookIngressSubscriptionRow {
  subscription_id: string;
  label: string | null;
  owner_caller_id: string;
  owner_caller_kind: WebhookIngressSubscription["ownerCallerKind"];
  target_json: string;
  verifier_json: string;
  replay_json: string | null;
  public_url: string;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export class WebhookStoreDO extends DurableObjectBase {
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_ingress_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        label TEXT,
        owner_caller_id TEXT NOT NULL,
        owner_caller_kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        verifier_json TEXT NOT NULL,
        replay_json TEXT,
        public_url TEXT NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS webhook_ingress_subscriptions_owner_idx
      ON webhook_ingress_subscriptions(owner_caller_id)
    `);
  }

  create(input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">): WebhookIngressSubscription {
    const now = Date.now();
    const subscription: WebhookIngressSubscription = {
      ...input,
      subscriptionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.replace(subscription);
    return subscription;
  }

  get(subscriptionId: string): WebhookIngressSubscription | null {
    const row = this.sql.exec(this.selectSql("WHERE subscription_id = ?"), subscriptionId)
      .toArray()[0] as unknown as WebhookIngressSubscriptionRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  list(ownerCallerId?: string): WebhookIngressSubscription[] {
    const rows = ownerCallerId
      ? this.sql.exec(this.selectSql("WHERE owner_caller_id = ?"), ownerCallerId).toArray()
      : this.sql.exec(this.selectSql("")).toArray();
    return (rows as unknown as WebhookIngressSubscriptionRow[]).map((row) => this.fromRow(row));
  }

  replace(subscription: WebhookIngressSubscription): void {
    this.sql.exec(
      `
        INSERT INTO webhook_ingress_subscriptions (
          subscription_id, label, owner_caller_id, owner_caller_kind,
          target_json, verifier_json, replay_json, public_url,
          revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          label = excluded.label,
          owner_caller_id = excluded.owner_caller_id,
          owner_caller_kind = excluded.owner_caller_kind,
          target_json = excluded.target_json,
          verifier_json = excluded.verifier_json,
          replay_json = excluded.replay_json,
          public_url = excluded.public_url,
          revoked_at = excluded.revoked_at,
          updated_at = excluded.updated_at
      `,
      subscription.subscriptionId,
      subscription.label ?? null,
      subscription.ownerCallerId,
      subscription.ownerCallerKind,
      JSON.stringify(subscription.target),
      JSON.stringify(subscription.verifier),
      subscription.replay ? JSON.stringify(subscription.replay) : null,
      subscription.publicUrl,
      subscription.revokedAt ?? null,
      subscription.createdAt,
      subscription.updatedAt,
    );
  }

  private selectSql(where: string): string {
    return `
      SELECT
        subscription_id,
        label,
        owner_caller_id,
        owner_caller_kind,
        target_json,
        verifier_json,
        replay_json,
        public_url,
        revoked_at,
        created_at,
        updated_at
      FROM webhook_ingress_subscriptions
      ${where}
      ORDER BY created_at ASC
    `;
  }

  private fromRow(row: WebhookIngressSubscriptionRow): WebhookIngressSubscription {
    return {
      subscriptionId: row.subscription_id,
      label: row.label ?? undefined,
      ownerCallerId: row.owner_caller_id,
      ownerCallerKind: row.owner_caller_kind,
      target: JSON.parse(row.target_json) as WebhookIngressSubscription["target"],
      verifier: JSON.parse(row.verifier_json) as WebhookIngressSubscription["verifier"],
      replay: row.replay_json ? JSON.parse(row.replay_json) as WebhookIngressSubscription["replay"] : undefined,
      publicUrl: row.public_url,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

