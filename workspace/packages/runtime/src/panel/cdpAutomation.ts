import type { RpcClient } from "@natstack/rpc";
import type {
  CdpAutomation,
  CdpClientKind,
  CdpEndpoint,
  PanelConsoleHistoryOptions,
  PanelConsoleHistoryResult,
} from "../core/index.js";

export type { CdpAutomation, CdpEndpoint };

type PlaywrightClientModule = {
  BrowserImpl: { connect(ws: string, opts: object): Promise<any> };
};

const CDP_CLIENT_MODULES: Record<CdpClientKind, string> = {
  playwright: "@workspace/playwright-core",
  lightweight: "@workspace/playwright-client",
};

function isPlaywrightClientModule(value: unknown): value is PlaywrightClientModule {
  return Boolean((value as PlaywrightClientModule | undefined)?.BrowserImpl?.connect);
}

async function loadPlaywrightClient(client: CdpClientKind): Promise<PlaywrightClientModule> {
  const moduleId = CDP_CLIENT_MODULES[client];
  const runtimeRequire = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
    | ((id: string) => unknown)
    | undefined;
  if (runtimeRequire) {
    try {
      const loaded = runtimeRequire(moduleId);
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch {
      // Panels can lazily import npm packages via __natstackRequireAsync__ below.
      // Workers only have the sync module map, so a missing map entry should
      // fall through to the clearest environment-specific loader/error.
    }
  }
  const runtimeLoadImport = (globalThis as Record<string, unknown>)["__natstackLoadImport__"] as
    | ((id: string, ref?: string) => Promise<unknown>)
    | undefined;
  if (runtimeLoadImport) {
    try {
      const loaded = await runtimeLoadImport(moduleId, "latest");
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch {
      // Fall through to the legacy async loader/dynamic import paths.
    }
  }
  const runtimeRequireAsync = (globalThis as Record<string, unknown>)[
    "__natstackRequireAsync__"
  ] as
    | ((id: string) => Promise<unknown>)
    | undefined;
  if (runtimeRequireAsync) {
    try {
      const loaded = await runtimeRequireAsync(moduleId);
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch {
      // Fall through to dynamic import for non-runtime test/node environments.
    }
  }
  const dynamicImport = new Function("id", "return import(id)") as (
    id: string
  ) => Promise<PlaywrightClientModule>;
  try {
    const loaded = await dynamicImport(moduleId);
    if (isPlaywrightClientModule(loaded)) return loaded;
  } catch {
    // Throw the clearer message below.
  }
  throw new Error(
    `Unable to load ${moduleId} for CDP automation. ` +
      (client === "playwright"
        ? `Call handle.cdp.playwrightPage() only from contexts that expose @workspace/playwright-core.`
        : `Call handle.cdp.lightweightPage() only from contexts that expose @workspace/playwright-client.`)
  );
}

export function createCdpAutomation(rpc: Pick<RpcClient, "call">, id: string): CdpAutomation {
  const getCdpEndpoint = async (): Promise<CdpEndpoint> => {
    return rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [id]);
  };

  const connectPage = async (client: CdpClientKind): Promise<any> => {
    const { BrowserImpl } = await loadPlaywrightClient(client);
    const endpoint = await getCdpEndpoint();
    const connectOptions: { isElectronWebview: boolean; transportOptions?: { authToken: string } } = {
      isElectronWebview: true,
    };
    if (endpoint.token) connectOptions.transportOptions = { authToken: endpoint.token };
    const browser = await BrowserImpl.connect(endpoint.wsEndpoint, connectOptions);
    const resolvedPage = browser.contexts()[0]?.pages()[0];
    if (!resolvedPage) throw new Error("No page found in panel CDP target");
    return resolvedPage;
  };

  return {
    playwrightPage: () => connectPage("playwright"),
    lightweightPage: () => connectPage("lightweight"),
    consoleHistory: (options?: PanelConsoleHistoryOptions) => {
      return rpc.call<PanelConsoleHistoryResult>("main", "panelCdp.consoleHistory", [id, options]);
    },
    getCdpEndpoint,
    navigate: (url) => {
      return rpc.call<void>("main", "panelCdp.navigate", [id, url]);
    },
    goBack: () => {
      return rpc.call<void>("main", "panelCdp.goBack", [id]);
    },
    goForward: () => {
      return rpc.call<void>("main", "panelCdp.goForward", [id]);
    },
    reload: () => {
      return rpc.call<void>("main", "panelCdp.reload", [id]);
    },
    stop: () => {
      return rpc.call<void>("main", "panelCdp.stop", [id]);
    },
    click: async (selector) => {
      const p = await connectPage("playwright");
      await p.click(selector);
    },
    screenshot: async (options) => {
      const p = await connectPage("playwright");
      return p.screenshot(options);
    },
  };
}
