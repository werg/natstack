import type { ChildHandle, ChildHandleFromContract, CreateChildOptions, ChildCreationResult, PanelContract, Rpc } from "../core/index.js";
import type { RpcBridge } from "@natstack/rpc";
export type ChildManager = ReturnType<typeof createChildManager>;
export declare function createChildManager(options: {
    rpc: RpcBridge;
    bridge: {
        createChild(source: string, options?: Omit<CreateChildOptions, "eventSchemas">, stateArgs?: Record<string, unknown>): Promise<ChildCreationResult>;
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
}): {
    createChild: <T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap, EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap>(source: string, options?: CreateChildOptions, stateArgs?: Record<string, unknown>) => Promise<ChildHandle<T, E, EmitE>>;
    createBrowserChild: <T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap, EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap>(url: string) => Promise<ChildHandle<T, E, EmitE>>;
    createChildWithContract: <C extends PanelContract>(contract: C, options?: {
        name?: string;
        env?: Record<string, string>;
    }) => Promise<ChildHandleFromContract<C>>;
    readonly children: ReadonlyMap<string, ChildHandle>;
    getChild<T extends Rpc.ExposedMethods = Rpc.ExposedMethods, E extends Rpc.RpcEventMap = Rpc.RpcEventMap>(name: string): ChildHandle<T, E> | undefined;
    onChildAdded(callback: (name: string, handle: ChildHandle) => void): () => void;
    onChildRemoved(callback: (name: string) => void): () => void;
    destroy(): void;
};
//# sourceMappingURL=children.d.ts.map