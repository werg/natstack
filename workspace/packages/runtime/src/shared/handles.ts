import type {
  ParentHandle,
  PanelContract,
  ParentHandleFromContract,
  TypedCallProxy,
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

export function createParentHandleFromContract<C extends PanelContract>(
  handle: ParentHandle | null,
  _contract: C
): ParentHandleFromContract<C> | null {
  return handle as any;
}
