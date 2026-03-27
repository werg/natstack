/**
 * Panel runtime factory — extends createBaseRuntime with panel-specific features.
 *
 * Adds: stateArgs bridge, parent handles, panel lifecycle methods.
 */

import type { RpcTransport } from "@natstack/rpc";
import { createBaseRuntime, type BaseRuntimeDeps } from "./createBaseRuntime.js";
import {
  noopParent,
  type PanelContract,
  type EndpointInfo,
  type GitConfig,
  type PubSubConfig,
  type Rpc,
} from "../core/index.js";
import { createParentHandle, createParentHandleFromContract } from "../shared/handles.js";
import type { ParentHandle, ParentHandleFromContract } from "../core/index.js";
import type { RuntimeFs, ThemeAppearance } from "../types.js";
import { _initStateArgsBridge } from "../panel/stateArgs.js";

export interface RuntimeDeps {
  selfId: string;
  createTransport: () => RpcTransport;
  id: string;
  contextId: string;
  parentId: string | null;
  initialTheme: ThemeAppearance;
  fs: RuntimeFs;
  setupGlobals?: () => void;
  gitConfig?: GitConfig | null;
  pubsubConfig?: PubSubConfig | null;
}

export function createRuntime(deps: RuntimeDeps) {
  const base = createBaseRuntime(deps);

  // Initialize the stateArgs bridge for setStateArgs() function
  _initStateArgsBridge((updates) => base.callMain<Record<string, unknown>>("bridge.setStateArgs", updates));

  const parentHandleOrNull = deps.parentId ? createParentHandle({ rpc: base.rpc, parentId: deps.parentId }) : null;
  const parent: ParentHandle = parentHandleOrNull ?? noopParent;

  const getParent = <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
    EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(): ParentHandle<T, E, EmitE> | null => {
    return parentHandleOrNull as ParentHandle<T, E, EmitE> | null;
  };

  const getParentWithContract = <C extends PanelContract>(contract: C): ParentHandleFromContract<C> | null => {
    return createParentHandleFromContract(getParent(), contract);
  };

  const electron = (globalThis as any).__natstackElectron;

  return {
    id: base.id,
    parentId: deps.parentId,

    rpc: base.rpc,
    db: base.db,
    fs: base.fs,
    workers: base.workers,

    parent,
    getParent,
    getParentWithContract,

    onConnectionError: base.onConnectionError,

    getInfo: () => base.callMain<EndpointInfo>("bridge.getInfo"),
    closeSelf: () => {
      if (electron) return electron.closeSelf();
      return base.callMain<void>("bridge.closeSelf");
    },
    focusPanel: (panelId: string) => {
      if (electron) return electron.focusPanel(panelId);
      return base.callMain<void>("bridge.focusPanel", panelId);
    },
    getWorkspaceTree: base.getWorkspaceTree,
    listBranches: base.listBranches,
    listCommits: base.listCommits,

    getTheme: base.getTheme,
    onThemeChange: base.onThemeChange,

    onFocus: base.onFocus,

    exposeMethod: base.exposeMethod,

    gitConfig: base.gitConfig,
    pubsubConfig: base.pubsubConfig,
    contextId: base.contextId,
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
