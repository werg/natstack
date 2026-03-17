interface SqlResult {
    toArray(): Record<string, unknown>[];
    one(): Record<string, unknown>;
}
/** Mock WebSocket for testing channel DO and hibernation flows. */
export declare class MockWebSocket {
    sent: string[];
    closed: boolean;
    closeCode?: number;
    closeReason?: string;
    private attachment;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    serializeAttachment(value: unknown): void;
    deserializeAttachment(): unknown;
}
interface AcceptedWebSocket {
    ws: unknown;
    tags: string[];
}
interface TestDOResult<T> {
    instance: T;
    sql: {
        exec(query: string, ...bindings: unknown[]): SqlResult;
    };
    /** Alarms scheduled via ctx.storage.setAlarm(). Inspectable in tests. */
    alarms: number[];
    /** WebSockets accepted via ctx.acceptWebSocket(). Inspectable in tests. */
    acceptedWebSockets: AcceptedWebSocket[];
}
/**
 * Create a test DO instance backed by in-memory SQLite (sql.js / WASM).
 * Eliminates the need for workerd or native modules in unit tests.
 *
 * Works with both DurableObjectBase and AgentWorkerBase subclasses.
 * For AgentWorkerBase subclasses, SERVER_URL/RPC_AUTH_TOKEN
 * are automatically stubbed unless overridden via the env parameter.
 *
 * Must be awaited since sql.js initialization is async.
 */
export declare function createTestDO<T>(DOClass: new (ctx: any, env: any) => T, env?: Record<string, unknown>): Promise<TestDOResult<T>>;
export {};
//# sourceMappingURL=durable-test-utils.d.ts.map