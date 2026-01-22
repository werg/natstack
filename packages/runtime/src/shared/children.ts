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
      options?: Omit<CreateChildOptions, "eventSchemas">,
      stateArgs?: Record<string, unknown>
    ): Promise<ChildCreationResult>;
    createBrowserChild(url: string): Promise<ChildCreationResult>;
    closeChild(childId: string): Promise<void>;
    /** Unified history: go back in panel's navigation history */
    goBack(childId: string): Promise<void>;
    /** Unified history: go forward in panel's navigation history */
    goForward(childId: string): Promise<void>;
    /** Unified history: navigate panel to a new source */
    navigatePanel(childId: string, source: string, targetType: string): Promise<void>;
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
  const childRemovedListeners = new Set<(name: string) => void>();

  /** Remove a child handle and notify listeners */
  function removeChild(name: string): void {
    if (!childHandles.has(name)) return;
    childHandles.delete(name);
    for (const listener of childRemovedListeners) {
      try {
        listener(name);
      } catch (error) {
        console.error("[ChildHandle] Error in child-removed listener:", error);
      }
    }
  }

  async function createChild<
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(
    source: string,
    options?: CreateChildOptions,
    stateArgs?: Record<string, unknown>
  ): Promise<ChildHandle<T, E, EmitE>> {
    const { eventSchemas, ...bridgeOptions } = options ?? {};
    const result = await bridge.createChild(source, bridgeOptions, stateArgs);

    const name = options?.name ?? result.id.split("/").pop() ?? result.id;

    const handle = createChildHandle<T, E, EmitE>({
      rpc,
      bridge,
      id: result.id,
      type: result.type,
      name,
      source,
      eventSchemas: eventSchemas as EventSchemaMap | undefined,
      onClose: () => removeChild(name),
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
  }

  const createBrowserChild = async <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(
    url: string
  ): Promise<ChildHandle<T, E, EmitE>> => {
    const result = await bridge.createBrowserChild(url);

    const name = result.id.split("/").pop() ?? result.id;

    const handle = createChildHandle<T, E, EmitE>({
      rpc,
      bridge,
      id: result.id,
      type: result.type,
      name,
      source: url,
      eventSchemas: undefined,
      onClose: () => removeChild(name),
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

    onChildRemoved(callback: (name: string) => void): () => void {
      childRemovedListeners.add(callback);
      return () => childRemovedListeners.delete(callback);
    },

    destroy(): void {
      childHandles.clear();
      childAddedListeners.clear();
      childRemovedListeners.clear();
    },
  };
}
