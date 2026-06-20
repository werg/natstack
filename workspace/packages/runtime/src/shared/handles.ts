import type { RpcClient, RpcEventContext } from "@natstack/rpc";
import type { PanelLifecycleResult } from "@natstack/shared/types";
import type {
  CdpAutomation,
  PanelContract,
  PanelHandle,
  PanelHandleContractRole,
  PanelHandleFromContract,
  PanelNavigateOptions,
  Rpc,
  TypedCallProxy,
} from "../core/index.js";

export interface PanelHandleMetadata {
  id: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  contextId?: string | null;
  rpcTargetId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
}

export interface PanelHandleHostOps {
  refresh?(id: string): Promise<PanelHandleMetadata>;
  children?(id: string): Promise<PanelHandle[]>;
  parent?(id: string, parentId: string | null): PanelHandle | null;
  ensureLoaded?(id: string): Promise<unknown>;
  isLoaded?(id: string): Promise<boolean>;
  navigate?(
    id: string,
    source: string,
    options?: PanelNavigateOptions
  ): Promise<{ id: string; title: string }>;
  reload?(id: string): Promise<PanelLifecycleResult>;
  close?(id: string): Promise<PanelLifecycleResult>;
  archive?(id: string): Promise<void>;
  unload?(id: string): Promise<PanelLifecycleResult>;
  movePanel?(id: string, newParentId: string | null, targetPosition: number): Promise<void>;
  takeOver?(id: string): Promise<void>;
  openDevTools?(id: string, mode?: "detach" | "right" | "bottom"): Promise<void>;
  rebuildPanel?(id: string): Promise<PanelLifecycleResult>;
  rebuildAndReload?(id: string): Promise<PanelLifecycleResult>;
  updatePanelState?(id: string, state: Record<string, unknown>): Promise<void>;
  focus?(id: string): Promise<unknown>;
  stateArgs?: {
    get<T = Record<string, unknown>>(id: string): Promise<T>;
    set(id: string, updates: Record<string, unknown>): Promise<void>;
  };
  snapshot?(id: string): Promise<unknown>;
  callAgent?(id: string, method: string, args: unknown[]): Promise<unknown>;
}

type PanelHandleRpc = Pick<RpcClient, "call" | "emit" | "on">;
type RpcTargetResolver = string | (() => string | Promise<string>);

export function createCallProxy<T extends Rpc.ExposedMethods>(
  rpc: Pick<RpcClient, "call">,
  targetId: RpcTargetResolver
): TypedCallProxy<T> {
  return new Proxy({} as TypedCallProxy<T>, {
    get(_target, method: string) {
      return async (...args: unknown[]) => {
        const resolvedTargetId =
          typeof targetId === "function" ? await targetId() : targetId;
        return rpc.call(resolvedTargetId, method, [...args]);
      };
    },
  });
}

export function createPanelHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
>(options: {
  rpc: PanelHandleRpc;
  metadata: PanelHandleMetadata;
  cdp: CdpAutomation;
  ops?: PanelHandleHostOps;
}): PanelHandle<T, E, EmitE> {
  const { rpc, cdp, ops } = options;
  let metadata = normalizeMetadata(options.metadata);
  let rpcTargetResolvePromise: Promise<string> | null = null;
  let rpcEventTargetId: string | null = metadata.rpcTargetId ?? (!ops?.refresh ? metadata.id : null);
  const refreshMetadata = async (): Promise<Required<PanelHandleMetadata>> => {
    if (ops?.refresh) {
      metadata = normalizeMetadata({ ...metadata, ...(await ops.refresh(metadata.id)) });
    }
    // Use the same non-null fallback as resolveRpcTargetId: a manual refresh of
    // a still-unloaded refreshable handle must not reset the event target to
    // null, which would silently kill any active .on() subscription's filter.
    rpcEventTargetId = metadata.rpcTargetId ?? metadata.id;
    rpcTargetResolvePromise = null;
    return metadata;
  };
  const resolveRpcTargetId = async (): Promise<string> => {
    if (metadata.rpcTargetId) return metadata.rpcTargetId;
    if (!ops?.refresh) return metadata.id;
    rpcTargetResolvePromise ??= refreshMetadata().then((fresh) => {
      const targetId = fresh.rpcTargetId ?? fresh.id;
      rpcEventTargetId = targetId;
      return targetId;
    });
    return rpcTargetResolvePromise;
  };
  const call = createCallProxy<T>(rpc, resolveRpcTargetId);

  const handle: PanelHandle<T, E, EmitE> = {
    get id() {
      return metadata.id;
    },
    get title() {
      return metadata.title;
    },
    get source() {
      return metadata.source;
    },
    get kind() {
      return metadata.kind;
    },
    get parentId() {
      return metadata.parentId;
    },
    getInfo: async () => ({
      id: metadata.id,
      title: metadata.title,
      source: metadata.source,
      kind: metadata.kind,
      parentId: metadata.parentId,
      contextId: metadata.contextId,
      runtimeEntityId: metadata.rpcTargetId,
      effectiveVersion: metadata.effectiveVersion,
      ref: metadata.ref ?? undefined,
      build: {
        effectiveVersion: metadata.effectiveVersion,
        ref: metadata.ref ?? undefined,
      },
    }),
    call,
    cdp,
    click: (selector: string) => cdp.click(selector),
    diagnostics: async (options) => ({
      info: await handle.getInfo(),
      consoleHistory: await cdp.consoleHistory(options),
    }),
    stateArgs: {
      get: async <TState = Record<string, unknown>>() => {
        if (!ops?.stateArgs?.get) return {} as TState;
        return ops.stateArgs.get<TState>(metadata.id);
      },
      set: async (updates: Record<string, unknown>) => {
        if (!ops?.stateArgs?.set) {
          throw new Error("stateArgs.set is not available for this handle");
        }
        await ops.stateArgs.set(metadata.id, updates);
      },
    },
    async emit(event: string, payload: unknown) {
      await rpc.emit(await resolveRpcTargetId(), event, payload);
    },
    on(event: string, listener: (payload: unknown) => void): () => void {
      if (!rpcEventTargetId) {
        void resolveRpcTargetId().catch(() => undefined);
      }
      return rpc.on(event, (ev: RpcEventContext) => {
        const targetId = rpcEventTargetId;
        if (targetId && ev.caller.callerId === targetId) listener(ev.payload);
      });
    },
    withContract<C extends PanelContract, Role extends PanelHandleContractRole>(
      _contract: C,
      _role: Role
    ): PanelHandleFromContract<C, Role> {
      return handle as unknown as PanelHandleFromContract<C, Role>;
    },
    async refresh() {
      await refreshMetadata();
      return handle;
    },
    children: () => ops?.children?.(metadata.id) ?? Promise.resolve([]),
    parent: () => ops?.parent?.(metadata.id, metadata.parentId) ?? null,
    ensureLoaded: async () => {
      const result = await (ops?.ensureLoaded?.(metadata.id) ??
        Promise.resolve({ loaded: false }));
      if (ops?.refresh) await refreshMetadata();
      return result;
    },
    isLoaded: () => ops?.isLoaded?.(metadata.id) ?? Promise.resolve(false),
    navigate: async (source: string, options?: PanelNavigateOptions) => {
      if (!ops?.navigate) throw new Error("navigate is not available for this handle");
      const result = await ops.navigate(metadata.id, source, options);
      if (ops?.refresh) {
        await refreshMetadata().catch(() => undefined);
      }
      return result;
    },
    reload: async () => {
      if (!ops?.reload) throw new Error("reload is not available for this handle");
      return ops.reload(metadata.id);
    },
    close: async () => {
      if (!ops?.close) throw new Error("close is not available for this handle");
      return ops.close(metadata.id);
    },
    archive: async () => {
      if (!ops?.archive) throw new Error("archive is not available for this handle");
      await ops.archive(metadata.id);
    },
    unload: async () => {
      if (!ops?.unload) throw new Error("unload is not available for this handle");
      return ops.unload(metadata.id);
    },
    movePanel: async (newParentId: string | null, targetPosition: number) => {
      if (!ops?.movePanel) throw new Error("movePanel is not available for this handle");
      await ops.movePanel(metadata.id, newParentId, targetPosition);
    },
    takeOver: async () => {
      if (!ops?.takeOver) throw new Error("takeOver is not available for this handle");
      await ops.takeOver(metadata.id);
    },
    openDevTools: async (mode?: "detach" | "right" | "bottom") => {
      if (!ops?.openDevTools) throw new Error("openDevTools is not available for this handle");
      await ops.openDevTools(metadata.id, mode);
    },
    rebuildPanel: async () => {
      if (!ops?.rebuildPanel) throw new Error("rebuildPanel is not available for this handle");
      return ops.rebuildPanel(metadata.id);
    },
    rebuildAndReload: async () => {
      if (!ops?.rebuildAndReload) {
        throw new Error("rebuildAndReload is not available for this handle");
      }
      return ops.rebuildAndReload(metadata.id);
    },
    updatePanelState: async (state: Record<string, unknown>) => {
      if (!ops?.updatePanelState) {
        throw new Error("updatePanelState is not available for this handle");
      }
      await ops.updatePanelState(metadata.id, state);
    },
    focus: () => ops?.focus?.(metadata.id) ?? Promise.resolve(undefined),
    snapshot: () => ops?.snapshot?.(metadata.id) ?? Promise.resolve(undefined),
    tree: () => ops?.callAgent?.(metadata.id, "_agent.tree", []) ?? Promise.resolve(undefined),
    state: () => ops?.callAgent?.(metadata.id, "_agent.state", []) ?? Promise.resolve(undefined),
    routes: () => ops?.callAgent?.(metadata.id, "_agent.routes", []) ?? Promise.resolve(undefined),
    setMode: (mode: "fixture" | "live") =>
      ops?.callAgent?.(metadata.id, "_agent.setMode", [mode]) ?? Promise.resolve(undefined),
  } as PanelHandle<T, E, EmitE>;

  return handle;
}

export function unavailableCdp(id: string): CdpAutomation {
  const unavailable = () => Promise.reject(new Error(`CDP is not available for panel ${id}`));
  return {
    lightweightPage: unavailable,
    consoleHistory: unavailable,
    getCdpEndpoint: unavailable,
    navigate: unavailable,
    goBack: unavailable,
    goForward: unavailable,
    reload: unavailable,
    stop: unavailable,
    click: unavailable,
    screenshot: unavailable,
  };
}

export function createNoPanelHandle(): PanelHandle {
  const noParent = () => Promise.reject(new Error("No parent panel"));
  const handle: PanelHandle = {
    id: "",
    title: "",
    source: "",
    kind: "workspace",
    parentId: null,
    getInfo: () =>
      Promise.resolve({
        id: "",
        title: "",
        source: "",
        kind: "workspace",
        parentId: null,
        contextId: null,
        runtimeEntityId: null,
        effectiveVersion: null,
        build: { effectiveVersion: null },
      }),
    call: new Proxy({} as PanelHandle["call"], {
      get: () => noParent,
    }),
    cdp: unavailableCdp("parent"),
    click: noParent,
    diagnostics: noParent,
    stateArgs: {
      get: <TState = Record<string, unknown>>() => Promise.resolve({} as TState),
      set: noParent,
    },
    emit: noParent,
    on: () => () => {},
    withContract: () => handle as never,
    refresh: () => Promise.resolve(handle),
    children: () => Promise.resolve([]),
    parent: () => null,
    ensureLoaded: () => Promise.resolve({ loaded: false }),
    isLoaded: () => Promise.resolve(false),
    navigate: noParent,
    reload: noParent,
    close: noParent,
    archive: noParent,
    unload: noParent,
    movePanel: noParent,
    takeOver: noParent,
    openDevTools: noParent,
    rebuildPanel: noParent,
    rebuildAndReload: noParent,
    updatePanelState: noParent,
    focus: () => Promise.resolve(undefined),
    snapshot: () => Promise.resolve(undefined),
    tree: () => Promise.resolve(undefined),
    state: () => Promise.resolve(undefined),
    routes: () => Promise.resolve(undefined),
    setMode: () => Promise.resolve(undefined),
  };
  return handle;
}

export interface ParentHandleApi {
  readonly parent: PanelHandle;
  getParent<
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  >(): PanelHandle<T, E, EmitE> | null;
  getParentWithContract<C extends PanelContract>(
    contract: C
  ): PanelHandleFromContract<C, "parent"> | null;
}

/**
 * Resolve a parent PanelHandle from launch metadata, portable across every
 * target (panel/worker/eval). A `panel` parent resolves to a real panel handle
 * via `getPanelHandle`; a `worker`/`do` parent resolves to a non-panel handle
 * (RPC-callable, not panel-navigable); no parent → null. Generalized from the
 * worker's former `createWorkerParentPanelHandle` so eval can reuse it.
 */
export function createRuntimeParentHandle(
  getPanelHandle: (id: string) => PanelHandle,
  parentId: string | null,
  parentEntityId: string | null,
  parentKind: "panel" | "worker" | "do" | null
): PanelHandle | null {
  if (!parentId) return null;
  if (parentKind === "panel") return getPanelHandle(parentId);
  if (parentKind === "worker" || parentKind === "do") {
    return createNonPanelRuntimeHandle({ id: parentEntityId ?? parentId });
  }
  if (parentId.startsWith("worker:") || parentId.startsWith("do:")) {
    return createNonPanelRuntimeHandle({ id: parentId });
  }
  return getPanelHandle(parentId);
}

export function createParentHandleApi(resolveParent: () => PanelHandle | null): ParentHandleApi {
  const parent = resolveParent() ?? createNoPanelHandle();
  const getParent = <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  >(): PanelHandle<T, E, EmitE> | null => {
    return resolveParent() as PanelHandle<T, E, EmitE> | null;
  };
  const getParentWithContract = <C extends PanelContract>(
    contract: C
  ): PanelHandleFromContract<C, "parent"> | null => {
    return getParent()?.withContract(contract, "parent") ?? null;
  };
  return { parent, getParent, getParentWithContract };
}

export function createNonPanelRuntimeHandle(options: {
  id: string;
  title?: string;
  source?: string;
  parentId?: string | null;
  parent?: () => PanelHandle | null;
}): PanelHandle {
  const unavailable = () => Promise.reject(new Error(`${options.id} is not a panel target`));
  const handle: PanelHandle = {
    id: options.id,
    title: options.title ?? options.id,
    source: options.source ?? options.id,
    kind: "workspace",
    parentId: options.parentId ?? null,
    getInfo: () =>
      Promise.resolve({
        id: options.id,
        title: options.title ?? options.id,
        source: options.source ?? options.id,
        kind: "workspace",
        parentId: options.parentId ?? null,
        contextId: null,
        runtimeEntityId: options.id,
        effectiveVersion: null,
        build: { effectiveVersion: null },
      }),
    call: new Proxy({} as PanelHandle["call"], {
      get: () => unavailable,
    }),
    cdp: unavailableCdp(options.id),
    click: unavailable,
    diagnostics: unavailable,
    stateArgs: {
      get: <TState = Record<string, unknown>>() => Promise.resolve({} as TState),
      set: unavailable,
    },
    emit: unavailable,
    on: () => () => {},
    withContract: () => handle as never,
    refresh: () => Promise.resolve(handle),
    children: () => Promise.resolve([]),
    parent: () => options.parent?.() ?? null,
    ensureLoaded: () => Promise.resolve({ loaded: false }),
    isLoaded: () => Promise.resolve(false),
    navigate: unavailable,
    reload: unavailable,
    close: unavailable,
    archive: unavailable,
    unload: unavailable,
    movePanel: unavailable,
    takeOver: unavailable,
    openDevTools: unavailable,
    rebuildPanel: unavailable,
    rebuildAndReload: unavailable,
    updatePanelState: unavailable,
    focus: () => Promise.resolve(undefined),
    snapshot: () => Promise.resolve(undefined),
    tree: () => Promise.resolve(undefined),
    state: () => Promise.resolve(undefined),
    routes: () => Promise.resolve(undefined),
    setMode: () => Promise.resolve(undefined),
  };
  return handle;
}

function normalizeMetadata(metadata: PanelHandleMetadata): Required<PanelHandleMetadata> {
  const kind = metadata.kind ?? (metadata.source?.startsWith("browser:") ? "browser" : "workspace");
  const source = stripBrowserPrefix(metadata.source ?? metadata.id);
  return {
    id: metadata.id,
    title: metadata.title ?? metadata.id,
    source,
    kind,
    parentId: metadata.parentId ?? null,
    contextId: metadata.contextId ?? null,
    rpcTargetId: metadata.rpcTargetId ?? null,
    effectiveVersion: metadata.effectiveVersion ?? null,
    ref: metadata.ref ?? null,
  };
}

function stripBrowserPrefix(source: string): string {
  return source.startsWith("browser:") ? source.slice("browser:".length) : source;
}
