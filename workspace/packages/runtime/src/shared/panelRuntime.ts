import type { RpcClient } from "@natstack/rpc";
import type { PanelLifecycleResult } from "@natstack/shared/types";
import type { PanelHandle, PanelNavigateOptions } from "../core/index.js";
import { createCdpAutomation, type CdpAutomation } from "../panel/cdpAutomation.js";
import {
  createNonPanelRuntimeHandle,
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "./handles.js";

export interface PanelRuntimeListItem {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
  children?: PanelRuntimeListItem[];
}

interface PanelRuntimeMetadataResult {
  id?: string;
  title?: string;
  source?: string;
  kind?: "workspace" | "browser";
  parentId?: string | null;
  runtimeEntityId?: string | null;
  contextId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
}

export interface OpenPanelOptions {
  parentId?: string | null;
  name?: string;
  focus?: boolean;
  stateArgs?: Record<string, unknown>;
}

export interface PanelRuntimeTree {
  self(): PanelHandle;
  get(id: string, kind?: "workspace" | "browser"): PanelHandle;
  list(): Promise<PanelHandle[]>;
  roots(): Promise<PanelHandle[]>;
  children(id: string): Promise<PanelHandle[]>;
  parent(id: string): PanelHandle | null;
  navigate(
    id: string,
    source: string,
    options?: PanelNavigateOptions
  ): Promise<{ id: string; title: string }>;
}

export interface PanelRuntimeApi {
  panelTree: PanelRuntimeTree;
  openPanel(source: string, options?: OpenPanelOptions): Promise<PanelHandle>;
  listPanels(): Promise<PanelHandle[]>;
  getPanelHandle(id: string, kind?: "workspace" | "browser"): PanelHandle;
  fromMetadata(metadata: PanelHandleMetadata): PanelHandle;
}

export interface CreatePanelRuntimeOptions {
  rpc: Pick<RpcClient, "call" | "emit" | "on">;
  selfId?: string | null;
  selfRpcTargetId?: string | null;
  parentId?: string | null;
  defaultOpenParentId?: string | null | (() => string | null);
  effectiveVersion?: string | null;
  requesterPanelId?: string | null | (() => string | null);
  selfHandle?: () => PanelHandle;
  createCdp?: (metadata: PanelHandleMetadata) => CdpAutomation;
  initialMetadata?: PanelHandleMetadata[];
  onOpen?: (entry: { source: string; id: string; kind: "workspace" | "browser" }) => void;
  onReload?: (id: string) => void;
  onClose?: (id: string) => void;
  onStateArgsSet?: (id: string) => void;
}

export function createPanelRuntime(options: CreatePanelRuntimeOptions): PanelRuntimeApi {
  const metadataCache = new Map<string, PanelHandleMetadata>();
  const callPanel = <T>(method: string, args: unknown[]): Promise<T> =>
    options.rpc.call<T>("main", `panelTree.${method}`, args);

  const defaultOpenParentId = (): string | null => {
    const value = options.defaultOpenParentId;
    return typeof value === "function" ? value() : (value ?? null);
  };

  const requesterPanelId = (): string | null => {
    const value = options.requesterPanelId;
    return typeof value === "function" ? value() : (value ?? null);
  };

  const rememberMetadata = (metadata: PanelHandleMetadata): PanelHandleMetadata => {
    const next = { ...(metadataCache.get(metadata.id) ?? {}), ...metadata };
    metadataCache.set(metadata.id, next);
    return next;
  };

  const metadataForId = (
    id: string,
    overrides: Partial<PanelHandleMetadata> = {}
  ): PanelHandleMetadata => {
    const cached = metadataCache.get(id);
    const kind = overrides.kind ?? cached?.kind ?? "workspace";
    return rememberMetadata({
      id,
      title: id,
      source: kind === "browser" ? `browser:${id}` : id,
      kind,
      parentId: null,
      ...(cached ?? {}),
      ...overrides,
    });
  };

  const itemToMetadata = (item: PanelRuntimeListItem): PanelHandleMetadata =>
    rememberMetadata({
      id: item.panelId,
      title: item.title,
      source: item.source,
      kind: item.kind,
      parentId: item.parentId,
      contextId: item.contextId,
      rpcTargetId: item.runtimeEntityId ?? null,
      effectiveVersion: item.effectiveVersion ?? null,
      ref: item.ref ?? null,
    });

  const metadataFromResult = (
    id: string,
    meta: PanelRuntimeMetadataResult
  ): PanelHandleMetadata => ({
    id,
    title: meta.title,
    source: meta.source,
    kind: meta.kind,
    parentId: meta.parentId,
    contextId: meta.contextId ?? null,
    rpcTargetId: meta.runtimeEntityId ?? null,
    effectiveVersion: meta.effectiveVersion ?? null,
    ref: meta.ref ?? null,
  });

  const createCdp = (metadata: PanelHandleMetadata): CdpAutomation =>
    options.createCdp?.(metadata) ??
    createCdpAutomation(options.rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId: requesterPanelId(),
    });

  for (const metadata of options.initialMetadata ?? []) {
    rememberMetadata(metadata);
  }

  const ops: PanelHandleHostOps = {
    refresh: async (id) => {
      const meta = await callPanel<PanelRuntimeMetadataResult | null>("metadata", [id]);
      return meta ? rememberMetadata(metadataFromResult(id, meta)) : metadataForId(id);
    },
    children: (id) => panelTree.children(id),
    parent: (id, parentId) => {
      const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
      return resolvedParentId ? panelTree.get(resolvedParentId) : null;
    },
    ensureLoaded: (id) => callPanel("ensureLoaded", [id]),
    isLoaded: async (id) => {
      try {
        const lease = await callPanel<{ leased?: boolean } | null>("getRuntimeLease", [id]);
        return Boolean(lease?.leased);
      } catch {
        return false;
      }
    },
    reload: async (id) => {
      const result = await callPanel<PanelLifecycleResult>("reload", [id]);
      options.onReload?.(id);
      return result;
    },
    close: async (id) => {
      const result = await callPanel<PanelLifecycleResult>("close", [id]);
      options.onClose?.(id);
      return result;
    },
    archive: async (id) => {
      await callPanel("archive", [id]);
      options.onClose?.(id);
    },
    unload: (id) => callPanel<PanelLifecycleResult>("unload", [id]),
    navigate: (id, source, navigateOptions) =>
      callPanel<{ id: string; title: string }>("navigate", [id, source, navigateOptions]),
    movePanel: (id, newParentId, targetPosition) =>
      callPanel("movePanel", [{ panelId: id, newParentId, targetPosition }]),
    takeOver: (id) => callPanel("takeOver", [id]),
    openDevTools: (id, mode) => callPanel("openDevTools", [id, mode]),
    rebuildPanel: (id) => callPanel<PanelLifecycleResult>("rebuildPanel", [id]),
    rebuildAndReload: async (id) => {
      const result = await callPanel<PanelLifecycleResult>("rebuildAndReload", [id]);
      options.onReload?.(id);
      return result;
    },
    updatePanelState: (id, state) => callPanel("updatePanelState", [id, state]),
    focus: (id) => callPanel("focus", [id]),
    stateArgs: {
      get: (id) => callPanel("getStateArgs", [id]),
      set: async (id, updates) => {
        await callPanel("setStateArgs", [id, updates]);
        options.onStateArgsSet?.(id);
      },
    },
    snapshot: (id) => callPanel("snapshot", [id]),
    callAgent: (id, method, args) => callPanel("callAgent", [id, method, args]),
  };

  const fromMetadata = (input: PanelHandleMetadata): PanelHandle => {
    const metadata = rememberMetadata(input);
    return createPanelHandle({
      rpc: options.rpc,
      metadata,
      cdp: createCdp(metadata),
      ops,
    });
  };

  const hydrate = (item: PanelRuntimeListItem): PanelHandle => fromMetadata(itemToMetadata(item));

  const flatten = (items: PanelRuntimeListItem[]): PanelRuntimeListItem[] => {
    const out: PanelRuntimeListItem[] = [];
    const visit = (item: PanelRuntimeListItem) => {
      out.push(item);
      for (const child of item.children ?? []) visit(child);
    };
    for (const item of items) visit(item);
    return out;
  };

  const panelTree: PanelRuntimeTree = {
    self() {
      if (options.selfHandle) return options.selfHandle();
      if (!options.selfId) {
        throw new Error("panelTree.self() is not available before runtime init");
      }
      return createPanelHandle({
        rpc: options.rpc,
        metadata: {
          id: options.selfId,
          title: options.selfId,
          source: options.selfId,
          kind: "workspace",
          parentId: options.parentId ?? null,
          rpcTargetId: options.selfRpcTargetId ?? options.selfId,
          effectiveVersion: options.effectiveVersion ?? null,
        },
        cdp: createCdp({
          id: options.selfId,
          kind: "workspace",
          parentId: options.parentId ?? null,
        }),
        ops,
      });
    },
    get(id, kind) {
      const metadata = metadataForId(id, kind ? { kind } : {});
      return fromMetadata(metadata);
    },
    async list() {
      return flatten(await callPanel<PanelRuntimeListItem[]>("list", [null])).map(hydrate);
    },
    async roots() {
      return (await callPanel<PanelRuntimeListItem[]>("roots", [])).map(hydrate);
    },
    async children(id) {
      return (await callPanel<PanelRuntimeListItem[]>("list", [id])).map(hydrate);
    },
    parent(id) {
      const parentId =
        options.selfId && id === options.selfId
          ? (options.parentId ?? metadataCache.get(id)?.parentId)
          : metadataCache.get(id)?.parentId;
      return parentId ? panelTree.get(parentId) : null;
    },
    navigate(id, source, navigateOptions) {
      return callPanel("navigate", [id, source, navigateOptions]);
    },
  };

  const openPanel = async (source: string, openOptions?: OpenPanelOptions): Promise<PanelHandle> => {
    const parentId =
      openOptions?.parentId !== undefined ? openOptions.parentId : defaultOpenParentId();
    const result = await callPanel<{
      id: string;
      title: string;
      kind: "workspace" | "browser";
      runtimeEntityId?: string | null;
      effectiveVersion?: string | null;
    }>("create", [source, { ...openOptions, parentId }]);
    const handle = hydrate({
      panelId: result.id,
      title: result.title,
      source: result.kind === "browser" ? `browser:${source}` : source,
      kind: result.kind,
      parentId,
      contextId: "",
      runtimeEntityId: result.runtimeEntityId ?? null,
      effectiveVersion: result.effectiveVersion ?? null,
    });
    options.onOpen?.({ source, id: handle.id, kind: handle.kind });
    return handle;
  };

  return {
    panelTree,
    openPanel,
    listPanels: () => panelTree.list(),
    getPanelHandle: (id, kind) => panelTree.get(id, kind),
    fromMetadata,
  };
}

export function createRuntimeSelfHandle(options: {
  id: string;
  parentId?: string | null;
  parent?: () => PanelHandle | null;
}): PanelHandle {
  return createNonPanelRuntimeHandle(options);
}
