/**
 * EmailSyncWorker — Durable Object that polls Gmail for new messages.
 *
 * Lifecycle:
 * 1. Panel calls startSync(connectionId, providerKey, intervalMs)
 * 2. DO stores config in state KV and sets first alarm
 * 3. On alarm: resolves a credential handle via RPC, fetches Gmail history via
 *    native fetch, publishes new-mail events to the channel service via RPC
 * 4. Panel subscribes to that channel for real-time updates
 * 5. Panel calls stopSync() to cancel polling
 *
 * Token acquisition: Uses the shared credential client via the RPC bridge
 * (inherited from DurableObjectBase).
 */
import { DurableObjectBase } from "@workspace/runtime/worker";
import type { DurableObjectContext } from "@workspace/runtime/worker";
import { createGmailClient, type GmailClient } from "@workspace/gmail";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SyncConfig {
    connectionId: string;
    providerId: string;
    intervalMs: number;
    lastHistoryId?: string;
    /** PubSub channel to publish new-mail events to */
    pubsubChannel?: string;
}
interface SyncStatus {
    running: boolean;
    lastSync?: number;
    lastError?: string;
    messagesSynced: number;
}
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_MESSAGES_PER_SYNC = 50;
// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------
export class EmailSyncWorker extends DurableObjectBase {
    static override schemaVersion = 1;
    constructor(ctx: DurableObjectContext, env: unknown) {
        super(ctx, env);
        void this.setOwnTitle("Email sync");
    }
    protected override createTables(): void {
        // Track synced message IDs to avoid duplicate notifications across restarts
        this.sql.exec(`
      CREATE TABLE IF NOT EXISTS synced_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        subject TEXT,
        sender TEXT,
        synced_at INTEGER NOT NULL
      )
    `);
        // Prune entries older than 7 days to keep the table bounded
        this.sql.exec(`DELETE FROM synced_messages WHERE synced_at < ?`, Date.now() - 7 * 24 * 60 * 60 * 1000);
    }
    // --- Config / Status (state KV) ---
    private getConfig(): SyncConfig | null {
        const raw = this.getStateValue("sync_config");
        if (!raw)
            return null;
        return JSON.parse(raw) as SyncConfig;
    }
    private setConfig(config: SyncConfig): void {
        this.setStateValue("sync_config", JSON.stringify(config));
    }
    private getStatus(): SyncStatus {
        const raw = this.getStateValue("sync_status");
        if (!raw)
            return { running: false, messagesSynced: 0 };
        return JSON.parse(raw) as SyncStatus;
    }
    private setStatus(status: SyncStatus): void {
        this.setStateValue("sync_status", JSON.stringify(status));
    }
    // --- Gmail client ---
    //
    // Built lazily on first sync via `createGmailClient`, memoized for
    // the lifetime of the DO. The factory closes over `this.credentials`
    // and resolves the URL-bound credential handle once on first call.
    private _gmail: GmailClient | null = null;
    private get gmail(): GmailClient {
        if (!this._gmail)
            this._gmail = createGmailClient(this.credentials);
        return this._gmail;
    }
    // --- PubSub publishing ---
    private async publishNewMessages(messages: Array<{
        id: string;
        threadId: string;
        subject: string;
        from: string;
    }>, config: SyncConfig): Promise<void> {
        if (!config.pubsubChannel || messages.length === 0)
            return;
        try {
            const channelId = config.pubsubChannel;
            const channelService = await this.rpc.call<{
                kind: string;
                targetId?: string;
            }>("main", "workers.resolveService", ["natstack.channel.v1",
                channelId]);
            if (channelService.kind !== "durable-object" || !channelService.targetId) {
                throw new Error("Channel service must resolve to a Durable Object service");
            }
            await this.rpc.call(channelService.targetId, "send", [`email-sync:${config.connectionId}`,
                `sync-${Date.now()}`,
                JSON.stringify({
                    type: "new-messages",
                    connectionId: config.connectionId,
                    messages,
                    syncedAt: Date.now(),
                })]);
        }
        catch (err) {
            // Non-fatal — panel can still poll via getState
            console.warn("[EmailSyncWorker] Failed to publish to PubSub:", err);
        }
    }
    // --- HTTP dispatch methods (/{objectKey}/{method}) ---
    protected async startSync(body: {
        connectionId: string;
        providerId: string;
        intervalMs?: number;
        pubsubChannel?: string;
    }): Promise<{
        ok: boolean;
        config: SyncConfig;
    }> {
        const config: SyncConfig = {
            connectionId: body.connectionId,
            providerId: body.providerId,
            intervalMs: body.intervalMs ?? 60000,
            pubsubChannel: body.pubsubChannel,
        };
        // Seed historyId from the user's profile so we only get new messages.
        try {
            const profile = await this.gmail.getProfile();
            config.lastHistoryId = profile.historyId;
        }
        catch (err) {
            console.warn("[EmailSyncWorker] Could not seed historyId:", err);
        }
        this.setConfig(config);
        this.setStatus({ running: true, messagesSynced: 0 });
        this.setAlarm(config.intervalMs);
        return { ok: true, config };
    }
    protected async stopSync(): Promise<{
        ok: boolean;
    }> {
        const status = this.getStatus();
        status.running = false;
        this.setStatus(status);
        this.ctx.storage.deleteAlarm();
        return { ok: true };
    }
    protected async syncNow(): Promise<{
        ok: boolean;
        newMessages: number;
    }> {
        const config = this.getConfig();
        if (!config)
            throw new Error("Sync not configured — call startSync first");
        const count = await this.doSync(config);
        return { ok: true, newMessages: count };
    }
    override async getState(): Promise<Record<string, unknown>> {
        return { config: this.getConfig(), status: this.getStatus() };
    }
    // --- Alarm-based polling ---
    override async alarm(): Promise<void> {
        await super.alarm();
        const config = this.getConfig();
        const status = this.getStatus();
        if (!config || !status.running)
            return;
        try {
            const newCount = await this.doSync(config);
            status.lastSync = Date.now();
            status.lastError = undefined;
            status.messagesSynced += newCount;
            this.setStatus(status);
        }
        catch (err) {
            status.lastError = String(err);
            status.lastSync = Date.now();
            this.setStatus(status);
            console.error("[EmailSyncWorker] Sync error:", err);
        }
        // Re-read status from storage in case stopSync() ran concurrently during doSync()
        if (this.getStatus().running) {
            this.setAlarm(config.intervalMs);
        }
    }
    // --- Core sync logic ---
    private async doSync(config: SyncConfig): Promise<number> {
        const gmail = this.gmail;
        // If no historyId yet, seed it from the profile (first sync).
        if (!config.lastHistoryId) {
            const profile = await gmail.getProfile();
            config.lastHistoryId = profile.historyId;
            this.setConfig(config);
            return 0;
        }
        // Fetch history since last sync.
        let history: Awaited<ReturnType<typeof gmail.listHistory>>;
        try {
            history = await gmail.listHistory({
                startHistoryId: config.lastHistoryId,
                historyTypes: ["messageAdded"],
                maxResults: MAX_MESSAGES_PER_SYNC,
            });
        }
        catch (err) {
            // historyId may be expired (404) — reseed from profile.
            if (String(err).includes("404") || String(err).includes("notFound")) {
                const profile = await gmail.getProfile();
                config.lastHistoryId = profile.historyId;
                this.setConfig(config);
                return 0;
            }
            throw err;
        }
        // Extract new inbox message IDs.
        const newMessageIds = new Set<string>();
        for (const entry of history.history ?? []) {
            for (const added of entry.messagesAdded ?? []) {
                if (added.message?.labelIds?.includes("INBOX") && added.message.id) {
                    newMessageIds.add(added.message.id);
                }
            }
        }
        // Deduplicate against already-synced messages.
        const unseenIds: string[] = [];
        for (const id of newMessageIds) {
            const rows = this.sql.exec("SELECT 1 FROM synced_messages WHERE message_id = ?", id).toArray();
            if (rows.length === 0) {
                unseenIds.push(id);
            }
        }
        // Fetch metadata for unseen messages via the client.
        const messages: Array<{
            id: string;
            threadId: string;
            subject: string;
            from: string;
        }> = [];
        for (const id of unseenIds.slice(0, MAX_MESSAGES_PER_SYNC)) {
            try {
                const msg = await gmail.getMessage(id, {
                    format: "metadata",
                    metadataHeaders: ["Subject", "From"],
                });
                const headers = msg.payload?.headers ?? [];
                const subject = headers.find((h) => h.name === "Subject")?.value ?? "(no subject)";
                const from = headers.find((h) => h.name === "From")?.value ?? "";
                messages.push({ id: msg.id, threadId: msg.threadId, subject, from });
                this.sql.exec("INSERT OR IGNORE INTO synced_messages (message_id, thread_id, subject, sender, synced_at) VALUES (?, ?, ?, ?, ?)", msg.id, msg.threadId, subject, from, Date.now());
            }
            catch (err) {
                console.warn(`[EmailSyncWorker] Failed to fetch message ${id}:`, err);
            }
        }
        // Advance the history cursor.
        config.lastHistoryId = history.historyId;
        this.setConfig(config);
        await this.publishNewMessages(messages, config);
        if (messages.length > 0) {
            console.log(`[EmailSyncWorker] Synced ${messages.length} new message(s) for ${config.connectionId}`);
        }
        return messages.length;
    }
}
