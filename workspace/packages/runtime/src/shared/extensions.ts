import type { RpcCaller } from "@natstack/rpc";
import type { Disposable, ExtensionsClient, ExtensionSource, RegistryEntry, } from "@natstack/extension";
export type { Disposable, ExtensionsClient, ExtensionSource, RegistryEntry, };
const ignoredProxyProps = new Set<PropertyKey>([
    "then",
    "catch",
    "finally",
    "constructor",
    Symbol.toPrimitive,
    Symbol.toStringTag,
    "inspect",
    "toJSON",
]);
type ExtensionsRpc = RpcCaller & {
    onEvent?: (event: string, listener: (fromId: string, payload: unknown) => void) => () => void;
};
function createExtensionProxy<T extends object>(rpc: ExtensionsRpc, name: string, streamingMethods: ReadonlySet<string> = new Set()): T {
    return new Proxy(Object.create(null), {
        get(_target, prop) {
            if (ignoredProxyProps.has(prop))
                return undefined;
            if (typeof prop !== "string")
                return undefined;
            if (streamingMethods.has(prop)) {
                return (...args: unknown[]) => rpc.streamCall("main", "extensions.invokeStream", [name, prop, args]);
            }
            return (...args: unknown[]) => rpc.call("main", "extensions.invoke", [name, prop, args]);
        },
    }) as T;
}
export function createExtensionsClient(rpc: ExtensionsRpc): ExtensionsClient {
    return {
        use<T extends object>(name: string, options?: { streamingMethods?: Iterable<string> }): T {
            return createExtensionProxy<T>(rpc, name, new Set(options?.streamingMethods ?? []));
        },
        useWithStreams<T extends object>(name: string, streamingMethods: Iterable<string>): T {
            return createExtensionProxy<T>(rpc, name, new Set(streamingMethods));
        },
        streamCall(name: string, method: string, args: unknown[]) {
            return rpc.streamCall("main", "extensions.invokeStream", [name, method, args]);
        },
        on(name, event, cb) {
            const eventName = `extensions:${name}::${event}`;
            const unsubscribe = rpc.onEvent
                ? rpc.onEvent(`event:${eventName}`, (_fromId: string, payload: unknown) => cb(payload))
                : () => { };
            void rpc.call("main", "extensions.on", [name, event]);
            return { dispose: unsubscribe };
        },
        list: () => rpc.call("main", "extensions.list", []),
        reload: (name) => rpc.call("main", "extensions.reload", [name]),
    };
}
