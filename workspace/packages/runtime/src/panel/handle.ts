import type { RpcBridge } from "@natstack/rpc";
import type { OpenExternalOptions, OpenExternalResult } from "@natstack/shared/externalOpen";
import { createBrowserAutomation, type BrowserAutomation } from "./browserAutomation.js";
import { currentJournal } from "./journal.js";

export interface PanelListItem {
  panelId: string;
  title: string;
  source: string;
  kind: "workspace" | "browser";
  parentId: string | null;
  contextId: string;
}

export interface PanelHandle {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly kind: "workspace" | "browser";
  readonly parentId: string | null;
  readonly browser: BrowserAutomation;
  readonly stateArgs: {
    get<T = Record<string, unknown>>(): Promise<T>;
    set(updates: Record<string, unknown>): Promise<void>;
  };
  children(): Promise<PanelHandle[]>;
  reload(): Promise<void>;
  close(): Promise<void>;
  snapshot(): Promise<unknown>;
  tree(): Promise<unknown>;
  state(): Promise<unknown>;
  routes(): Promise<unknown>;
  setMode(mode: "fixture" | "live"): Promise<unknown>;
}

let _rpc: RpcBridge | null = null;
const shell = (globalThis as any).__natstackShell ?? (globalThis as any).__natstackElectron;

export function _initPanelHandleBridge(rpc: RpcBridge): void {
  _rpc = rpc;
}

function getRpc(): RpcBridge {
  if (!_rpc) throw new Error("Panel bridge not initialized");
  return _rpc;
}

function stripBrowserPrefix(source: string): string {
  return source.startsWith("browser:") ? source.slice("browser:".length) : source;
}

async function panelCall<T>(method: string, args: unknown[]): Promise<T> {
  if (shell?.panel?.[method]) return shell.panel[method](...args) as Promise<T>;
  throw new Error(`Panel method "${method}" requires a host shell bridge`);
}

export function hydratePanelHandle(item: PanelListItem): PanelHandle {
  const rpc = getRpc();
  const id = item.panelId;
  const kind = item.kind ?? (item.source.startsWith("browser:") ? "browser" : "workspace");
  const source = stripBrowserPrefix(item.source);
  const handle: PanelHandle = {
    id,
    title: item.title,
    source,
    kind,
    parentId: item.parentId,
    browser: createBrowserAutomation(rpc, shell, id, kind),
    stateArgs: {
      get: async <T = Record<string, unknown>>() => panelCall<T>("getStateArgs", [id]),
      set: async (updates) => {
        await panelCall("setStateArgs", [id, updates]);
        currentJournal()?.append({ type: "stateArgs.set", id });
      },
    },
    children: async () => {
      const children = await panelCall<PanelListItem[]>("list", [id]);
      return children.map(hydratePanelHandle);
    },
    reload: async () => {
      await panelCall("reload", [id]);
      currentJournal()?.append({ type: "reload", id });
    },
    close: async () => {
      await panelCall("close", [id]);
      currentJournal()?.append({ type: "close", id });
    },
    snapshot: () => panelCall("snapshot", [id]),
    tree: () => panelCall("callAgent", [id, "_agent.tree", []]),
    state: () => panelCall("callAgent", [id, "_agent.state", []]),
    routes: () => panelCall("callAgent", [id, "_agent.routes", []]),
    setMode: (mode) => panelCall("callAgent", [id, "_agent.setMode", [mode]]),
  };
  return handle;
}

export async function openPanel(
  source: string,
  options?: { name?: string; focus?: boolean; stateArgs?: Record<string, unknown> }
): Promise<PanelHandle> {
  const result = await panelCall<{ id: string; title: string; kind: "workspace" | "browser" }>(
    "create",
    [source, options]
  );
  const handle = hydratePanelHandle({
    panelId: result.id,
    title: result.title,
    source: result.kind === "browser" ? `browser:${source}` : source,
    kind: result.kind,
    parentId: null,
    contextId: "",
  });
  currentJournal()?.append({ type: "open", source, id: handle.id, kind: handle.kind });
  return handle;
}

export async function listPanels(): Promise<PanelHandle[]> {
  const panels = await panelCall<PanelListItem[]>("list", [null]);
  return panels.map(hydratePanelHandle);
}

export async function openExternal(
  url: string,
  options?: OpenExternalOptions
): Promise<OpenExternalResult> {
  return getRpc().call<OpenExternalResult>("main", "externalOpen.openExternal", [url, options]);
}

export function onChildCreated(handler: (info: { childId: string; url: string }) => void): () => void {
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
    rpc.onEvent("runtime:child-created", (_fromId, payload) => {
      const data = payload as { childId?: string; url?: string } | null;
      if (data?.childId && data?.url) handler({ childId: data.childId, url: data.url });
    })
  );
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

export function getPanelHandle(id: string, kind: "workspace" | "browser" = "workspace"): PanelHandle {
  return hydratePanelHandle({ panelId: id, title: id, source: kind === "browser" ? `browser:${id}` : id, kind, parentId: null, contextId: "" });
}
