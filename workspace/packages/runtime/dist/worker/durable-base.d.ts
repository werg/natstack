/**
 * DurableObjectBase — Tiny generic foundation for all Durable Objects.
 *
 * Only what every DO needs: context, SQL, schema versioning, state KV,
 * alarm support, HTTP dispatch, WebSocket upgrade stub, and hibernation hooks.
 *
 * Agent-specific concerns (harnesses, turns, subscriptions, streams) live
 * in @workspace/agentic-do — composable modules that extend this base.
 */
export interface DurableObjectContext {
    id: {
        toString(): string;
        name?: string;
    };
    storage: {
        sql: SqlStorage;
        setAlarm(scheduledTime: number | Date): void;
        getAlarm(): Promise<number | null>;
        deleteAlarm(): void;
    };
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
export interface SqlStorage {
    exec(query: string, ...bindings: unknown[]): SqlResult;
}
export interface SqlResult {
    toArray(): Record<string, unknown>[];
    one(): Record<string, unknown>;
}
export interface DORef {
    source: string;
    className: string;
    objectKey: string;
}
export declare abstract class DurableObjectBase {
    protected ctx: DurableObjectContext;
    protected sql: SqlStorage;
    protected env: Record<string, unknown>;
    private _schemaReady;
    constructor(ctx: DurableObjectContext, env: unknown);
    static schemaVersion: number;
    /** Subclasses define their SQL tables here. Called during schema init. */
    protected abstract createTables(): void;
    /**
     * Lazily called on first fetch() or alarm(). Safe for subclasses to call
     * earlier from their constructor if they need schema before first request.
     */
    protected ensureReady(): void;
    private ensureSchema;
    protected getStateValue(key: string): string | null;
    protected setStateValue(key: string, value: string): void;
    protected deleteStateValue(key: string): void;
    private _objectKey;
    protected get objectKey(): string;
    /**
     * Call a method on another DO via HTTP POST through the workerd router.
     * Requires WORKERD_URL env binding (injected by WorkerdManager).
     * Retries on transient errors (ECONNREFUSED, 5xx) with exponential backoff.
     */
    protected postToDO<T = unknown>(source: string, className: string, objectKey: string, method: string, ...args: unknown[]): Promise<T>;
    protected setAlarm(delayMs: number): void;
    /** Override in subclasses for timed callbacks. Call super.alarm() first. */
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    /** Override in subclasses to accept WebSocket connections. */
    protected handleWebSocketUpgrade(_request: Request): Response;
    webSocketMessage(_ws: WebSocket, _msg: string | ArrayBuffer): Promise<void>;
    webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void>;
    webSocketError(_ws: WebSocket, _error: unknown): Promise<void>;
    getState(): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=durable-base.d.ts.map