import type { ParentHandle, PanelContract, ParentHandleFromContract, Rpc } from "../core/index.js";
import type { RpcBridge } from "@natstack/rpc";
export declare function createParentHandle<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap, EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap>(options: {
    rpc: RpcBridge;
    parentId: string | null;
}): ParentHandle<T, E, EmitE> | null;
export declare function createParentHandleFromContract<C extends PanelContract>(handle: ParentHandle | null, _contract: C): ParentHandleFromContract<C> | null;
//# sourceMappingURL=handles.d.ts.map