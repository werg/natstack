import type { RpcClient, RpcEventContext } from "@natstack/rpc";
import type { PanelHandle as CorePanelHandle, Rpc } from "../core/index.js";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import {
  createPanelRuntime,
  type OpenPanelOptions,
  type PanelRuntimeApi,
  type PanelRuntimeTree,
} from "../shared/panelRuntime.js";
import { currentJournal } from "./journal.js";

export type PanelHandle<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
> = CorePanelHandle<T, E, EmitE>;

export type PanelTreeApi = PanelRuntimeTree;

type PanelRuntimeRpc = Pick<RpcClient, "call" | "emit" | "on">;

let _rpc: PanelRuntimeRpc | null = null;
let _runtime: PanelRuntimeApi | null = null;
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
  _runtime = createPanelRuntime({
    rpc,
    selfId: options.selfId ?? null,
    selfRpcTargetId: options.selfRpcTargetId ?? options.selfId ?? null,
    parentId: options.parentId ?? null,
    effectiveVersion: options.effectiveVersion ?? null,
    defaultOpenParentId: options.selfId ?? null,
    requesterPanelId: options.selfId ?? null,
    initialMetadata: [
      ...(options.selfId
        ? [
            {
              id: options.selfId,
              title: options.selfId,
              source: options.selfId,
              kind: "workspace" as const,
              parentId: options.parentId ?? null,
              rpcTargetId: options.selfRpcTargetId ?? options.selfId,
              effectiveVersion: options.effectiveVersion ?? null,
            },
          ]
        : []),
      ...(options.parentId
        ? [
            {
              id: options.parentId,
              title: options.parentId,
              source: options.parentId,
              kind: "workspace" as const,
              parentId: null,
              rpcTargetId: options.parentRpcTargetId ?? options.parentId,
            },
          ]
        : []),
    ],
    onOpen: (entry) => currentJournal()?.append({ type: "open", ...entry }),
    onReload: (id) => currentJournal()?.append({ type: "reload", id }),
    onClose: (id) => currentJournal()?.append({ type: "close", id }),
    onStateArgsSet: (id) => currentJournal()?.append({ type: "stateArgs.set", id }),
  });
}

function getRpc(): PanelRuntimeRpc {
  if (!_rpc) throw new Error("Panel bridge not initialized");
  return _rpc;
}

function getRuntime(): PanelRuntimeApi {
  if (!_runtime) throw new Error("Panel bridge not initialized");
  return _runtime;
}

export async function openPanel(
  source: string,
  options?: OpenPanelOptions
): Promise<PanelHandle> {
  return getRuntime().openPanel(source, options);
}

export async function listPanels(): Promise<PanelHandle[]> {
  return getRuntime().listPanels();
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
  return getRuntime().getPanelHandle(id, kind);
}

export const panelTree: PanelTreeApi = {
  self: () => getRuntime().panelTree.self(),
  get: (id, kind) => getRuntime().panelTree.get(id, kind),
  list: () => getRuntime().panelTree.list(),
  roots: () => getRuntime().panelTree.roots(),
  children: (id) => getRuntime().panelTree.children(id),
  parent: (id) => getRuntime().panelTree.parent(id),
  navigate: (id, source, options) => getRuntime().panelTree.navigate(id, source, options),
};
