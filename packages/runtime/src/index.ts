export type {
  RuntimeFs,
  FileStats,
  MkdirOptions,
  RmOptions,
  RuntimeFetch,
  FetchOptions,
  FetchResponse,
  ThemeAppearance,
  BootstrapResult,
} from "./types.js";

export type {
  ChildSpec,
  AppChildSpec,
  WorkerChildSpec,
  BrowserChildSpec,
  GitConfig,
  EndpointInfo,
  EventSchemaMap,
  InferEventMap,
  ChildHandle,
  ChildHandleFromContract,
  ParentHandle,
  PanelContract,
  ParentHandleFromContract,
  TypedCallProxy,
} from "./core/index.js";

export type { Runtime } from "./setup/createRuntime.js";

export declare const rpc: import("@natstack/rpc").RpcBridge;
export declare const db: {
  open(name: string, readOnly?: boolean): Promise<import("./shared/db.js").Database>;
};
export declare const fs: import("./types.js").RuntimeFs;
export declare const fetch: import("./types.js").RuntimeFetch;
export declare const parent: import("./core/index.js").ParentHandle;

export declare const id: string;
export declare const parentId: string | null;

export declare function getParent<
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap,
  EmitE extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(): import("./core/index.js").ParentHandle<T, E, EmitE> | null;

export declare function getParentWithContract<C extends import("./core/index.js").PanelContract>(
  contract: C
): import("./core/index.js").ParentHandleFromContract<C> | null;

export declare function createChild<
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap,
  EmitE extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(spec: import("./core/index.js").ChildSpec): Promise<import("./core/index.js").ChildHandle<T, E, EmitE>>;

export declare function createChildWithContract<C extends import("./core/index.js").PanelContract>(
  contract: C,
  options?: { name?: string; env?: Record<string, string>; type?: "app" | "worker" }
): Promise<import("./core/index.js").ChildHandleFromContract<C>>;

export declare const children: ReadonlyMap<string, import("./core/index.js").ChildHandle>;
export declare function getChild<
  T extends import("./core/index.js").Rpc.ExposedMethods = import("./core/index.js").Rpc.ExposedMethods,
  E extends import("./core/index.js").Rpc.RpcEventMap = import("./core/index.js").Rpc.RpcEventMap
>(name: string): import("./core/index.js").ChildHandle<T, E> | undefined;
export declare function onChildAdded(
  callback: (name: string, handle: import("./core/index.js").ChildHandle) => void
): () => void;
export declare function onChildRemoved(callback: (childId: string) => void): () => void;

export declare function removeChild(childId: string): Promise<void>;
export declare function setTitle(title: string): Promise<void>;
export declare function close(): Promise<void>;
export declare function getEnv(): Promise<Record<string, string>>;
export declare function getInfo(): Promise<import("./core/index.js").EndpointInfo>;

export declare function getTheme(): import("./types.js").ThemeAppearance;
export declare function onThemeChange(
  callback: (theme: import("./types.js").ThemeAppearance) => void
): () => void;

export declare function onFocus(callback: () => void): () => void;

export declare const expose: <T extends import("./core/index.js").Rpc.ExposedMethods>(methods: T) => void;

export declare const gitConfig: import("./core/index.js").GitConfig | null;
/** Promise that resolves when bootstrap completes. Resolves to null if no bootstrap needed. */
export declare const bootstrapPromise: Promise<import("./types.js").BootstrapResult | null>;

export declare const Rpc: typeof import("./core/rpc.js");
export declare namespace Rpc {
  export type PanelRpcRequest = import("./core/rpc.js").PanelRpcRequest;
  export type PanelRpcResponse = import("./core/rpc.js").PanelRpcResponse;
  export type PanelRpcEvent = import("./core/rpc.js").PanelRpcEvent;
  export type PanelRpcMessage = import("./core/rpc.js").PanelRpcMessage;

  export type SchemaType = import("./core/rpc.js").SchemaType;
  export type MethodSchema = import("./core/rpc.js").MethodSchema;
  export type PanelRpcSchema = import("./core/rpc.js").PanelRpcSchema;

  export type PanelRpcIpcApi = import("./core/rpc.js").PanelRpcIpcApi;

  export type AnyFunction = import("./core/rpc.js").AnyFunction;
  export type ExposedMethods = import("./core/rpc.js").ExposedMethods;
  export type RpcEventMap = import("./core/rpc.js").RpcEventMap;

  export type PanelRpcHandle<
    T extends ExposedMethods = ExposedMethods,
    E extends RpcEventMap = RpcEventMap
  > = import("./core/rpc.js").PanelRpcHandle<T, E>;
}
export declare const z: typeof import("./core/zod.js").z;
export declare const defineContract: typeof import("./core/defineContract.js").defineContract;
export declare const noopParent: typeof import("./core/defineContract.js").noopParent;

export declare const encodeBase64: typeof import("./shared/base64.js").encodeBase64;
export declare const decodeBase64: typeof import("./shared/base64.js").decodeBase64;
