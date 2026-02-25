/**
 * Database Types - Minimal database interface for state persistence.
 *
 * Runtime implementation (createDbClient) lives in @workspace/agent-runtime.
 */
export interface DbRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
}
export interface DatabaseInterface {
    exec(sql: string): Promise<void>;
    run(sql: string, params?: unknown[]): Promise<DbRunResult>;
    get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
    query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
    close(): Promise<void>;
}
export type DatabaseOpener = (name: string, readOnly?: boolean) => Promise<DatabaseInterface>;
export interface RpcCaller {
    call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
}
export interface DbClient {
    open(name: string, readOnly?: boolean): Promise<DatabaseInterface>;
}
//# sourceMappingURL=database.d.ts.map