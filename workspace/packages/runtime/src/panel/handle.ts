import type { RpcClient, RpcEventContext } from "@natstack/rpc";
import type { PanelLifecycleResult } from "@natstack/shared/types";
import type { PanelHandle as CorePanelHandle, Rpc } from "../core/index.js";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { createCdpAutomation } from "./cdpAutomation.js";
import {
  createPanelHandle,
  type PanelHandleHostOps,
  type PanelHandleMetadata,
} from "../shared/handles.js";
import { currentJournal } from "./journal.js";

export interface PanelListItem {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
  runtimeEntityId?: string | null;
  effectiveVersion?: string | null;
  ref?: string | null;
}

export type PanelHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
> = CorePanelHandle<T, E, EmitE>;

export interface PanelTreeApi {
  self(): PanelHandle;
  get(id: string): PanelHandle;
  list(): Promise<PanelHandle[]>;
  roots(): Promise<PanelHandle[]>;
  children(id: string): Promise<PanelHandle[]>;
  parent(id: string): PanelHandle | null;
  open(
    source: string,
    options?: {
      parentId?: string | null;
      name?: string;
      focus?: boolean;
      stateArgs?: Record<string, unknown>;
    }
  ): Promise<PanelHandle>;
}

type PanelRuntimeRpc = Pick<RpcClient, "call" | "emit" | "on">;

let _rpc: PanelRuntimeRpc | null = null;
let _selfId: string | null = null;
let _selfRpcTargetId: string | null = null;
let _parentId: string | null = null;
let _parentRpcTargetId: string | null = null;
const metadataCache = new Map<string, PanelHandleMetadata>();
const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

export function _initPanelHandleBridge(
  rpc: PanelRuntimeRpc,
  options: {
    selfId?: string | null;
    selfRpcTargetId?: string | null;
    parentId?: string | null;
    parentRpcTargetId?: string | null;
    effectiveVersion?: string | null;
  } = {}
): void {
  _rpc = rpc;
  _selfId = options.selfId ?? _selfId;
  _selfRpcTargetId = options.selfRpcTargetId ?? _selfRpcTargetId ?? _selfId;
  _parentId = options.parentId ?? _parentId;
  _parentRpcTargetId = options.parentRpcTargetId ?? _parentRpcTargetId ?? _parentId;
  if (_selfId) {
    rememberMetadata({
      id: _selfId,
      title: _selfId,
      source: _selfId,
      parentId: _parentId,
      rpcTargetId: _selfRpcTargetId ?? _selfId,
      effectiveVersion: options.effectiveVersion ?? null,
    });
  }
  if (_parentId) {
    rememberMetadata({
      id: _parentId,
      title: _parentId,
      source: _parentId,
      parentId: null,
      rpcTargetId: _parentRpcTargetId ?? _parentId,
    });
  }
}

function getRpc(): PanelRuntimeRpc {
  if (!_rpc) throw new Error("Panel bridge not initialized");
  return _rpc;
}

async function panelCall<T>(method: string, args: unknown[]): Promise<T> {
  return getRpc().call<T>("main", `panelTree.${method}`, args);
}

function itemToMetadata(item: PanelListItem): PanelHandleMetadata {
  return {
    id: item.panelId,
    title: item.title,
    source: item.source,
    kind: item.kind ?? (item.source.startsWith("browser:") ? "browser" : "workspace"),
    parentId: item.parentId,
    contextId: item.contextId,
    rpcTargetId: item.runtimeEntityId ?? item.panelId,
    effectiveVersion: item.effectiveVersion ?? null,
    ref: item.ref ?? null,
  };
}

function rememberMetadata(metadata: PanelHandleMetadata): PanelHandleMetadata {
  const next = { ...(metadataCache.get(metadata.id) ?? {}), ...metadata };
  metadataCache.set(metadata.id, next);
  return next;
}

function metadataForId(id: string, fallback?: Partial<PanelHandleMetadata>): PanelHandleMetadata {
  const kind = fallback?.kind ?? metadataCache.get(id)?.kind ?? "workspace";
  return rememberMetadata({
    id,
    title: id,
    source: kind === "browser" ? `browser:${id}` : id,
    kind,
    parentId: null,
    ...(metadataCache.get(id) ?? {}),
    ...(fallback ?? {}),
  });
}

const ops: PanelHandleHostOps = {
  refresh: async (id) => {
    const all = await flattenPanels(await panelCall<PanelListItem[]>("list", [null]));
    const found = all.find((item) => item.panelId === id);
    return found ? rememberMetadata(itemToMetadata(found)) : metadataForId(id);
  },
  children: (id) => panelTree.children(id),
  parent: (id, parentId) => {
    const resolvedParentId = parentId ?? metadataCache.get(id)?.parentId ?? null;
    return resolvedParentId ? getPanelHandle(resolvedParentId) : null;
  },
  ensureLoaded: (id) => panelCall("ensureLoaded", [id]),
  isLoaded: async (id) => {
    try {
      const lease = await panelCall<{ leased?: boolean } | null>("getRuntimeLease", [id]);
      return Boolean(lease?.leased);
    } catch {
      return false;
    }
  },
  reload: async (id) => {
    const result = await panelCall<PanelLifecycleResult>("reload", [id]);
    currentJournal()?.append({ type: "reload", id });
    return result;
  },
  close: async (id) => {
    const result = await panelCall<PanelLifecycleResult>("close", [id]);
    currentJournal()?.append({ type: "close", id });
    return result;
  },
  archive: async (id) => {
    await panelCall("archive", [id]);
    currentJournal()?.append({ type: "close", id });
  },
  unload: (id) => panelCall<PanelLifecycleResult>("unload", [id]),
  movePanel: (id, newParentId, targetPosition) =>
    panelCall("movePanel", [{ panelId: id, newParentId, targetPosition }]),
  takeOver: (id) => panelCall("takeOver", [id]),
  openDevTools: (id, mode) => panelCall("openDevTools", [id, mode]),
  rebuildPanel: (id) => panelCall<PanelLifecycleResult>("rebuildPanel", [id]),
  rebuildAndReload: async (id) => {
    const result = await panelCall<PanelLifecycleResult>("rebuildAndReload", [id]);
    currentJournal()?.append({ type: "reload", id });
    return result;
  },
  updatePanelState: (id, state) => panelCall("updatePanelState", [id, state]),
  focus: (id) => panelCall("focus", [id]),
  stateArgs: {
    get: (id) => panelCall("getStateArgs", [id]),
    set: async (id, updates) => {
      await panelCall("setStateArgs", [id, updates]);
      currentJournal()?.append({ type: "stateArgs.set", id });
    },
  },
  snapshot: (id) => panelCall("snapshot", [id]),
  callAgent: (id, method, args) => panelCall("callAgent", [id, method, args]),
};

export function hydratePanelHandle(item: PanelListItem): PanelHandle {
  const rpc = getRpc();
  const metadata = rememberMetadata(itemToMetadata(item));
  return createPanelHandle({
    rpc,
    metadata,
    cdp: createCdpAutomation(rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId: _selfId,
    }),
    ops,
  });
}

export async function openPanel(
  source: string,
  options?: {
    parentId?: string | null;
    name?: string;
    focus?: boolean;
    stateArgs?: Record<string, unknown>;
  }
): Promise<PanelHandle> {
  return panelTree.open(source, options);
}

export async function listPanels(): Promise<PanelHandle[]> {
  return panelTree.list();
}

export async function openExternal(
  url: string,
  options?: OpenExternalOptions
): Promise<OpenExternalResult> {
  return getRpc().call<OpenExternalResult>("main", "externalOpen.openExternal", [url, options]);
}

export function onChildCreated(
  handler: (info: { childId: string; url: string }) => void
): () => void {
  const unsubs: Array<() => void> = [];
  if (shell?.addEventListener) {
    const listenerId = shell.addEventListener((event: string, payload: unknown) => {
      if (event === "runtime:child-created") {
        const data = payload as { childId?: string; url?: string } | null;
        if (data?.childId && data?.url) handler({ childId: data.childId, url: data.url });
      }
    });
    unsubs.push(() => shell.removeEventListener(listenerId));
  }
  const rpc = getRpc();
  unsubs.push(
    rpc.on("runtime:child-created", (event: RpcEventContext) => {
      const data = event.payload as { childId?: string; url?: string } | null;
      if (data?.childId && data?.url) handler({ childId: data.childId, url: data.url });
    })
  );
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function getPanelHandle(
  id: string,
  kind: "workspace" | "browser" = "workspace"
): PanelHandle {
  const rpc = getRpc();
  const metadata = metadataForId(id, { kind });
  return createPanelHandle({
    rpc,
    metadata,
    cdp: createCdpAutomation(rpc, metadata.id, {
      kind: metadata.kind,
      requesterPanelId: _selfId,
    }),
    ops,
  });
}

export const panelTree: PanelTreeApi = {
  self() {
    if (!_selfId) throw new Error("panelTree.self() is not available before runtime init");
    const rpc = getRpc();
    return createPanelHandle({
      rpc,
      metadata: {
        id: _selfId,
        title: _selfId,
        source: _selfId,
        kind: "workspace",
        parentId: _parentId,
        rpcTargetId: _selfRpcTargetId ?? _selfId,
      },
      cdp: createCdpAutomation(rpc, _selfId, {
        kind: "workspace",
        requesterPanelId: _selfId,
      }),
      ops,
    });
  },
  get(id: string) {
    return getPanelHandle(id);
  },
  async list() {
    const panels = await flattenPanels(await panelCall<PanelListItem[]>("list", [null]));
    return panels.map(hydratePanelHandle);
  },
  async roots() {
    const panels = await panelCall<PanelListItem[]>("roots", []);
    return panels.map(hydratePanelHandle);
  },
  async children(id: string) {
    const children = await panelCall<PanelListItem[]>("list", [id]);
    return children.map(hydratePanelHandle);
  },
  parent(id: string) {
    const parentId =
      _selfId && id === _selfId
        ? (_parentId ?? metadataCache.get(id)?.parentId)
        : metadataCache.get(id)?.parentId;
    return parentId ? getPanelHandle(parentId) : null;
  },
  async open(source, options) {
    const parentId = options?.parentId ?? _selfId;
    const result = await panelCall<{
      id: string;
      title: string;
      kind: "workspace" | "browser";
      runtimeEntityId?: string | null;
      effectiveVersion?: string | null;
    }>("create", [source, { ...options, parentId }]);
    const handle = hydratePanelHandle({
      panelId: result.id,
      title: result.title,
      source: result.kind === "browser" ? `browser:${source}` : source,
      kind: result.kind,
      parentId,
      contextId: "",
      runtimeEntityId: result.runtimeEntityId ?? result.id,
      effectiveVersion: result.effectiveVersion ?? null,
    });
    currentJournal()?.append({ type: "open", source, id: handle.id, kind: handle.kind });
    return handle;
  },
};

async function flattenPanels(items: PanelListItem[]): Promise<PanelListItem[]> {
  const out: PanelListItem[] = [];
  const visit = (item: PanelListItem & { children?: PanelListItem[] }) => {
    out.push(item);
    for (const child of item.children ?? []) visit(child);
  };
  for (const item of items as Array<PanelListItem & { children?: PanelListItem[] }>) visit(item);
  return out;
}
