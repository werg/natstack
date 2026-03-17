/**
 * Base HTTP client for DO outbound calls.
 *
 * Shared by ServerDOClient — provides authenticated
 * JSON POST/GET with consistent error handling and retry with exponential backoff.
 */
export declare class HttpClient {
    protected baseUrl: string;
    protected authToken: string;
    private label;
    constructor(baseUrl: string, authToken: string, label: string);
    protected post(path: string, body: unknown, opts?: {
        retries?: number;
    }): Promise<unknown>;
    protected get(path: string, opts?: {
        retries?: number;
    }): Promise<unknown>;
}
//# sourceMappingURL=http-client.d.ts.map