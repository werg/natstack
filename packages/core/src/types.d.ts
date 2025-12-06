export interface PanelRpcRequest {
    type: "rpc-request";
    id: string;
    method: string;
    args: unknown[];
}
export interface PanelRpcResponse {
    type: "rpc-response";
    id: string;
    result?: unknown;
    error?: string;
}
export interface PanelRpcEvent {
    type: "rpc-event";
    event: string;
    payload: unknown;
}
export type PanelRpcMessage = PanelRpcRequest | PanelRpcResponse | PanelRpcEvent;
export type SchemaType = "string" | "number" | "boolean" | "object" | "array" | "any" | "void";
export interface MethodSchema {
    params: SchemaType[];
    returns: SchemaType;
}
export interface PanelRpcSchema {
    methods: Record<string, MethodSchema>;
    events?: string[];
}
export interface PanelRpcIpcApi {
    "panel-rpc:connect": (fromPanelId: string, toPanelId: string) => {
        isWorker: boolean;
        workerId?: string;
    };
}
export type AnyFunction = (...args: any[]) => any;
export interface ExposedMethods {
    [methodName: string]: AnyFunction;
}
/**
 * Event map for typed events.
 * Extend this interface to define event types.
 */
export interface RpcEventMap {
    [eventName: string]: any;
}
export interface PanelRpcHandle<T extends ExposedMethods = ExposedMethods, E extends RpcEventMap = RpcEventMap> {
    /** The panel ID this handle connects to */
    panelId: string;
    /** Call a method on the remote panel */
    call: {
        [K in keyof T]: T[K] extends AnyFunction ? (...args: Parameters<T[K]>) => Promise<Awaited<ReturnType<T[K]>>> : never;
    };
    /** Subscribe to events from the remote panel (typed if event map provided) */
    on<EventName extends Extract<keyof E, string>>(event: EventName, handler: (payload: E[EventName]) => void): () => void;
    /** Subscribe to events from the remote panel (untyped fallback) */
    on(event: string, handler: (payload: unknown) => void): () => void;
}
export declare function inferSchema(methods: ExposedMethods): PanelRpcSchema;
export declare function validateType(value: unknown, type: SchemaType): boolean;
//# sourceMappingURL=types.d.ts.map