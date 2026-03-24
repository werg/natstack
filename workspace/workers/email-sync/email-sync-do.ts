/**
 * EmailSyncWorker — Durable Object that polls Gmail for new messages.
 *
 * Lifecycle:
 * 1. Panel calls startSync(connectionId, providerKey, intervalMs)
 * 2. DO stores config and sets first alarm
 * 3. On alarm: fetches new messages since last historyId, publishes to PubSub
 * 4. Panel subscribes to PubSub channel for real-time updates
 * 5. Panel calls stopSync() to cancel polling
 *
 * Token acquisition: The DO fetches OAuth tokens by calling the server's
 * oauth service via internal HTTP (since workers can't use the panel RPC bridge).
 */

import type { DurableObjectState } from "@workspace/runtime/worker";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

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

export class EmailSyncWorker {
  private state: DurableObjectState;
  private config: SyncConfig | null = null;
  private status: SyncStatus = { running: false, messagesSynced: 0 };

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
    this.state.blockConcurrencyWhile(async () => {
      this.config = await this.state.storage.get<SyncConfig>("config") ?? null;
      this.status = await this.state.storage.get<SyncStatus>("status") ?? { running: false, messagesSynced: 0 };
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/startSync") {
      const body = await request.json() as {
        connectionId: string;
        providerKey: string;
        intervalMs?: number;
      };

      this.config = {
        connectionId: body.connectionId,
        providerKey: body.providerKey,
        intervalMs: body.intervalMs ?? 60_000,
      };
      this.status = { running: true, messagesSynced: 0 };

      await this.state.storage.put("config", this.config);
      await this.state.storage.put("status", this.status);

      // Set first alarm
      this.state.storage.setAlarm(Date.now() + this.config.intervalMs);

      return Response.json({ ok: true, config: this.config });
    }

    if (request.method === "POST" && url.pathname === "/stopSync") {
      this.status.running = false;
      await this.state.storage.put("status", this.status);
      this.state.storage.deleteAlarm();
      return Response.json({ ok: true });
    }

    if (url.pathname === "/status") {
      return Response.json({ config: this.config, status: this.status });
    }

    return new Response("EmailSyncWorker\n\nPOST /startSync\nPOST /stopSync\nGET /status\n", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  async alarm(): Promise<void> {
    if (!this.config || !this.status.running) return;

    try {
      // Get OAuth token from the server's oauth service
      // In a full implementation, this would use the workerd service bindings
      // to call the server's RPC endpoint. For now, we document the pattern.
      //
      // const token = await env.OAUTH_SERVICE.fetch("/getToken", {
      //   method: "POST",
      //   body: JSON.stringify({ providerKey: this.config.providerKey, connectionId: this.config.connectionId }),
      // });

      // For now, log the sync attempt
      console.log(
        `[EmailSyncWorker] Polling Gmail for ${this.config.connectionId}` +
        (this.config.lastHistoryId ? ` (since historyId: ${this.config.lastHistoryId})` : ""),
      );

      // In a full implementation:
      // 1. Fetch new messages: GET /gmail/v1/users/me/history?startHistoryId=...
      // 2. Parse new message IDs
      // 3. Publish to PubSub channel: email-sync:{connectionId}
      // 4. Update lastHistoryId

      this.status.lastSync = Date.now();
      await this.state.storage.put("status", this.status);
    } catch (err) {
      this.status.lastError = String(err);
      await this.state.storage.put("status", this.status);
      console.error("[EmailSyncWorker] Sync error:", err);
    }

    // Schedule next alarm
    if (this.status.running) {
      this.state.storage.setAlarm(Date.now() + this.config.intervalMs);
    }
  }
}
