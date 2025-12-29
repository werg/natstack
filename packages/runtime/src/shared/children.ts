import type {
  ChildHandle,
  ChildHandleFromContract,
  CreateChildOptions,
  ChildCreationResult,
  EventSchemaMap,
  InferEventMap,
  PanelContract,
  Rpc,
} from "../core/index.js";
import type { RpcBridge } from "@natstack/rpc";
import { createChildHandle, createChildHandleFromContract } from "./handles.js";

export type ChildManager = ReturnType<typeof createChildManager>;

export function createChildManager(options: {
  rpc: RpcBridge;
  bridge: {
    createChild(
      source: string,
      options?: Omit<CreateChildOptions, "eventSchemas">
    ): Promise<ChildCreationResult>;
    createBrowserChild(url: string): Promise<ChildCreationResult>;
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
}) {
  const { rpc, bridge } = options;

  const childHandles = new Map<string, ChildHandle>();
  const childAddedListeners = new Set<(name: string, handle: ChildHandle) => void>();
  const childRemovedListeners = new Set<(name: string, childId: string) => void>();
  const childCleanupFunctions = new Map<string, Array<() => void>>();

  const registerCleanup = (childId: string, cleanup: () => void) => {
    const existing = childCleanupFunctions.get(childId) ?? [];
    existing.push(cleanup);
    childCleanupFunctions.set(childId, existing);
  };

  const handleChildRemoved = (childId: string) => {
    const cleanups = childCleanupFunctions.get(childId);
    if (cleanups) {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch (error) {
          console.error("[ChildHandle] Error in cleanup:", error);
        }
      }
      childCleanupFunctions.delete(childId);
    }

    for (const [name, handle] of childHandles) {
      if (handle.id === childId) {
        childHandles.delete(name);
        for (const listener of childRemovedListeners) {
          try {
            listener(name, childId);
          } catch (error) {
            console.error("[ChildHandle] Error in child-removed listener:", error);
          }
        }
        break;
      }
    }
  };

  const onChildRemovedEvent = (_fromId: string, payload: unknown) => {
    const childId = typeof payload === "string" ? payload : (payload as { childId?: unknown })?.childId;
    if (typeof childId !== "string") return;
    handleChildRemoved(childId);
  };

  const runtimeUnsubscribers = [
    rpc.onEvent("runtime:child-removed", onChildRemovedEvent),
  ];

  const createChild = async <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(
    source: string,
    options?: CreateChildOptions
  ): Promise<ChildHandle<T, E, EmitE>> => {
    const { eventSchemas, ...bridgeOptions } = options ?? {};
    const result = await bridge.createChild(source, bridgeOptions);

    const name = options?.name ?? result.id.split("/").pop() ?? result.id;
    const title = result.title ?? name;

    const handle = createChildHandle<T, E, EmitE>({
      rpc,
      bridge,
      id: result.id,
      type: result.type,
      name,
      title,
      source,
      eventSchemas: eventSchemas as EventSchemaMap | undefined,
      onCleanupRegister: registerCleanup,
    });

    childHandles.set(name, handle as ChildHandle);
    for (const listener of childAddedListeners) {
      try {
        listener(name, handle as ChildHandle);
      } catch (error) {
        console.error("[ChildHandle] Error in child-added listener:", error);
      }
    }
    return handle;
  };

  const createBrowserChild = async <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(
    url: string
  ): Promise<ChildHandle<T, E, EmitE>> => {
    const result = await bridge.createBrowserChild(url);

    const name = result.id.split("/").pop() ?? result.id;
    const title = result.title ?? name;

    const handle = createChildHandle<T, E, EmitE>({
      rpc,
      bridge,
      id: result.id,
      type: result.type,
      name,
      title,
      source: url,
      eventSchemas: undefined,
      onCleanupRegister: registerCleanup,
    });

    childHandles.set(name, handle as ChildHandle);
    for (const listener of childAddedListeners) {
      try {
        listener(name, handle as ChildHandle);
      } catch (error) {
        console.error("[ChildHandle] Error in child-added listener:", error);
      }
    }
    return handle;
  };

  const createChildWithContract = async <C extends PanelContract>(
    contract: C,
    options?: { name?: string; env?: Record<string, string> }
  ): Promise<ChildHandleFromContract<C>> => {
    type ChildMethods = C extends PanelContract<infer M, infer _CE, infer _PM, infer _PE> ? M : Rpc.ExposedMethods;
    type ChildEmits = C extends PanelContract<infer _CM, infer CE, infer _PM, infer _PE>
      ? InferEventMap<CE>
      : Rpc.RpcEventMap;
    type ParentEmits = C extends PanelContract<infer _CM, infer _CE, infer _PM, infer PE>
      ? InferEventMap<PE>
      : Rpc.RpcEventMap;

    const handle = await createChild<ChildMethods, ChildEmits, ParentEmits>(contract.source, {
      name: options?.name,
      env: options?.env,
      eventSchemas: contract.child?.emits,
    });
    return createChildHandleFromContract(handle as ChildHandle, contract) as ChildHandleFromContract<C>;
  };

  return {
    createChild,
    createBrowserChild,
    createChildWithContract,

    get children(): ReadonlyMap<string, ChildHandle> {
      return childHandles;
    },

    getChild<
      T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
      E extends Rpc.RpcEventMap = Rpc.RpcEventMap
    >(name: string): ChildHandle<T, E> | undefined {
      return childHandles.get(name) as ChildHandle<T, E> | undefined;
    },

    onChildAdded(callback: (name: string, handle: ChildHandle) => void): () => void {
      childAddedListeners.add(callback);
      return () => childAddedListeners.delete(callback);
    },

    onChildRemoved(callback: (childId: string) => void): () => void {
      const listener = (_name: string, childId: string) => callback(childId);
      childRemovedListeners.add(listener);
      return () => childRemovedListeners.delete(listener);
    },

    destroy(): void {
      for (const unsub of runtimeUnsubscribers) unsub();

      for (const cleanups of childCleanupFunctions.values()) {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch (error) {
            console.error("[ChildHandle] Error in cleanup:", error);
          }
        }
      }
      childHandles.clear();
      childCleanupFunctions.clear();
      childAddedListeners.clear();
      childRemovedListeners.clear();
    },
  };
}
