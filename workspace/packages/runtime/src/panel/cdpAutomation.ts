import type { RpcClient } from "@natstack/rpc";
import type {
  CdpAutomation,
  CdpEndpoint,
  PanelConsoleHistoryOptions,
  PanelConsoleHistoryResult,
} from "../core/index.js";

export type { CdpAutomation, CdpEndpoint };

type PlaywrightClientModule = {
  BrowserImpl: { connect(ws: string, opts: object): Promise<any> };
};

const LIGHTWEIGHT_CDP_MODULE = "@workspace/playwright-client";

function isPlaywrightClientModule(value: unknown): value is PlaywrightClientModule {
  return Boolean((value as PlaywrightClientModule | undefined)?.BrowserImpl?.connect);
}

async function loadLightweightClient(): Promise<PlaywrightClientModule> {
  const loadErrors: string[] = [];
  const rememberLoadError = (source: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    loadErrors.push(`${source}: ${message}`);
  };
  const runtimeRequire = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
    | ((id: string) => unknown)
    | undefined;
  if (runtimeRequire) {
    try {
      const loaded = runtimeRequire(LIGHTWEIGHT_CDP_MODULE);
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch (error) {
      rememberLoadError("__natstackRequire__", error);
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
      const loaded = await runtimeLoadImport(LIGHTWEIGHT_CDP_MODULE, "latest");
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch (error) {
      rememberLoadError("__natstackLoadImport__", error);
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
      const loaded = await runtimeRequireAsync(LIGHTWEIGHT_CDP_MODULE);
      if (isPlaywrightClientModule(loaded)) return loaded;
    } catch (error) {
      rememberLoadError("__natstackRequireAsync__", error);
      // Fall through to dynamic import for non-runtime test/node environments.
    }
  }
  const dynamicImport = new Function("id", "return import(id)") as (
    id: string
  ) => Promise<PlaywrightClientModule>;
  try {
    const loaded = await dynamicImport(LIGHTWEIGHT_CDP_MODULE);
    if (isPlaywrightClientModule(loaded)) return loaded;
  } catch (error) {
    rememberLoadError("dynamic import", error);
    // Throw the clearer message below.
  }
  throw new Error(
    `Unable to load ${LIGHTWEIGHT_CDP_MODULE} for CDP automation. ` +
      `Call handle.cdp.lightweightPage() only from contexts that expose @workspace/playwright-client.` +
      (loadErrors.length ? ` Last load error: ${loadErrors[loadErrors.length - 1]}` : "")
  );
}

export function createCdpAutomation(rpc: Pick<RpcClient, "call">, id: string): CdpAutomation {
  const getCdpEndpoint = async (): Promise<CdpEndpoint> => {
    return rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [id]);
  };

  const connectPage = async (): Promise<any> => {
    const { BrowserImpl } = await loadLightweightClient();
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
    lightweightPage: connectPage,
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
      const p = await connectPage();
      await p.click(selector);
    },
    screenshot: async (options) => {
      const p = await connectPage();
      return p.screenshot(options);
    },
  };
}
