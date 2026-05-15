import type { RpcCaller } from "@natstack/rpc";
import type {
  Disposable,
  ExtensionsClient,
  ExtensionSource,
  InstallSpec,
  RegistryEntry,
} from "@natstack/extension";

export type {
  Disposable,
  ExtensionsClient,
  ExtensionSource,
  InstallSpec,
  RegistryEntry,
};

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

export function createExtensionsClient(rpc: ExtensionsRpc): ExtensionsClient {
  return {
    use<T extends object>(name: string): T {
      return new Proxy(Object.create(null), {
        get(_target, prop) {
          if (ignoredProxyProps.has(prop)) return undefined;
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) =>
            rpc.call("main", "extensions.invoke", name, prop, args);
        },
      }) as T;
    },

    on(name, event, cb) {
      const eventName = `extensions:${name}::${event}`;
      const unsubscribe = rpc.onEvent
        ? rpc.onEvent(`event:${eventName}`, (_fromId: string, payload: unknown) => cb(payload))
        : () => {};
      void rpc.call("main", "extensions.on", name, event);
      return { dispose: unsubscribe };
    },

    list: () => rpc.call("main", "extensions.list"),
    install: (spec) => rpc.call("main", "extensions.install", spec),
    uninstall: (name, opts) => rpc.call("main", "extensions.uninstall", name, opts),
    setEnabled: (name, enabled) => rpc.call("main", "extensions.setEnabled", name, enabled),
    update: (name) => rpc.call("main", "extensions.update", name),
    reload: (name) => rpc.call("main", "extensions.reload", name),
  };
}
