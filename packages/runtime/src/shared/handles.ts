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

/** Bridge methods needed for child handle operations */
export interface ChildHandleBridge {
  browser: {
    getCdpEndpoint(browserId: string): Promise<string>;
    /** Browser-specific: navigate the browser webContents to a URL */
    navigate(browserId: string, url: string): Promise<void>;
    /** Browser-specific: use browser webContents back navigation */
    goBack(browserId: string): Promise<void>;
    /** Browser-specific: use browser webContents forward navigation */
    goForward(browserId: string): Promise<void>;
    reload(browserId: string): Promise<void>;
    stop(browserId: string): Promise<void>;
  };
  closeChild(childId: string): Promise<void>;
  /** Unified history: go back in panel's navigation history */
  goBack(childId: string): Promise<void>;
  /** Unified history: go forward in panel's navigation history */
  goForward(childId: string): Promise<void>;
  /** Unified history: navigate panel to a new source */
  navigatePanel(childId: string, source: string, targetType: string): Promise<void>;
}

export function createChildHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(options: {
  rpc: RpcBridge;
  bridge: ChildHandleBridge;
  id: string;
  type: "app" | "worker" | "browser";
  name: string;
  source: string;
  eventSchemas?: EventSchemaMap;
  onClose?: () => void;
}): ChildHandle<T, E, EmitE> {
  const { rpc, bridge, id, type, name, source, eventSchemas } = options;
  const eventUnsubscribers: Array<() => void> = [];

  const call = createCallProxy<T>(rpc, id);

  return {
    id,
    type,
    name,
    source,

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

      eventUnsubscribers.push(unsubscribe);

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
      if (type !== "app" && type !== "browser") {
        throw new Error("getCdpEndpoint() is only available for app and browser children");
      }
      return bridge.browser.getCdpEndpoint(id);
    },

    async navigate(url: string) {
      if (type !== "browser") throw new Error("navigate() is only available for browser children");
      await bridge.browser.navigate(id, url);
    },
    async goBack() {
      // Use unified history navigation for all panel types
      await bridge.goBack(id);
    },
    async goForward() {
      // Use unified history navigation for all panel types
      await bridge.goForward(id);
    },
    async reload() {
      if (type !== "browser") throw new Error("reload() is only available for browser children");
      await bridge.browser.reload(id);
    },
    async stop() {
      if (type !== "browser") throw new Error("stop() is only available for browser children");
      await bridge.browser.stop(id);
    },
    async close() {
      await bridge.closeChild(id);
      // Clean up handle after successful close
      options.onClose?.();
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
