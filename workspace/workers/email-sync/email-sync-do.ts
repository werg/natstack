/**
 * EmailSyncWorker — Durable Object that polls Gmail for new messages.
 *
 * Lifecycle:
 * 1. Panel calls startSync(connectionId, providerKey, intervalMs)
 * 2. DO stores config in state KV and sets first alarm
 * 3. On alarm: fetches new messages since last historyId, publishes to PubSub
 * 4. Panel subscribes to PubSub channel for real-time updates
 * 5. Panel calls stopSync() to cancel polling
 *
 * Token acquisition: The DO fetches OAuth tokens by calling the server's
 * oauth service via postToDO or direct HTTP to the RPC server.
 */

import { DurableObjectBase } from "@workspace/runtime/worker";
import type { DurableObjectContext } from "@workspace/runtime/worker";

interface SyncConfig {
  connectionId: string;
  providerKey: string;
  intervalMs: number;
  lastHistoryId?: string;
}

interface SyncStatus {
  running: boolean;
  lastSync?: number;
  lastError?: string;
  messagesSynced: number;
}

export class EmailSyncWorker extends DurableObjectBase {
  static override schemaVersion = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
  }

  protected override createTables(): void {
    // No additional SQL tables needed — config/status stored in state KV
  }

  private getConfig(): SyncConfig | null {
    const raw = this.getStateValue("sync_config");
    if (!raw) return null;
    return JSON.parse(raw) as SyncConfig;
  }

  private setConfig(config: SyncConfig): void {
    this.setStateValue("sync_config", JSON.stringify(config));
  }

  private getStatus(): SyncStatus {
    const raw = this.getStateValue("sync_status");
    if (!raw) return { running: false, messagesSynced: 0 };
    return JSON.parse(raw) as SyncStatus;
  }

  private setStatus(status: SyncStatus): void {
    this.setStateValue("sync_status", JSON.stringify(status));
  }

  // --- HTTP dispatch (/{objectKey}/{method}) ---

  protected async startSync(args: unknown[]): Promise<{ ok: boolean; config: SyncConfig }> {
    const [body] = args as [{ connectionId: string; providerKey: string; intervalMs?: number }];

    const config: SyncConfig = {
      connectionId: body.connectionId,
      providerKey: body.providerKey,
      intervalMs: body.intervalMs ?? 60_000,
    };

    this.setConfig(config);
    this.setStatus({ running: true, messagesSynced: 0 });

    // Schedule first alarm
    this.setAlarm(config.intervalMs);

    return { ok: true, config };
  }

  protected async stopSync(_args: unknown[]): Promise<{ ok: boolean }> {
    const status = this.getStatus();
    status.running = false;
    this.setStatus(status);
    this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  protected async getState(_args: unknown[]): Promise<{ config: SyncConfig | null; status: SyncStatus }> {
    return { config: this.getConfig(), status: this.getStatus() };
  }

  // --- Alarm-based polling ---

  override async alarm(): Promise<void> {
    await super.alarm();

    const config = this.getConfig();
    const status = this.getStatus();
    if (!config || !status.running) return;

    try {
      // In a full implementation:
      // 1. Get OAuth token via postToDO to the server's oauth service
      // 2. Fetch Gmail history: GET /gmail/v1/users/me/history?startHistoryId=...
      // 3. Parse new message IDs
      // 4. Publish to PubSub channel: email-sync:{connectionId}
      // 5. Update lastHistoryId in config
      console.log(
        `[EmailSyncWorker] Polling Gmail for ${config.connectionId}` +
        (config.lastHistoryId ? ` (since historyId: ${config.lastHistoryId})` : ""),
      );

      status.lastSync = Date.now();
      this.setStatus(status);
    } catch (err) {
      status.lastError = String(err);
      this.setStatus(status);
      console.error("[EmailSyncWorker] Sync error:", err);
    }

    // Schedule next alarm
    if (status.running) {
      this.setAlarm(config.intervalMs);
    }
  }
}
