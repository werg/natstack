import type {
  ChildHandle,
  EventSchemaMap,
  ParentHandle,
  PanelContract,
  ParentHandleFromContract,
  TypedCallProxy,
  InferEventMap,
  Rpc,
} from "../core/index.js";
import type { RpcBridge } from "@natstack/rpc";

function createCallProxy<T extends Rpc.ExposedMethods>(
  rpc: RpcBridge,
  targetId: string
): TypedCallProxy<T> {
  return new Proxy({} as TypedCallProxy<T>, {
    get(_target, method: string) {
      return async (...args: unknown[]) => rpc.call(targetId, method, ...args);
    },
  });
}

export function createChildHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(options: {
  rpc: RpcBridge;
  bridge: {
    removeChild(childId: string): Promise<void>;
    browser: {
      getCdpEndpoint(browserId: string): Promise<string>;
      navigate(browserId: string, url: string): Promise<void>;
      goBack(browserId: string): Promise<void>;
      goForward(browserId: string): Promise<void>;
      reload(browserId: string): Promise<void>;
      stop(browserId: string): Promise<void>;
    };
  };
  id: string;
  type: "app" | "worker" | "browser";
  name: string;
  title: string;
  source: string;
  eventSchemas?: EventSchemaMap;
  onCleanupRegister?: (childId: string, cleanup: () => void) => void;
}): ChildHandle<T, E, EmitE> {
  const { rpc, bridge, id, type, name, title, source, eventSchemas } = options;
  const eventUnsubscribers: Array<() => void> = [];

  const trackCleanup = (cleanup: () => void) => {
    eventUnsubscribers.push(cleanup);
    options.onCleanupRegister?.(id, cleanup);
  };

  const call = createCallProxy<T>(rpc, id);

  return {
    id,
    type,
    name,
    title,
    source,

    async close() {
      for (const unsub of [...eventUnsubscribers]) unsub();
      eventUnsubscribers.length = 0;
      await bridge.removeChild(id);
    },

    call,

    async emit(event: string, payload: unknown) {
      await rpc.emit(id, event, payload);
    },

    onEvent(event: string, listener: (payload: unknown) => void): () => void {
      const unsubscribe = rpc.onEvent(event, (fromId, payload) => {
        if (fromId !== id) return;
        const schema = eventSchemas?.[event];
        if (schema) {
          const result = schema.safeParse(payload);
          if (!result.success) {
            console.error(
              `[ChildHandle] Event "${event}" from ${name} failed validation:`,
              result.error.format()
            );
            return;
          }
          listener(result.data);
          return;
        }
        listener(payload);
      });

      trackCleanup(unsubscribe);

      return () => {
        unsubscribe();
        const idx = eventUnsubscribers.indexOf(unsubscribe);
        if (idx !== -1) eventUnsubscribers.splice(idx, 1);
      };
    },

    onEvents(listeners: Record<string, ((payload: unknown) => void) | undefined>): () => void {
      const unsubs: Array<() => void> = [];
      for (const [event, listener] of Object.entries(listeners)) {
        if (typeof listener !== "function") continue;
        unsubs.push(this.onEvent(event, listener));
      }
      return () => unsubs.forEach((u) => u());
    },

    async getCdpEndpoint() {
      if (type === "worker") throw new Error("getCdpEndpoint() is not available for worker children");
      return bridge.browser.getCdpEndpoint(id);
    },

    async navigate(url: string) {
      if (type !== "browser") throw new Error("navigate() is only available for browser children");
      await bridge.browser.navigate(id, url);
    },
    async goBack() {
      if (type !== "browser") throw new Error("goBack() is only available for browser children");
      await bridge.browser.goBack(id);
    },
    async goForward() {
      if (type !== "browser") throw new Error("goForward() is only available for browser children");
      await bridge.browser.goForward(id);
    },
    async reload() {
      if (type !== "browser") throw new Error("reload() is only available for browser children");
      await bridge.browser.reload(id);
    },
    async stop() {
      if (type !== "browser") throw new Error("stop() is only available for browser children");
      await bridge.browser.stop(id);
    },
  } as ChildHandle<T, E, EmitE>;
}

export function createParentHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(options: { rpc: RpcBridge; parentId: string | null }): ParentHandle<T, E, EmitE> | null {
  const { rpc, parentId } = options;
  if (!parentId) return null;

  const call = createCallProxy<T>(rpc, parentId);

  return {
    id: parentId,
    call,
    async emit(event: string, payload: unknown) {
      await rpc.emit(parentId, event, payload);
    },
    onEvent(event: string, listener: (payload: unknown) => void): () => void {
      return rpc.onEvent(event, (fromId, payload) => {
        if (fromId === parentId) listener(payload);
      });
    },
  } as ParentHandle<T, E, EmitE>;
}

export function createChildHandleFromContract<C extends PanelContract>(
  handle: ChildHandle,
  _contract: C
): C extends PanelContract<infer M, infer CE, infer _PM, infer PE>
  ? ChildHandle<M, InferEventMap<CE>, InferEventMap<PE>>
  : ChildHandle {
  return handle as any;
}

export function createParentHandleFromContract<C extends PanelContract>(
  handle: ParentHandle | null,
  _contract: C
): ParentHandleFromContract<C> | null {
  return handle as any;
}
